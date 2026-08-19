import type { RunState } from '@salidium/core';
import type {
  CanonicalEvent,
  SemanticChange,
  SessionSummary,
  StoredEvent,
} from '@salidium/protocol';

export interface UsageTotals {
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type RetentionDays = 'forever' | 30 | 90 | 365;

export interface RetentionPreview {
  policy: RetentionDays;
  cutoff?: string;
  sessions: Array<{
    id: string;
    title?: string;
    lastEventAt?: string;
    eventCount: number;
    bytes: number;
  }>;
  eventCount: number;
  bytes: number;
}

export interface ReingestJob {
  id: number;
  path: string;
  sessionId: string;
  provider: string;
  agentId?: string;
  parserRevision: string;
  status: 'queued' | 'running' | 'completed' | 'missing' | 'failed';
  attempts: number;
  requestedAt: string;
  error?: string;
}

export interface RawRecordFingerprint {
  path: string;
  line: number;
  recordHash: string;
  capturedAt: string;
  origin: 'ingest' | 'backfill';
  sessionId: string;
  eventId: string;
}

export interface SourceCursor {
  path: string;
  sessionId: string;
  provider: string;
  agentId?: string;
  inode?: number;
  byteOffset: number;
  lineNo: number;
}

export interface AuditMessageRow {
  text: string;
  phase: 'commentary' | 'final';
}

export interface CheckpointRow {
  seq: number;
  reducerVersion: string;
  state: RunState;
}

export interface SessionSearchResult {
  sessions: SessionSummary[];
  matched: number;
  total: number;
}

/**
 * Internal persistence contract. SQLite remains Salidium's authoritative event store; this seam
 * exists so the daemon core is testable and so future storage work has a versioned boundary
 * instead of being spread through ingestion and projection code.
 */
export interface SalidiumStore {
  transaction<T>(fn: () => T): T;
  insertEvents(events: StoredEvent[]): void;
  insertChanges(changes: SemanticChange[], reducerVersion: string): void;
  replaceChanges(sessionId: string, changes: SemanticChange[], reducerVersion: string): void;
  changeLogIsStale(sessionId: string, reducerVersion: string): boolean;
  upsertSession(summary: SessionSummary): void;
  saveCheckpoint(
    sessionId: string,
    seq: number,
    reducerVersion: string,
    state: RunState,
    keep?: number,
  ): void;
  latestCheckpoint(sessionId: string, reducerVersion: string): CheckpointRow | undefined;
  checkpointAtOrBefore(
    sessionId: string,
    reducerVersion: string,
    seq: number,
  ): CheckpointRow | undefined;
  deleteCheckpoints(sessionId: string): void;
  eventsAfter(
    sessionId: string,
    afterSeq: number,
    untilSeq?: number,
    limit?: number,
  ): StoredEvent[];
  eventById(sessionId: string, eventId: string): StoredEvent | undefined;
  eventIds(sessionId: string): string[];
  latestSeq(sessionId: string): number;
  changesBefore(sessionId: string, beforeSeq: number, limit: number): SemanticChange[];
  changesRange(sessionId: string, afterSeq: number, untilSeq: number): SemanticChange[];
  searchSessions(terms: string[], limit?: number): SessionSearchResult;
  listSessions(limit?: number): SessionSummary[];
  getSession(id: string): SessionSummary | undefined;
  deleteSession(sessionId: string): void;
  usageTotals(internal: boolean): UsageTotals | undefined;
  agentMessagesBySession(): Generator<{ sessionId: string; messages: AuditMessageRow[] }>;

  recordRawFingerprint(event: CanonicalEvent, origin?: RawRecordFingerprint['origin']): boolean;
  rawFingerprint(
    sessionId: string,
    eventId: string,
    path: string,
    line: number,
  ): RawRecordFingerprint | undefined;
  getSource(path: string): SourceCursor | undefined;
  upsertSource(cursor: SourceCursor): void;
  allSources(): SourceCursor[];
  /**
   * Every provider file Salidium can durably ask an adapter to re-read. This includes ordinary
   * tail cursors and historical file references embedded in events whose old cursor row is gone.
   */
  reingestSources(): SourceCursor[];
  sourcesForSession(sessionId: string): SourceCursor[];
  clearSourceCursors(sessionId?: string): number;
  enqueueReingest(source: SourceCursor, parserRevision?: string): number;
  pendingReingestJobs(): ReingestJob[];
  reingestJobs(): ReingestJob[];
  startReingestJob(id: number): void;
  finishReingestJob(
    id: number,
    status: Extract<ReingestJob['status'], 'completed' | 'missing' | 'failed'>,
    error?: string,
  ): void;

  retentionPolicy(): RetentionDays;
  setRetentionPolicy(policy: RetentionDays): void;
  retentionPreview(
    policy?: RetentionDays,
    now?: Date,
    limit?: number,
    excludeSessionIds?: readonly string[],
  ): RetentionPreview;
  applyRetention(
    policy?: RetentionDays,
    now?: Date,
    batchSize?: number,
    excludeSessionIds?: readonly string[],
  ): RetentionPreview;
  pinSession(sessionId: string, pinned?: boolean): boolean;
  isSessionPinned(sessionId: string): boolean;
  pinnedSessionIds(): string[];
  isSessionTombstoned(sessionId: string): boolean;
  forgetSession(sessionId: string, now?: Date): boolean;
  compact(): void;
  close(): void;
}

export type SalidiumStoreFactory = (
  path: string,
  options?: { readOnly?: boolean },
) => SalidiumStore;
