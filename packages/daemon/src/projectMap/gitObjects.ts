import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { MapOverBound } from './build.ts';

/*
 * Reads committed Git objects from a repository that is treated as untrusted content.
 *
 * The repository's own Git directory is never handed to git. Every git process runs against a shim
 * Git directory that Salidium owns (an empty config, no refs, no hooks), with `GIT_OBJECT_DIRECTORY`
 * pointing at the repository's object store. So the repository's `config` and anything it
 * includes, its hooks, refs, replace refs, grafts, shallow file, attributes and promisor settings
 * are not read at all: there is no repository configuration for a crafted repository to use.
 * What git still reads from the repository is its object store: loose objects and packs, whose
 * contents it parses and returns as data.
 *
 * Further hardening, all of it independent of the shim:
 *
 * - Only `cat-file --batch-check`, `cat-file --batch` and `ls-tree` run, with an argv array and no
 *   shell, from an empty working directory.
 * - Object names are full 40- or 64-hex ids only; nothing is parsed as a revision expression.
 * - The environment is built from nothing: `HOME` and `XDG_CONFIG_HOME` are an empty directory,
 *   `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_NO_REPLACE_OBJECTS=1`,
 *   `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, and the inherited `GIT_*` variables (such as
 *   `GIT_ALTERNATE_OBJECT_DIRECTORIES` or `GIT_CONFIG_PARAMETERS`) are not passed. Command-line
 *   `-c` settings turn off fsmonitor, hooks, the pager and every transport, which binds even if a
 *   configuration file were somehow read.
 * - A repository whose object store names alternates (`objects/info/alternates`) is refused, so git
 *   never reads objects outside the opted-in repository's own store.
 * - Each child has a timeout and an output cap, and is killed when either is reached. Sizes come
 *   from object headers before any content is read, and content is read only for objects under the
 *   per-object bound and within the total budget.
 */

export const GIT_TIMEOUT_MS = 15_000;
const MAX_PACK_ENTRIES = 4096;
const MAX_OBJECT_DIRECTORY_ENTRIES = 1024;
/** Longest tree record accepted: a path far beyond any file system's, plus the mode and id. */
const MAX_TREE_RECORD_BYTES = 8192;
/** The last second of year 9999, the latest time an ISO timestamp can carry. */
const MAX_COMMIT_SECONDS = 253_402_300_799;
const COMMIT_MAX_BYTES = 1024 * 1024;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class GitReadError extends Error {
  readonly code: 'unsupported' | 'over-bound' | 'failed' | 'timeout';
  constructor(code: GitReadError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ObjectStore {
  /** The repository's object directory, resolved through symbolic links. */
  objects: string;
  /**
   * The repository's hash, from the one `objectformat` key of its config, read as bounded text and
   * never interpreted by git.
   */
  format: 'sha1' | 'sha256';
  /** The repository's own git directory, where its HEAD is. Never handed to git. */
  gitDir: string;
}

const CONFIG_MAX_BYTES = 64 * 1024;

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'commit' | 'tree';
  oid: string;
}

/**
 * The object store of the repository whose main working tree (or bare directory) is `mainRoot`.
 * Reads only `.git` and, for a `.git` file, the one line it holds, then checks the store.
 */
export async function locateObjectStore(mainRoot: string): Promise<ObjectStore> {
  const root = await realpath(mainRoot);
  let gitDir: string;
  const dotGit = join(root, '.git');
  const info = await lstat(dotGit).catch(() => undefined);
  if (info?.isDirectory()) gitDir = dotGit;
  else if (info?.isFile()) {
    // A submodule checkout or a separated git directory. The directory it names is recorded when
    // the repository is opted in and must not change afterwards; see the opt-in record.
    const text = (await readBoundedText(dotGit, 1024)) ?? '';
    const named = /^gitdir: (.+)$/.exec(text.split('\n')[0]?.replace(/\r$/, '').trim() ?? '')?.[1];
    if (!named)
      throw new GitReadError('unsupported', 'the .git file does not name a git directory');
    gitDir = resolve(root, named.trim());
  } else if (await isFile(join(root, 'HEAD')))
    gitDir = root; // a bare repository
  else throw new GitReadError('unsupported', 'no git directory at the repository root');
  gitDir = await realpath(gitDir);
  await assertOwned(gitDir, 'the git directory');
  // A main repository holds its own objects. `commondir` belongs to linked worktrees, which are
  // keyed by their main repository and never read through their own git directory.
  if (await lstat(join(gitDir, 'commondir')).catch(() => undefined))
    throw new GitReadError(
      'unsupported',
      'the git directory points at another repository (commondir); allow the main repository instead',
    );
  const objects = join(gitDir, 'objects');
  const store = await lstat(objects).catch(() => undefined);
  if (!store?.isDirectory())
    throw new GitReadError(
      'unsupported',
      store?.isSymbolicLink()
        ? 'the object directory is a symbolic link; Salidium maps only repositories that hold their own objects'
        : 'the repository has no object directory',
    );
  await assertOwned(objects, 'the object directory');
  const alternates = await lstat(join(objects, 'info', 'alternates')).catch(() => undefined);
  if (alternates)
    throw new GitReadError(
      'unsupported',
      'the repository borrows objects from another directory (objects/info/alternates); Salidium maps only repositories that hold their own objects',
    );
  await assertPlainEntries(objects, 'the object directory');
  await assertPlainEntries(join(objects, 'info'), 'objects/info');
  await assertRegularPacks(join(objects, 'pack'));
  return { objects, format: await objectFormat(join(gitDir, 'config')), gitDir };
}

/** Like Git's own ownership check: a directory another user owns could hold anything. */
async function assertOwned(path: string, what: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const info = await stat(path);
  if (info.uid !== uid) throw new GitReadError('unsupported', `${what} belongs to another user`);
}

/**
 * The object directory's own entries (the loose-object fan-out directories, `info` and `pack`) must
 * be real directories or files: a symbolic link there would serve another repository's objects as
 * this one's. Loose object files inside the fan-out directories are not walked, since there can be
 * very many; a link there serves an object only under its own id, which a crafted tree would have
 * to know already.
 */
async function assertPlainEntries(directory: string, what: string): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  if (names.length > MAX_OBJECT_DIRECTORY_ENTRIES)
    throw new GitReadError('unsupported', `${what} holds more entries than any real one`);
  for (const name of names) {
    const entry = await lstat(join(directory, name));
    if (!entry.isDirectory() && !entry.isFile())
      throw new GitReadError(
        'unsupported',
        `${what} holds a symbolic link or special file; Salidium maps only repositories that hold their own objects`,
      );
  }
}

/**
 * The pack directory may hold only regular files: a FIFO would block git until its timeout, and a
 * symbolic link could lead outside the store. Loose objects are not walked (there can be many);
 * a blocking one costs one timeout.
 */
async function assertRegularPacks(pack: string): Promise<void> {
  const info = await lstat(pack).catch(() => undefined);
  if (!info) return;
  if (!info.isDirectory())
    throw new GitReadError('unsupported', 'the pack directory is not a directory');
  const names = await readdir(pack);
  if (names.length > MAX_PACK_ENTRIES)
    throw new GitReadError('unsupported', 'the pack directory holds more files than any real one');
  for (const name of names) {
    const entry = await lstat(join(pack, name));
    if (!entry.isFile())
      throw new GitReadError('unsupported', 'the pack directory holds something other than files');
  }
}

/**
 * `extensions.objectFormat`, the one repository setting a map needs, read as text. Anything other
 * than an absent key, sha1 or sha256, or a config too large to be real, is refused rather than
 * guessed, because reading SHA-256 objects as SHA-1 (or the reverse) would misparse every pack.
 */
async function objectFormat(configPath: string): Promise<'sha1' | 'sha256'> {
  let text: string;
  try {
    const info = await lstat(configPath);
    if (!info.isFile()) return 'sha1';
    if (info.size > CONFIG_MAX_BYTES)
      throw new GitReadError('unsupported', 'the repository config is larger than any real one');
    text = (await readFile(configPath)).toString('utf8');
  } catch (error) {
    if (error instanceof GitReadError) throw error;
    return 'sha1';
  }
  let section = '';
  let format: 'sha1' | 'sha256' = 'sha1';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[;#].*$/, '').trim();
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]$/.exec(line);
    if (header) {
      section = (header[1] ?? '').toLowerCase();
      continue;
    }
    if (section !== 'extensions') continue;
    const value = /^objectformat\s*=\s*"?([^"]*)"?$/i.exec(line)?.[1]?.trim().toLowerCase();
    if (value === undefined) continue;
    if (value === 'sha1' || value === 'sha256') format = value;
    else throw new GitReadError('unsupported', 'the repository uses an unknown object format');
  }
  return format;
}

/**
 * Runs the git plumbing a map needs, against a shim git directory under `scratch`. The scratch
 * directory belongs to Salidium and is created owner-only.
 */
export class GitObjectReader {
  private readonly store: ObjectStore;
  private readonly scratch: string;
  private readonly timeoutMs: number;
  private readonly git: string;
  private shim: string | undefined;

  private readonly path: string;

  /**
   * @param git absolute path of a trusted git executable, resolved by the caller
   * @param path the trusted PATH the child sees
   */
  constructor(options: {
    store: ObjectStore;
    scratch: string;
    git: string;
    path: string;
    timeoutMs?: number;
  }) {
    if (!isAbsolute(options.git)) throw new GitReadError('failed', 'git must be an absolute path');
    this.store = options.store;
    this.scratch = options.scratch;
    this.git = options.git;
    this.path = options.path;
    this.timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  }

  /** The first line `git --version` prints, so behaviour differences between builds are traceable. */
  async version(): Promise<string> {
    const out = await this.run(['--version'], undefined, { maxBytes: 4096 });
    return firstLine(out.toString('utf8')).slice(0, 64);
  }

  /** Types and sizes of the named objects, from their headers. Missing objects are reported so. */
  async check(
    oids: readonly string[],
  ): Promise<Map<string, { type: string; bytes: number } | null>> {
    for (const oid of oids) assertObjectId(oid);
    const result = new Map<string, { type: string; bytes: number } | null>();
    if (oids.length === 0) return result;
    const out = await this.run(['cat-file', '--batch-check'], `${oids.join('\n')}\n`, {
      maxBytes: oids.length * 160,
    });
    for (const line of out.toString('utf8').split('\n')) {
      if (!line) continue;
      const [oid, type, size] = line.split(' ');
      if (!oid) continue;
      if (type === 'missing' || size === undefined) result.set(oid, null);
      else result.set(oid, { type: type ?? '', bytes: Number(size) });
    }
    return result;
  }

  /** The commit's tree and committer time. Null when the store has no such commit. */
  async commit(oid: string): Promise<{ tree: string; commitTime: string } | null> {
    const header = (await this.check([oid])).get(oid);
    if (header?.type !== 'commit') return null;
    if (header.bytes > COMMIT_MAX_BYTES)
      throw new GitReadError('over-bound', 'the commit object is larger than any real commit');
    const text = (await this.read([{ oid, bytes: header.bytes }])).get(oid)?.toString('utf8');
    if (text === undefined) return null;
    const blank = text.indexOf('\n\n');
    const head = blank < 0 ? text : text.slice(0, blank);
    const tree = /^tree ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/m.exec(head)?.[1];
    const time = /^committer .* (\d{1,12}) [+-]\d{4}$/m.exec(head)?.[1];
    if (!tree || !time || Number(time) > MAX_COMMIT_SECONDS)
      throw new GitReadError('failed', 'the commit object could not be read');
    return { tree, commitTime: new Date(Number(time) * 1000).toISOString() };
  }

  /**
   * Every entry of a tree, recursively, without sizes: listing a tree reads tree objects only, so
   * a blob missing from the store does not stop it. Sizes come from `check`. Refused once there are
   * more than `maxEntries`, so a huge tree never becomes a huge listing in memory.
   */
  async listTree(tree: string, maxEntries: number): Promise<TreeEntry[]> {
    assertObjectId(tree);
    const entries: TreeEntry[] = [];
    let tail = Buffer.alloc(0);
    let over: 'files' | 'path-length' | undefined;
    await this.run(['ls-tree', '-r', '-z', '--full-tree', tree], undefined, {
      // A record is about 110 bytes before its path, and paths are bounded by the filesystem.
      maxBytes: (maxEntries + 1) * 4400,
      onData: (chunk, stop) => {
        let buffer = tail.length ? Buffer.concat([tail, chunk]) : chunk;
        for (;;) {
          const end = buffer.indexOf(0);
          if (end < 0) break;
          if (end > MAX_TREE_RECORD_BYTES) {
            over = 'path-length';
            stop();
            return;
          }
          const record = buffer.subarray(0, end).toString('utf8');
          buffer = buffer.subarray(end + 1);
          const tab = record.indexOf('\t');
          const [mode, type, oid] = record.slice(0, tab).split(' ');
          if (!mode || !oid || (type !== 'blob' && type !== 'commit' && type !== 'tree')) continue;
          entries.push({ path: record.slice(tab + 1), mode, type, oid });
          if (entries.length > maxEntries) {
            over = 'files';
            stop();
            return;
          }
        }
        if (buffer.length > MAX_TREE_RECORD_BYTES) {
          over = 'path-length';
          stop();
          return;
        }
        tail = Buffer.from(buffer);
      },
    }).catch((error: unknown) => {
      if (!over) throw error;
    });
    if (over === 'files')
      throw new MapOverBound('files', `the tree has more than ${maxEntries} entries`);
    if (over === 'path-length')
      throw new MapOverBound('path-length', 'the tree holds an entry with an impossibly long name');
    return entries;
  }

  /**
   * Contents of objects whose sizes are already known from their headers. The output is capped at
   * exactly what those sizes allow, so an object that turns out larger stops the read.
   */
  async read(objects: readonly { oid: string; bytes: number }[]): Promise<Map<string, Buffer>> {
    const contents = new Map<string, Buffer>();
    const unique = [...new Map(objects.map((o) => [o.oid, o])).values()];
    if (unique.length === 0) return contents;
    for (const { oid } of unique) assertObjectId(oid);
    const expected = new Map(unique.map((o) => [o.oid, o.bytes]));
    const budget = unique.reduce((sum, o) => sum + o.bytes + 120, 0);
    const out = await this.run(
      ['cat-file', '--batch'],
      `${unique.map((o) => o.oid).join('\n')}\n`,
      {
        maxBytes: budget,
      },
    );
    let offset = 0;
    while (offset < out.length) {
      const newline = out.indexOf(10, offset);
      if (newline < 0) break;
      const [oid, type, size] = out.subarray(offset, newline).toString('utf8').split(' ');
      offset = newline + 1;
      if (!oid || type === 'missing' || size === undefined) continue;
      const length = Number(size);
      if (expected.get(oid) !== length)
        throw new GitReadError('failed', 'an object changed size between its header and its read');
      contents.set(oid, Buffer.from(out.subarray(offset, offset + length)));
      offset += length + 1;
    }
    return contents;
  }

  private async shimDirectory(): Promise<string> {
    if (this.shim) return this.shim;
    const shim = join(this.scratch, `git-shim-${this.store.format}`);
    const empty = join(this.scratch, 'empty-home');
    await mkdir(join(shim, 'refs'), { recursive: true, mode: 0o700 });
    await mkdir(join(shim, 'objects'), { recursive: true, mode: 0o700 });
    await mkdir(empty, { recursive: true, mode: 0o700 });
    await writeFile(join(shim, 'HEAD'), 'ref: refs/heads/salidium-none\n', { mode: 0o600 });
    const config =
      this.store.format === 'sha256'
        ? '[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = sha256\n'
        : '[core]\n\trepositoryformatversion = 0\n\tbare = true\n';
    await writeFile(join(shim, 'config'), config, { mode: 0o600 });
    this.shim = shim;
    return shim;
  }

  private async run(
    args: string[],
    input: string | undefined,
    options: {
      maxBytes: number;
      onData?: (chunk: Buffer, stop: () => void) => void;
    },
  ): Promise<Buffer> {
    const shim = await this.shimDirectory();
    const empty = join(this.scratch, 'empty-home');
    const argv = [
      '--no-pager',
      `--git-dir=${shim}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'protocol.allow=never',
      '-c',
      'core.pager=cat',
      ...args,
    ];
    const env: NodeJS.ProcessEnv = {
      PATH: this.path,
      HOME: empty,
      XDG_CONFIG_HOME: empty,
      LC_ALL: 'C',
      GIT_OBJECT_DIRECTORY: this.store.objects,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_ATTR_NOSYSTEM: '1',
    };
    return new Promise<Buffer>((resolvePromise, reject) => {
      const child = spawn(this.git, argv, {
        cwd: empty,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let total = 0;
      let stderr = '';
      let failure: GitReadError | undefined;
      const kill = (error: GitReadError) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(
        () =>
          kill(new GitReadError('timeout', `git ${args[0]} took longer than ${this.timeoutMs} ms`)),
        this.timeoutMs,
      );
      child.stdout.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > options.maxBytes) {
          kill(new GitReadError('over-bound', `git ${args[0]} produced more output than allowed`));
          return;
        }
        if (options.onData)
          options.onData(chunk, () => kill(new GitReadError('over-bound', 'stopped at a bound')));
        else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 2000) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new GitReadError('failed', `git could not run: ${error.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0)
          reject(new GitReadError('failed', `git ${args[0]} failed: ${firstLine(stderr)}`));
        else resolvePromise(Buffer.concat(chunks));
      });
      child.stdin.on('error', () => {
        /* The child exited early; its exit status says why. */
      });
      child.stdin.end(input ?? '');
    });
  }
}

function assertObjectId(oid: string): void {
  if (!OBJECT_ID.test(oid)) throw new GitReadError('failed', 'not a full object id');
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 200);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readBoundedText(path: string, max: number): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > max) return undefined;
    return (await readFile(path)).toString('utf8');
  } catch {
    return undefined;
  }
}
