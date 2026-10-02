import { constants, realpathSync } from 'node:fs';
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
 *   pointer leads there. Home is compared as given and as realpath resolves it, and the
 *   conventional roots of user homes count as well as home's own parent.
 * - Pointer files are opened without following a symlink and without blocking, and read only if
 *   the opened file is a regular file, so swapping one for a FIFO or a link between the check and
 *   the read gains nothing. A Windows UNC or device path is never touched, whether it is the
 *   changed path or a pointer names it, because touching one can send credentials to another
 *   machine. A changed path with `.` or `..` segments is not located: they are resolved as text
 *   before symlinks are, so the answer could name a tree that does not hold the file.
 * - Like Git's own ownership check, every `.git`, git directory and pointer file must belong to
 *   the user Salidium runs as, and the walk stops at a sticky directory anyone can write to, such
 *   as /tmp. Otherwise another user could plant a `.git` that claims someone's files.
 */
export class RepositoryLocator {
  private readonly cache = new Map<string, { answer: TreeAnswer; at: number }>();
  /** Home as given and as realpath resolves it, which differ where home is reached by a link. */
  private readonly homes: string[];
  /** Directories whose children are user homes: home's parents, and the conventional roots. */
  private readonly userRoots: string[];
  /** The uid every repository file must belong to; undefined where the platform has none. */
  private readonly owner: number | undefined;
  private readonly now: () => number;

  constructor(options: { home?: string; now?: () => number; owner?: number } = {}) {
    const home = resolve(options.home ?? homedir());
    let real = home;
    try {
      real = realpathSync(home);
    } catch {
      // A home that does not exist is compared as given.
    }
    // macOS also reaches every home through the Data volume's firmlink, which realpath keeps.
    const dataVolume = process.platform === 'darwin' ? '/System/Volumes/Data' : undefined;
    const forms = [home, real];
    if (dataVolume)
      for (const form of [home, real])
        if (!form.startsWith(`${dataVolume}/`)) forms.push(`${dataVolume}${form}`);
    this.homes = [...new Set(forms)];
    // A home directly under the root has no siblings to protect, but /Users and /home still
    // hold other people's homes.
    this.userRoots = [
      ...new Set([
        ...this.homes.map((h) => dirname(h)).filter((parent) => parent !== dirname(parent)),
        '/Users',
        '/home',
        ...(dataVolume ? [`${dataVolume}/Users`, `${dataVolume}/home`] : []),
      ]),
    ];
    this.owner = options.owner ?? process.getuid?.();
    this.now = options.now ?? Date.now;
  }

  async locate(path: string): Promise<FileRepository | null> {
    if (!isAbsolute(path) || isRemoteOrDevicePath(path) || hasDotSegment(path)) return null;
    const target = resolve(path);
    const existing = await nearestExisting(dirname(target));
    if (!existing) return null;
    const missing = relative(existing.given, dirname(target));
    const realDir = existing.real;
    if (this.foreignHome(realDir)) return null;
    const tree = await this.treeOf(realDir);
    if (!tree) return null;
    const relativePath = relative(tree.root, join(realDir, missing, basename(target)));
    if (relativePath === '' || escapes(relativePath)) return null;
    return {
      root: tree.root,
      path: relativePath.split(sep).join('/'),
      ...(tree.mainRoot ? { mainRoot: tree.mainRoot } : {}),
    };
  }

  /** True for a path inside some other user's home directory, which is never Salidium's to read. */
  private foreignHome(path: string): boolean {
    if (this.homes.some((home) => within(path, home))) return false;
    return this.userRoots.some((root) => within(path, root) && path !== root);
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
      // A sticky directory anyone can write to is where another user could plant a `.git`.
      if (await isSharedDirectory(dir)) break;
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
      kind = !this.ownedByUs(info.uid)
        ? 'other'
        : info.isDirectory()
          ? 'directory'
          : info.isFile()
            ? 'file'
            : 'other';
    } catch {
      return undefined;
    }
    if (kind === 'other') return null;
    if (kind === 'directory') return (await this.isGitDir(dotGit)) ? { root: dir } : null;
    const gitDir = await this.pointer(dotGit, dir, /^gitdir: (.+)$/);
    if (typeof gitDir !== 'string') return null;
    const commonDir = await this.pointer(join(gitDir, 'commondir'), gitDir, /^(.+)$/);
    // No commondir: a submodule or a separated git dir, which is its own tree.
    if (commonDir === 'absent') return { root: dir };
    if (!commonDir) return null;
    const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
    if (mainRoot === dir) return { root: dir };
    if (this.foreignHome(mainRoot) || !(await isDirectory(mainRoot))) return null;
    return { root: dir, mainRoot };
  }

  /**
   * The git directory a one-line pointer file names, resolved and checked; `absent` when there is
   * no such file, and null when there is one that names nothing usable.
   */
  private async pointer(
    file: string,
    base: string,
    line: RegExp,
  ): Promise<string | 'absent' | null> {
    const read = await readBounded(file);
    if (read === 'absent') return 'absent';
    if (!read || !this.ownedByUs(read.uid)) return null;
    const first = read.text.split('\n')[0]?.replace(/\r$/, '').trim();
    const named = first ? line.exec(first)?.[1]?.trim() : undefined;
    if (!named) return null;
    const target = resolve(base, named);
    if (isRemoteOrDevicePath(named) || isRemoteOrDevicePath(target)) return null;
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      return null;
    }
    if (this.foreignHome(real)) return null;
    return (await this.isGitDir(real)) ? real : null;
  }

  private ownedByUs(uid: number): boolean {
    return this.owner === undefined || uid === this.owner;
  }

  /** A directory of ours holding a `HEAD` of ours. */
  private async isGitDir(dir: string): Promise<boolean> {
    try {
      const info = await stat(dir);
      const head = await stat(join(dir, 'HEAD'));
      return (
        info.isDirectory() && head.isFile() && this.ownedByUs(info.uid) && this.ownedByUs(head.uid)
      );
    } catch {
      return false;
    }
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
      // Live means recent and not from the future: a record dated ahead is not evidence of now.
      if (!(age >= 0 && age <= 120_000)) return;
      const paths = new Set<string>();
      for (const e of changed)
        if (e.result.kind === 'fileChanges')
          for (const change of e.result.changes) if (change.applied) paths.add(change.path);
      // One lookup at a time, in arrival order: a slow mount then delays only this, rather than
      // occupying every filesystem worker, and a newer answer is never overtaken by an older one.
      this.idle = this.idle.then(() => this.locate(sessionId, last, [...paths]));
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

/** Sticky and writable by anyone, as /tmp is. */
async function isSharedDirectory(dir: string): Promise<boolean> {
  try {
    return ((await stat(dir)).mode & 0o1002) === 0o1002;
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

/** Pointer files open read-only, never through a final symlink, and never wait on a FIFO. */
const POINTER_OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The first bytes of a regular file, `absent` when it does not exist, and null otherwise. */
async function readBounded(file: string): Promise<{ text: string; uid: number } | 'absent' | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, POINTER_OPEN_FLAGS);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const buffer = Buffer.alloc(MAX_POINTER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_POINTER_BYTES, 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), uid: info.uid };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** A relative path that leaves its base: `..` or `../x`, but not a name such as `..cache`. */
function escapes(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function within(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || !escapes(rel);
}

/** `\\server\share`, `//server/share`, and `\\?\` or `\\.\` device paths. */
function isRemoteOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

/** A `.` or `..` segment anywhere in the path. */
function hasDotSegment(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment === '.' || segment === '..');
}
