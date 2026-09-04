import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  try {
    syncPath(path);
  } catch {
    // Windows and a few filesystems do not permit opening a directory. The file is still synced.
  }
}

function temporaryPath(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  );
}

function writeSynced(path: string, text: string, mode: number): void {
  writeFileSync(path, text, { mode, flag: 'wx' });
  chmodSync(path, mode);
  syncPath(path);
}

/**
 * Same-directory replacement with an optional independently atomic previous copy. At every crash
 * boundary either the old primary or the fully-written new primary remains, and a valid prior
 * configuration is retained without briefly moving the primary out of the way.
 */
export function writePrivateTextAtomic(
  path: string,
  text: string,
  options: { previousPath?: string; secureParent?: boolean; mode?: number } = {},
): void {
  const directory = dirname(path);
  if (options.secureParent === false) {
    if (!existsSync(directory) || !statSync(directory).isDirectory())
      throw new Error(`output directory does not exist: ${directory}`);
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const candidate = temporaryPath(path);
  const mode = options.mode ?? 0o600;
  let previousCandidate: string | undefined;
  try {
    writeSynced(candidate, text, mode);
    if (options.previousPath && existsSync(path)) {
      previousCandidate = temporaryPath(options.previousPath);
      writeSynced(previousCandidate, readFileSync(path, 'utf8'), mode);
      renameSync(previousCandidate, options.previousPath);
      previousCandidate = undefined;
      syncDirectory(directory);
    }
    renameSync(candidate, path);
    syncDirectory(directory);
  } catch (error) {
    for (const temporary of [candidate, previousCandidate]) {
      if (!temporary) continue;
      try {
        unlinkSync(temporary);
      } catch {
        /* Preserve the original write error. */
      }
    }
    throw error;
  }
}

export function writePrivateJsonAtomic(
  path: string,
  value: unknown,
  options: { previousPath?: string; secureParent?: boolean } = {},
): void {
  writePrivateTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
