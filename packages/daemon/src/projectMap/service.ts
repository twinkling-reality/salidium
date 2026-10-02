import { join } from 'node:path';
import { resolveTrustedExecutable, trustedPathEntries } from '@salidium/adapter-kit';
import {
  type CommitExistsResult,
  type MapRefusal,
  type MapResult,
  ObjectIdSchema,
  type OptedInRepository,
  type ProjectMap,
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
import { OptInVerifier, type StoredRepository } from './optIn.ts';
import { mapFromObjectStore } from './source.ts';

/** Builds one at a time; a request arriving while this many wait is told to retry. */
export const MAX_QUEUED_BUILDS = 4;
/** Builds and disk-cache reads started per minute; maps already in memory are not counted. */
export const MAX_BUILDS_PER_MINUTE = 12;
/** Recently served maps kept parsed and serialized, so repeated requests cost nothing. */
const MEMORY_CACHE_BYTES = 64 * 1024 * 1024;

export type MapDocumentResult =
  | { ok: true; map: ProjectMap; text: string }
  | { ok: false; refusal: MapRefusal };

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
  private readonly inFlight = new Map<string, Promise<MapDocumentResult>>();
  private readonly memory = new Map<string, { map: ProjectMap; text: string; bytes: number }>();

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
    if (this.queued >= MAX_QUEUED_BUILDS)
      return refusal('busy', 'other repository reads are queued; retry shortly');
    return this.serialized(async () => {
      // Checked again inside the queue: the opt-in may have been revoked while this waited.
      const repository = this.optIn.get(mainRoot);
      if (!repository) return NOT_OPTED_IN();
      const opened = await this.open(repository, commit);
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
    const document = await this.getMapDocument(mainRoot, commit);
    return document.ok ? { ok: true, map: document.map } : document;
  }

  /**
   * The map and its serialized form. Maps served recently are kept in memory with their text, so a
   * repeated request neither re-reads the disk cache nor re-serializes; anything else (a disk-cache
   * read or a build) takes a turn in the queue and counts against the per-minute limit.
   */
  async getMapDocument(mainRoot: string, commit: string): Promise<MapDocumentResult> {
    if (!ObjectIdSchema.safeParse(commit).success)
      return refusal('bad-request', 'commit must be a full 40- or 64-hex object id');
    const repository = this.optIn.get(mainRoot);
    if (!repository) return NOT_OPTED_IN();
    const key = `${repository.root}\0${repository.allowedAt}\0${commit}`;
    const remembered = this.memory.get(key);
    if (remembered) {
      this.memory.delete(key);
      this.memory.set(key, remembered);
      return { ok: true, ...remembered };
    }
    const running = this.inFlight.get(key);
    if (running) return running;
    const at = this.now();
    while (this.started.length > 0 && at - (this.started[0] ?? 0) > 60_000) this.started.shift();
    if (this.started.length >= this.maxBuildsPerMinute)
      return refusal('busy', 'too many maps were read or built in the last minute; retry shortly');
    if (this.queued >= MAX_QUEUED_BUILDS)
      return refusal('busy', 'other maps are being built; retry shortly');
    this.started.push(at);
    const work = this.serialized(async (): Promise<MapDocumentResult> => {
      const cached =
        this.optIn.get(repository.root)?.allowedAt === repository.allowedAt
          ? this.cache.get(repository, commit)
          : undefined;
      const result = cached
        ? { ok: true as const, map: cached }
        : await this.build(repository, commit);
      return result.ok ? this.remember(key, result.map) : result;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private remember(key: string, map: ProjectMap): MapDocumentResult {
    const text = JSON.stringify(map);
    const bytes = Buffer.byteLength(text);
    if (bytes <= MEMORY_CACHE_BYTES / 4) {
      this.memory.set(key, { map, text, bytes });
      let total = 0;
      for (const [entryKey, entry] of [...this.memory].reverse()) {
        const [root, allowedAt] = entryKey.split('\0');
        total += entry.bytes;
        if (total > MEMORY_CACHE_BYTES || this.optIn.get(root ?? '')?.allowedAt !== allowedAt)
          this.memory.delete(entryKey);
      }
    }
    return { ok: true, map, text };
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
    repository: StoredRepository,
    commit: string,
  ): Promise<{ ok: true; reader: GitObjectReader } | { ok: false; refusal: MapRefusal }> {
    const mainRoot = repository.root;
    let store: ObjectStore;
    try {
      store = await locateObjectStore(mainRoot);
    } catch (error) {
      return this.refuseError(error);
    }
    if (store.gitDir !== repository.gitDir)
      return refusal(
        'repository-unsupported',
        'the repository now resolves to a different git directory than when it was allowed; allow it again with `salidium map allow <root>`',
      );
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

  private async build(repository: StoredRepository, commit: string): Promise<MapResult> {
    // The opt-in may have been revoked while this build waited its turn, or while it reads.
    const current = () => this.optIn.get(repository.root)?.allowedAt === repository.allowedAt;
    if (!current()) return NOT_OPTED_IN();
    const opened = await this.open(repository, commit);
    if (!opened.ok) return opened;
    const started = this.now();
    try {
      const map = await mapFromObjectStore({
        reader: opened.reader,
        root: repository.root,
        commit,
        bounds: this.bounds,
        now: this.now,
        current,
      });
      if (map === 'revoked') return NOT_OPTED_IN();
      if (!map) return refusal('commit-unknown', 'the repository has no commit with that id');
      const parsed = ProjectMapSchema.safeParse(map);
      if (!parsed.success) {
        // Only crafted content can get here: every producer path is bounded, so say so plainly.
        this.log?.warn('project map failed its own schema', {
          issue: parsed.error.issues[0]?.path,
        });
        return refusal(
          'repository-unsupported',
          'the repository holds content a map cannot represent',
        );
      }
      const checked = parsed.data;
      if (!current()) return NOT_OPTED_IN();
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
