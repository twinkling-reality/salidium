import type { CanonicalEvent, EventSource } from '@salidium/protocol';

/**
 * Durable position in one provider session inside a provider's own database.
 *
 * Line-file providers are tailed by byte offset; a database is not. The source owns what the two
 * positions mean and the daemon only persists them, in the same cursor table as file offsets, so a
 * restart resumes where the last committed batch ended.
 */
export interface StoreCursor {
  /** Unique key: the store path and the provider's session id, `<store path>#<session id>`. */
  key: string;
  /** Salidium session id the events belong to (`provider:root session id`). */
  sessionId: string;
  /** The store's own id for the session these rows come from. */
  providerSessionId: string;
  /** Sub-agent lane, when the store session is a child of `sessionId`'s root. */
  agentId?: string;
  /** Source-defined position (for OpenCode: the highest message seq up to which every row is final). */
  position: number;
  /** Source-defined check value at `position` (for OpenCode: how many rows sat at or below it). */
  count: number;
  /** Identity of the store file the cursor was taken from (its inode), when the platform has one. */
  storeIdentity?: number;
}

export interface StorePollRequest {
  /** Absolute path of the store, as returned by `locate`. */
  path: string;
  /** Sessions with no cursor that were last active before this instant are not read. */
  activeSinceMs: number;
  cursors: ReadonlyMap<string, StoreCursor>;
  /** Canonical instant this poll began, for warnings that have no provider time. */
  observedAt: string;
  /** Rows larger than this are not parsed; the source emits a warning instead. */
  maxRecordBytes: number;
  /** Upper bound on rows read in one call, so a backfill yields to the event loop between calls. */
  rowBudget: number;
}

export interface StorePollBatch {
  cursor: StoreCursor;
  events: CanonicalEvent[];
}

export interface StorePollResult {
  batches: StorePollBatch[];
  /** True when the row budget ran out before every changed session was read. */
  more: boolean;
}

export type StoreRawRecord =
  | { raw: string; reason?: undefined }
  | { raw: undefined; reason: string };

/**
 * A provider whose durable session record is a local database rather than line files.
 *
 * The source owns the database connection because the restriction on what may be read is the
 * security boundary and must sit with the queries. The daemon owns scheduling, cursors,
 * persistence and redaction, exactly as for line files.
 */
export interface StoreSource {
  /** The store file for this user, or undefined when the provider has not created one. */
  locate(context: { userHome: string; env: NodeJS.ProcessEnv }): string | undefined;
  /** Files whose size or modification time changes when the provider commits new records. */
  changeIndicators(path: string): string[];
  /** Reads what changed since the cursors, bounded by the row budget. Never writes. */
  poll(request: StorePollRequest): StorePollResult;
  /**
   * Re-reads the record an event cites and verifies its fingerprint. Returns the record's text,
   * unredacted (the caller redacts), or an explicit reason; never content that changed since
   * ingestion. `storePath` is the store currently located for this user; a reference to any
   * other file is refused.
   */
  readRawRecord(storePath: string, ref: NonNullable<EventSource['ref']>): StoreRawRecord;
}
