import type { StoreCursor } from '@salidium/adapter-kit';
import type { SourceCursor } from '../storage/salidiumStore.ts';

/*
 * Store-backed providers (OpenCode) persist their positions in the same `source_cursors` table as
 * line files, so restart recovery, re-ingestion and session cleanup treat both alike. The columns
 * were named for files, and for a store cursor they mean something else:
 *
 *   path        `<store path>#<provider session id>`, the cursor key, not a file on disk
 *   line_no     the source's position plus one (OpenCode: the highest final message seq, -1 when
 *               nothing is final yet, so it is stored as 0); not a line number
 *   byte_offset the source's check count (OpenCode: rows at or below that seq); not bytes
 *   inode       the store file's inode when the cursor was taken
 *
 * Only these two functions translate between the shapes. Nothing else may read those columns as
 * lines or bytes for a store-backed provider.
 */

export function storeCursorToSource(cursor: StoreCursor, provider: string): SourceCursor {
  return {
    path: cursor.key,
    sessionId: cursor.sessionId,
    provider,
    agentId: cursor.agentId,
    inode: cursor.storeIdentity,
    lineNo: cursor.position + 1,
    byteOffset: cursor.count,
  };
}

export function sourceToStoreCursor(source: SourceCursor): StoreCursor | undefined {
  const hash = source.path.lastIndexOf('#');
  if (hash <= 0) return undefined;
  return {
    key: source.path,
    sessionId: source.sessionId,
    providerSessionId: source.path.slice(hash + 1),
    agentId: source.agentId,
    storeIdentity: source.inode,
    position: source.lineNo - 1,
    count: source.byteOffset,
  };
}

/** The store path a cursor key or an event-referenced store path names. */
export function storePathOf(key: string): string {
  const hash = key.lastIndexOf('#');
  return hash > 0 ? key.slice(0, hash) : key;
}
