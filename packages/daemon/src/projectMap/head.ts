import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_REF_FILE_BYTES = 4096;
const MAX_PACKED_REFS_BYTES = 8 * 1024 * 1024;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REF_NAME = /^refs\/[A-Za-z0-9._/-]{1,240}$/;

/**
 * The commit a repository's HEAD names, read as text from the git directory: `HEAD`, then the loose
 * ref or the `packed-refs` line it points to. No git process and no configuration. For the CLI's
 * convenience only; the daemon is always given a full commit id.
 */
export async function readHeadCommit(gitDir: string): Promise<string | null> {
  const head = (await bounded(join(gitDir, 'HEAD'), MAX_REF_FILE_BYTES))?.trim();
  if (!head) return null;
  if (OBJECT_ID.test(head)) return head;
  const ref = /^ref: (\S+)$/.exec(head)?.[1];
  if (!ref || !REF_NAME.test(ref) || ref.split('/').includes('..')) return null;
  const loose = (await bounded(join(gitDir, ref), MAX_REF_FILE_BYTES))?.trim();
  if (loose && OBJECT_ID.test(loose)) return loose;
  const packed = await bounded(join(gitDir, 'packed-refs'), MAX_PACKED_REFS_BYTES);
  for (const line of packed?.split('\n') ?? []) {
    const [oid, name] = line.trim().split(' ');
    if (name === ref && oid && OBJECT_ID.test(oid)) return oid;
  }
  return null;
}

async function bounded(path: string, max: number): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > max) return undefined;
    return (await readFile(path)).toString('utf8');
  } catch {
    return undefined;
  }
}
