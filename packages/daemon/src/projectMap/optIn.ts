import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_OPTED_IN_REPOSITORIES,
  type OptedInRepository,
  RepositoryRootSchema,
} from '@salidium/project-map';
import { z } from 'zod';
import { writePrivateJsonAtomic } from '../operations/files.ts';

/**
 * Which repositories the person lets Salidium map.
 *
 * A map reads a repository's committed objects, so it is opt-in per repository and never implied:
 * `salidium map allow <repository>` adds one, `salidium map revoke <repository>` removes it. A
 * repository is keyed by its main root, the realpath of its main working tree, so a linked worktree
 * and the repository it belongs to are one entry, and nothing is stored under a worktree path.
 *
 * The file, owner-only beside `consumer-credentials.json`, is the authority, as it is for consumer
 * credentials. The CLI edits it under a small lock whether or not the daemon runs; the daemon
 * re-reads it when its metadata changes, so a revocation applies to the next request. An unreadable
 * or invalid file opts nothing in.
 */
export const PROJECT_MAP_REPOSITORIES_FILE = 'project-map-repositories.json';
const LOCK_DIRECTORY = 'project-map-repositories.lock';

const StoredRepositorySchema = z
  .object({
    root: RepositoryRootSchema,
    allowedAt: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

const OptInFileSchema = z
  .object({
    version: z.literal(1),
    repositories: z.array(StoredRepositorySchema).max(MAX_OPTED_IN_REPOSITORIES),
  })
  .strict();
type OptInFile = z.infer<typeof OptInFileSchema>;

export function projectMapRepositoriesPath(home: string): string {
  return join(home, PROJECT_MAP_REPOSITORIES_FILE);
}

/** Absent is an empty set. Unreadable or invalid throws, so a damaged file is never overwritten. */
function readOptInFile(home: string): OptInFile {
  let text: string;
  try {
    text = readFileSync(projectMapRepositoriesPath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, repositories: [] };
    throw error;
  }
  const file = OptInFileSchema.parse(JSON.parse(text));
  if (new Set(file.repositories.map((r) => r.root)).size !== file.repositories.length)
    throw new Error('a repository is listed twice');
  return file;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serializes read-modify-write of the file between CLI invocations and anything else, the same
 * way consumer credentials are: an atomic lock directory holding its owner's pid, recovered when
 * that process has died.
 */
function withOptInLock<T>(home: string, work: () => T): T {
  const lock = join(home, LOCK_DIRECTORY);
  const owner = join(lock, 'owner');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(owner, String(process.pid), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number | undefined;
      try {
        pid = Number(readFileSync(owner, 'utf8'));
      } catch {
        /* mkdir finished and the owner write did not; stale once old enough, below. */
      }
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        age = 0;
      }
      const stale =
        (pid !== undefined && Number.isInteger(pid) && pid > 0 && !processAlive(pid)) ||
        (pid === undefined && age > 5_000);
      if (stale) rmSync(lock, { recursive: true, force: true });
      else if (attempt >= 60) throw new Error('map opt-ins are being changed elsewhere');
      else pause(50);
    }
  }
  try {
    return work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function listOptedInRepositories(home: string): OptedInRepository[] {
  return readOptInFile(home).repositories.map((r) => ({ ...r }));
}

/**
 * Opts a main root in. The caller has already resolved it; this checks only its shape. Returns the
 * entry and whether it was new; allowing an opted-in repository again changes nothing.
 */
export function allowRepository(
  home: string,
  mainRoot: string,
  now: Date = new Date(),
): { repository: OptedInRepository; added: boolean } {
  const root = RepositoryRootSchema.parse(mainRoot);
  return withOptInLock(home, () => {
    const file = readOptInFile(home);
    const existing = file.repositories.find((r) => r.root === root);
    if (existing) return { repository: { ...existing }, added: false };
    if (file.repositories.length >= MAX_OPTED_IN_REPOSITORIES)
      throw new Error(
        `at most ${MAX_OPTED_IN_REPOSITORIES} repositories may be opted in; revoke one first`,
      );
    const repository = { root, allowedAt: now.toISOString() };
    writePrivateJsonAtomic(projectMapRepositoriesPath(home), {
      version: 1,
      repositories: [...file.repositories, repository],
    } satisfies OptInFile);
    return { repository, added: true };
  });
}

/** Opts a main root out. Returns false when it was not opted in. */
export function revokeRepository(home: string, mainRoot: string): boolean {
  return withOptInLock(home, () => {
    const file = readOptInFile(home);
    const remaining = file.repositories.filter((r) => r.root !== mainRoot);
    if (remaining.length === file.repositories.length) return false;
    writePrivateJsonAtomic(projectMapRepositoriesPath(home), {
      version: 1,
      repositories: remaining,
    } satisfies OptInFile);
    return true;
  });
}

/**
 * The daemon's view of the opt-in file: re-read whenever its metadata changes, so each check is one
 * `stat`. Fails closed: a file that cannot be parsed opts nothing in until it is repaired.
 */
export class OptInVerifier {
  private signature: string | undefined;
  private repositories: OptedInRepository[] = [];
  private readonly home: string;
  private readonly onInvalid: ((reason: string) => void) | undefined;

  constructor(home: string, onInvalid?: (reason: string) => void) {
    this.home = home;
    this.onInvalid = onInvalid;
  }

  private refresh(): void {
    let signature: string;
    try {
      const stat = statSync(projectMapRepositoriesPath(this.home), { bigint: true });
      signature = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
      signature = 'absent';
    }
    if (signature === this.signature) return;
    this.signature = signature;
    if (signature === 'absent') {
      this.repositories = [];
      return;
    }
    try {
      this.repositories = readOptInFile(this.home).repositories;
    } catch (error) {
      this.repositories = [];
      this.onInvalid?.(`map opt-in file is invalid; no repository is opted in: ${error}`);
    }
  }

  /** The current opt-in for a main root, compared as an exact string, or undefined. */
  get(mainRoot: string): OptedInRepository | undefined {
    this.refresh();
    const found = this.repositories.find((r) => r.root === mainRoot);
    return found ? { ...found } : undefined;
  }

  list(): OptedInRepository[] {
    this.refresh();
    return this.repositories.map((r) => ({ ...r }));
  }
}
