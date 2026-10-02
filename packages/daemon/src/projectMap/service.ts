import { join } from 'node:path';
import { resolveTrustedExecutable, trustedPathEntries } from '@salidium/adapter-kit';
import {
  type CommitExistsResult,
  type MapRefusal,
  type MapResult,
  ObjectIdSchema,
  type OptedInRepository,
  ProjectMapSchema,
  type ProjectMapService,
} from '@salidium/project-map';
import type { Logger } from '../logging/logger.ts';
import { DEFAULT_BOUNDS, type MapBounds, MapOverBound } from './build.ts';
import { ProjectMapCache } from './cache.ts';
import {
  GitObjectReader,
  GitReadError,
  locateObjectStore,
  type ObjectStore,
} from './gitObjects.ts';
import { OptInVerifier } from './optIn.ts';
import { mapFromObjectStore } from './source.ts';

/** Builds one at a time; a request arriving while this many wait is told to retry. */
export const MAX_QUEUED_BUILDS = 4;
/** Builds started per minute, cached answers excluded. */
export const MAX_BUILDS_PER_MINUTE = 12;

export interface ProjectMapServiceOptions {
  home: string;
  log?: Logger;
  bounds?: MapBounds;
  now?: () => number;
  /** Resolves the git executable and the PATH its child sees. Tests may supply their own. */
  git?: (root: string) => { command: string; path: string } | undefined;
  maxBuildsPerMinute?: number;
}

const refusal = (
  error: MapRefusal['error'],
  message: string,
  bound: MapRefusal['bound'] = null,
): { ok: false; refusal: MapRefusal } => ({
  ok: false,
  refusal: { error, message: message.slice(0, 300), bound },
});

const NOT_OPTED_IN = () =>
  refusal(
    'not-opted-in',
    'this repository is not opted in to project maps; the person can allow it with `salidium map allow <repository>`',
  );

/** Git resolved the way the daemon resolves every executable it runs: trusted PATH entries only. */
export function trustedGit(root: string): { command: string; path: string } | undefined {
  const trust = { environment: process.env, untrustedRoots: [process.cwd(), root] };
  const command = resolveTrustedExecutable('git', trust);
  if (!command) return undefined;
  return {
    command,
    path: trustedPathEntries(trust).join(process.platform === 'win32' ? ';' : ':'),
  };
}

/**
 * The daemon's `ProjectMapService`. Every call checks the opt-in file first and reads nothing under
 * a root that is not opted in. Repository roots in requests are compared as exact strings with the
 * opted-in main roots and are never resolved on the file system, so a request cannot steer a read
 * through a symbolic link or a worktree it names.
 */
export class DaemonProjectMapService implements ProjectMapService {
  private readonly optIn: OptInVerifier;
  private readonly cache: ProjectMapCache;
  private readonly scratch: string;
  private readonly bounds: MapBounds;
  private readonly now: () => number;
  private readonly git: (root: string) => { command: string; path: string } | undefined;
  private readonly log: Logger | undefined;
  private readonly maxBuildsPerMinute: number;
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private readonly started: number[] = [];
  private readonly inFlight = new Map<string, Promise<MapResult>>();

  constructor(options: ProjectMapServiceOptions) {
    this.optIn = new OptInVerifier(options.home, (reason) => options.log?.warn(reason));
    this.cache = new ProjectMapCache(options.home);
    this.scratch = join(options.home, 'project-map', 'scratch');
    this.bounds = options.bounds ?? DEFAULT_BOUNDS;
    this.now = options.now ?? Date.now;
    this.git = options.git ?? trustedGit;
    this.log = options.log;
    this.maxBuildsPerMinute = options.maxBuildsPerMinute ?? MAX_BUILDS_PER_MINUTE;
  }

  isOptedIn(mainRoot: string): boolean {
    return this.optIn.get(mainRoot) !== undefined;
  }

  repositories(): OptedInRepository[] {
    return this.optIn.list();
  }

  async commitExists(mainRoot: string, commit: string): Promise<CommitExistsResult> {
    if (!ObjectIdSchema.safeParse(commit).success)
      return refusal('bad-request', 'commit must be a full 40- or 64-hex object id');
    if (!this.optIn.get(mainRoot)) return NOT_OPTED_IN();
    return this.serialized(async () => {
      const opened = await this.open(mainRoot, commit);
      if (!opened.ok)
        return opened.refusal.error === 'commit-unknown' ? { ok: true, exists: false } : opened;
      try {
        const header = (await opened.reader.check([commit])).get(commit);
        return { ok: true, exists: header?.type === 'commit' };
      } catch (error) {
        return this.refuseError(error);
      }
    });
  }

  async getMap(mainRoot: string, commit: string): Promise<MapResult> {
    if (!ObjectIdSchema.safeParse(commit).success)
      return refusal('bad-request', 'commit must be a full 40- or 64-hex object id');
    const repository = this.optIn.get(mainRoot);
    if (!repository) return NOT_OPTED_IN();
    const cached = this.cache.get(repository, commit);
    if (cached) return { ok: true, map: cached };
    const key = `${mainRoot}\0${commit}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const at = this.now();
    while (this.started.length > 0 && at - (this.started[0] ?? 0) > 60_000) this.started.shift();
    if (this.started.length >= this.maxBuildsPerMinute)
      return refusal('busy', 'too many maps were built in the last minute; retry shortly');
    if (this.queued >= MAX_QUEUED_BUILDS)
      return refusal('busy', 'other maps are being built; retry shortly');
    this.started.push(at);
    const build = this.serialized(() => this.build(repository, commit)).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, build);
    return build;
  }

  /** Runs work after everything queued before it, one at a time. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const next = this.queue.then(work, work).finally(() => {
      this.queued -= 1;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async open(
    mainRoot: string,
    commit: string,
  ): Promise<{ ok: true; reader: GitObjectReader } | { ok: false; refusal: MapRefusal }> {
    let store: ObjectStore;
    try {
      store = await locateObjectStore(mainRoot);
    } catch (error) {
      return this.refuseError(error);
    }
    // A SHA-1 store has no 64-hex objects and a SHA-256 store no 40-hex ones.
    if ((commit.length === 64) !== (store.format === 'sha256'))
      return refusal('commit-unknown', 'the repository has no commit with that id');
    const git = this.git(mainRoot);
    if (!git)
      return refusal('repository-unsupported', 'no trusted git executable was found on PATH');
    return {
      ok: true,
      reader: new GitObjectReader({
        store,
        scratch: this.scratch,
        git: git.command,
        path: git.path,
      }),
    };
  }

  private async build(repository: OptedInRepository, commit: string): Promise<MapResult> {
    // The opt-in may have been revoked while this build waited its turn.
    if (!this.optIn.get(repository.root)) return NOT_OPTED_IN();
    const opened = await this.open(repository.root, commit);
    if (!opened.ok) return opened;
    const started = this.now();
    try {
      const map = await mapFromObjectStore({
        reader: opened.reader,
        root: repository.root,
        commit,
        bounds: this.bounds,
        now: this.now,
      });
      if (!map) return refusal('commit-unknown', 'the repository has no commit with that id');
      const checked = ProjectMapSchema.parse(map);
      const current = this.optIn.get(repository.root);
      if (!current || current.allowedAt !== repository.allowedAt) return NOT_OPTED_IN();
      this.cache.set(repository, checked, this.optIn.list());
      this.log?.info('project map built', {
        files: checked.coverage.files,
        edges: checked.edges.length,
        ms: this.now() - started,
      });
      return { ok: true, map: checked };
    } catch (error) {
      return this.refuseError(error);
    }
  }

  private refuseError(error: unknown): { ok: false; refusal: MapRefusal } {
    if (error instanceof MapOverBound) return refusal('over-bound', error.message, error.bound);
    if (error instanceof GitReadError) {
      if (error.code === 'over-bound') return refusal('over-bound', error.message);
      if (error.code === 'timeout') return refusal('over-bound', error.message);
      if (error.code === 'unsupported') return refusal('repository-unsupported', error.message);
      return refusal('repository-unsupported', 'the repository could not be read');
    }
    throw error;
  }
}
