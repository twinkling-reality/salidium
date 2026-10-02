import { lstat, open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/*
 * A copy of `RepositoryLocator` from the consumer contract 1.1 branch
 * (packages/daemon/src/enrichers/fileLocation.ts as committed at 5572a10), so that opting in,
 * listing and revoking key a repository by exactly the main root that 1.1's `file.located`
 * reports. When 1.1 merges, this file is deleted and the map imports the locator from there; the
 * interface is the same.
 */

/** Where a path lives: its working tree, its path inside it, and the main repository of a worktree. */
export interface FileRepository {
  root: string;
  path: string;
  mainRoot?: string;
}

/** Directories walked upward from a changed path before giving up. */
const MAX_DEPTH = 64;
/** Bytes read from a `.git` file or a `commondir` file. Both hold one short line. */
const MAX_POINTER_BYTES = 1024;
/** Directories whose answer is remembered, and for how long. */
const CACHE_ENTRIES = 4096;
const CACHE_MS = 60_000;

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
