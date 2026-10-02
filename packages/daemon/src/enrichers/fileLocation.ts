import { lstat, open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type CanonicalEvent,
  type CanonicalEventOf,
  makeEventId,
  type StoredEvent,
} from '@salidium/protocol';
import type { Logger } from '../logging/logger.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';

export type FileRepository = NonNullable<
  CanonicalEventOf<'file.located'>['files'][number]['repository']
>;

/** Directories walked upward from a changed path before giving up. */
const MAX_DEPTH = 64;
/** Bytes read from a `.git` file or a `commondir` file. Both hold one short line. */
const MAX_POINTER_BYTES = 1024;
/** Directories whose answer is remembered, and for how long. */
const CACHE_ENTRIES = 4096;
const CACHE_MS = 60_000;
/** Paths located per session, sessions remembered, and files per event. */
const PATHS_PER_SESSION = 2000;
const SESSIONS = 64;
const FILES_PER_EVENT = 64;

/** What the nearest `.git` says about the directory that holds a path. */
type TreeAnswer = { root: string; mainRoot?: string } | null;

/**
 * Finds the Git working tree that holds a path, by reading the filesystem only: no git process,
 * no repository configuration, and never the contents of the changed file or anything else in the
 * tree. Agents often write in a worktree outside the directory their session started in, so the
 * session's own repository says nothing about where a given file lives.
 *
 * The rules, each of which ends in `null` rather than a guess:
 *
 * - The path must be absolute. Its nearest existing ancestor is resolved with realpath, so a
 *   symlinked directory is located where it really is, and the walk is bounded in depth.
 * - The first `.git` met decides. A directory counts only if it has a `HEAD` file. A file counts
 *   only if its first line is `gitdir: <dir>` and that directory exists and has `HEAD`; when the
 *   target holds `commondir`, the tree is a linked worktree and its repository is the directory
 *   `commondir` names, again only if it exists and has `HEAD`. A symlinked `.git` is not followed.
 *   Nothing else in the git directory is read, and each of the two pointer files is read only up
 *   to a small bound.
 * - Nothing under another user's home directory is reported, whether the changed path or a
 *   pointer leads there.
 */
export class RepositoryLocator {
  private readonly cache = new Map<string, { answer: TreeAnswer; at: number }>();
  private readonly home: string;
  private readonly now: () => number;

  constructor(options: { home?: string; now?: () => number } = {}) {
    this.home = resolve(options.home ?? homedir());
    this.now = options.now ?? Date.now;
  }

  async locate(path: string): Promise<FileRepository | null> {
    if (!isAbsolute(path)) return null;
    const target = resolve(path);
    const existing = await nearestExisting(dirname(target));
    if (!existing) return null;
    const missing = relative(existing.given, dirname(target));
    const realDir = existing.real;
    if (this.foreignHome(realDir)) return null;
    const tree = await this.treeOf(realDir);
    if (!tree) return null;
    const relativePath = relative(tree.root, join(realDir, missing, basename(target)));
    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath))
      return null;
    return {
      root: tree.root,
      path: relativePath.split(sep).join('/'),
      ...(tree.mainRoot ? { mainRoot: tree.mainRoot } : {}),
    };
  }

  /** True for a path inside some other user's home directory, which is never Salidium's to read. */
  private foreignHome(path: string): boolean {
    const users = dirname(this.home);
    if (users === dirname(users)) return false; // a home directly under the root has no siblings
    return within(path, users) && !within(path, this.home);
  }

  private async treeOf(realDir: string): Promise<TreeAnswer> {
    const visited: string[] = [];
    let dir = realDir;
    let answer: TreeAnswer = null;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const cached = this.cache.get(dir);
      if (cached && this.now() - cached.at < CACHE_MS) {
        answer = cached.answer;
        break;
      }
      visited.push(dir);
      const found = await this.gitAt(dir);
      if (found !== undefined) {
        answer = found;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const visitedDir of visited) this.remember(visitedDir, answer);
    return answer;
  }

  /** The answer `.git` in `dir` gives, or undefined when there is no `.git` there at all. */
  private async gitAt(dir: string): Promise<TreeAnswer | undefined> {
    const dotGit = join(dir, '.git');
    let kind: 'directory' | 'file' | 'other';
    try {
      const info = await lstat(dotGit);
      kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
    } catch {
      return undefined;
    }
    if (kind === 'other') return null;
    if (kind === 'directory') return (await isGitDir(dotGit)) ? { root: dir } : null;
    const gitDir = await this.pointer(dotGit, dir, /^gitdir: (.+)$/);
    if (!gitDir) return null;
    const common = join(gitDir, 'commondir');
    let commonExists = false;
    try {
      commonExists = (await stat(common)).isFile();
    } catch {
      commonExists = false;
    }
    if (!commonExists) return { root: dir }; // a submodule or a separated git dir: its own tree
    const commonDir = await this.pointer(common, gitDir, /^(.+)$/);
    if (!commonDir) return null;
    const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
    if (mainRoot === dir) return { root: dir };
    if (this.foreignHome(mainRoot) || !(await isDirectory(mainRoot))) return null;
    return { root: dir, mainRoot };
  }

  /** The git directory a one-line pointer file names, resolved and checked, or null. */
  private async pointer(file: string, base: string, line: RegExp): Promise<string | null> {
    const text = await readBounded(file);
    const first = text?.split('\n')[0]?.replace(/\r$/, '').trim();
    const named = first ? line.exec(first)?.[1]?.trim() : undefined;
    if (!named) return null;
    let real: string;
    try {
      real = await realpath(resolve(base, named));
    } catch {
      return null;
    }
    if (this.foreignHome(real)) return null;
    return (await isGitDir(real)) ? real : null;
  }

  private remember(dir: string, answer: TreeAnswer): void {
    if (this.cache.size >= CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(dir);
    this.cache.set(dir, { answer, at: this.now() });
  }
}

/**
 * Emits `file.located` for paths a live session changed, so a reader can tell which repository
 * holds each changed file and where in it, as observed when the change happened. Like git
 * snapshots it never runs for history imports, and it runs only when git observation is enabled.
 * A path is reported again only when its answer changes, and work per session is bounded.
 */
export class FileLocationEnricher {
  private readonly registry: SessionRegistry;
  private readonly log: Logger;
  private readonly locator: RepositoryLocator;
  private readonly now: () => number;
  private readonly reported = new Map<string, Map<string, string>>();
  private unsubscribe: (() => void) | undefined;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    registry: SessionRegistry,
    log: Logger,
    options: { locator?: RepositoryLocator; now?: () => number } = {},
  ) {
    this.registry = registry;
    this.log = log;
    this.now = options.now ?? Date.now;
    this.locator = options.locator ?? new RepositoryLocator({ now: this.now });
  }

  start(): void {
    this.unsubscribe = this.registry.subscribeAll((sessionId, events) => {
      const changed = events.filter(
        (e): e is StoredEvent & { kind: 'tool.completed' } =>
          e.kind === 'tool.completed' && e.result.kind === 'fileChanges',
      );
      const last = changed.at(-1);
      if (!last) return;
      const age = this.now() - Date.parse(last.ts);
      if (Number.isNaN(age) || age > 120_000) return; // not live
      const paths = new Set<string>();
      for (const e of changed)
        if (e.result.kind === 'fileChanges')
          for (const change of e.result.changes) if (change.applied) paths.add(change.path);
      const work = this.locate(sessionId, last, [...paths]);
      this.idle = this.idle.then(() => work);
    });
  }

  /** Resolves once every location started so far has been emitted. For tests. */
  settled(): Promise<void> {
    return this.idle;
  }

  stop(): void {
    this.unsubscribe?.();
  }

  private async locate(sessionId: string, trigger: StoredEvent, paths: string[]): Promise<void> {
    try {
      const known = this.sessionMemory(sessionId);
      const files: CanonicalEventOf<'file.located'>['files'] = [];
      for (const path of paths) {
        if (!known.has(path) && known.size >= PATHS_PER_SESSION) continue;
        const repository = await this.locator.locate(path);
        const key = JSON.stringify(repository);
        if (known.get(path) === key) continue;
        known.set(path, key);
        files.push({ path, repository });
      }
      for (let i = 0; i < files.length; i += FILES_PER_EVENT) {
        const event: CanonicalEvent = {
          id: makeEventId(sessionId, 'located', trigger.seq, i / FILES_PER_EVENT),
          sessionId,
          ts: new Date(this.now()).toISOString(),
          tsSource: 'ingest',
          turnId: trigger.turnId,
          agentId: trigger.agentId,
          source: { provider: trigger.source.provider, channel: 'salidium' },
          kind: 'file.located',
          files: files.slice(i, i + FILES_PER_EVENT),
        };
        this.registry.ingest(sessionId, [event]);
      }
    } catch (err) {
      this.log.debug('file location skipped', { sessionId, err: String(err) });
    }
  }

  private sessionMemory(sessionId: string): Map<string, string> {
    let known = this.reported.get(sessionId);
    if (known) {
      this.reported.delete(sessionId);
      this.reported.set(sessionId, known);
      return known;
    }
    if (this.reported.size >= SESSIONS) {
      const oldest = this.reported.keys().next().value;
      if (oldest !== undefined) this.reported.delete(oldest);
    }
    known = new Map();
    this.reported.set(sessionId, known);
    return known;
  }
}

async function nearestExisting(dir: string): Promise<{ given: string; real: string } | null> {
  let current = dir;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    try {
      return { given: current, real: await realpath(current) };
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

async function isGitDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory() && (await stat(join(dir, 'HEAD'))).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function readBounded(file: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(MAX_POINTER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_POINTER_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function within(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
