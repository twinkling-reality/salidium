import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { OptedInRepository, ProjectMap } from '@salidium/project-map';
import { writePrivateTextAtomic } from '../operations/files.ts';
import { INDEXER_VERSION } from './build.ts';

/**
 * Built maps, kept per (repository, commit) under `$SALIDIUM_HOME/project-map/cache`, owner-only.
 *
 * A map is a pure function of a commit, so a cached one never goes stale; what can change is
 * whether the person still lets Salidium map the repository. The cache is therefore keyed by the
 * opt-in itself: each entry lives in a directory named by a digest of the main root and the time it
 * was opted in. A lookup needs the current opt-in record to compute that name, so a revoked
 * repository has no key at all, and one revoked and allowed again starts from an empty directory.
 * Revoking also deletes the directory, and directories no opt-in names are removed on the next
 * write. Entries are bounded in count and bytes and evicted least recently used.
 */
export const DEFAULT_CACHE_LIMITS = { entries: 64, bytes: 256 * 1024 * 1024 };

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

export class ProjectMapCache {
  private readonly directory: string;
  private readonly limits: { entries: number; bytes: number };

  constructor(home: string, limits = DEFAULT_CACHE_LIMITS) {
    this.directory = join(home, 'project-map', 'cache');
    this.limits = limits;
  }

  /** The directory for one opt-in. Exported for tests and for revocation. */
  directoryFor(repository: OptedInRepository): string {
    return join(this.directory, digest(`${repository.root}\0${repository.allowedAt}`).slice(0, 32));
  }

  private fileFor(repository: OptedInRepository, commit: string): string {
    return join(this.directoryFor(repository), `${commit}-${INDEXER_VERSION}.json`);
  }

  /**
   * The cached map and its text. The file is Salidium's own, owner-only, and was validated against
   * the schema when it was built, so a read checks its identity rather than parsing it against the
   * schema again, which for a large map would hold the daemon's thread for seconds.
   */
  get(
    repository: OptedInRepository,
    commit: string,
  ): { map: ProjectMap; text: string } | undefined {
    const file = this.fileFor(repository, commit);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const map = JSON.parse(text) as ProjectMap;
      if (
        map?.format !== 'salidium.project-map' ||
        map.version !== 0 ||
        map.repository?.root !== repository.root ||
        map.repository?.commit !== commit ||
        !Array.isArray(map.nodes) ||
        !Array.isArray(map.edges)
      )
        throw new Error('a cached map is not this repository and commit');
      const now = new Date();
      utimesSync(file, now, now);
      return { map, text };
    } catch {
      rmSync(file, { force: true });
      return undefined;
    }
  }

  set(
    repository: OptedInRepository,
    commit: string,
    text: string,
    current: readonly OptedInRepository[],
  ): void {
    if (Buffer.byteLength(text) > this.limits.bytes) return;
    writePrivateTextAtomic(this.fileFor(repository, commit), text);
    this.evict(current);
  }

  /** Removes what one opt-in cached. Older opt-ins' directories go at the next sweep. */
  forget(repository: OptedInRepository): void {
    rmSync(this.directoryFor(repository), { recursive: true, force: true });
  }

  /** Drops directories no current opt-in names, then the least recently used files over bounds. */
  evict(current: readonly OptedInRepository[]): void {
    const live = new Set(current.map((r) => this.directoryFor(r)));
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return;
    }
    const files: { path: string; bytes: number; used: number }[] = [];
    for (const name of names) {
      const directory = join(this.directory, name);
      if (!live.has(directory)) {
        rmSync(directory, { recursive: true, force: true });
        continue;
      }
      for (const file of safeReaddir(directory)) {
        try {
          const info = statSync(join(directory, file));
          files.push({ path: join(directory, file), bytes: info.size, used: info.mtimeMs });
        } catch {
          /* Removed concurrently. */
        }
      }
    }
    files.sort((a, b) => b.used - a.used);
    let bytes = 0;
    files.forEach((file, index) => {
      bytes += file.bytes;
      if (index >= this.limits.entries || bytes > this.limits.bytes)
        rmSync(file.path, { force: true });
    });
  }
}

function safeReaddir(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}
