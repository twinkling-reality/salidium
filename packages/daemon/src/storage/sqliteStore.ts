import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { RunState } from '@salidium/core';
import type {
  CanonicalEvent,
  SemanticChange,
  SessionSummary,
  StoredEvent,
} from '@salidium/protocol';
import { ProviderIdSchema, SessionSummarySchema, StoredEventWireSchema } from '@salidium/protocol';
import type {
  AuditMessageRow,
  CheckpointRow,
  RawRecordFingerprint,
  ReingestJob,
  RetentionDays,
  RetentionPreview,
  SalidiumStore,
  SalidiumStoreFactory,
  SessionSearchResult,
  SourceCursor,
  UsageTotals,
} from './salidiumStore.ts';

/**
 * Local SQLite persistence (node:sqlite, WAL). Events are the source of truth Salidium owns;
 * changes are the semantic history; checkpoints make cold loads fast; sessions is a cached
 * summary index for the list; sources track tail cursors so ingestion resumes exactly.
 *
 * All rows carry session_id so cross-session queries (project, provider, time) are cheap later.
 */
export const SCHEMA_VERSION = 6;

/** Parser contract written into durable re-ingestion jobs. Bump when record interpretation changes. */
export const INGEST_PARSER_REVISION = '2026-08-19.1';

function existingSchemaVersion(db: DatabaseSync): number | undefined {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value?: unknown }
      | undefined;
    if (!row) return undefined;
    const version = Number(row.value);
    if (!Number.isInteger(version) || version < 0)
      throw new Error(`invalid Salidium store schema version: ${String(row.value)}`);
    return version;
  } catch (err) {
    if (err instanceof Error && /no such table: meta/.test(err.message)) return undefined;
    throw err;
  }
}

function rejectNewerSchema(db: DatabaseSync): void {
  const version = existingSchemaVersion(db);
  if (version !== undefined && version > SCHEMA_VERSION)
    throw new Error(
      `Salidium store schema ${version} is newer than this version supports (${SCHEMA_VERSION})`,
    );
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  cwd TEXT,
  repo_root TEXT,
  title TEXT,
  status TEXT,
  started_at TEXT,
  last_event_at TEXT,
  ended_at TEXT,
  latest_seq INTEGER NOT NULL DEFAULT -1,
  summary_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_last_event ON sessions(last_event_at);
CREATE INDEX IF NOT EXISTS sessions_cwd ON sessions(cwd);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_id TEXT,
  turn_id TEXT,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS events_by_id ON events(session_id, event_id);
CREATE INDEX IF NOT EXISTS events_by_kind ON events(session_id, kind);
CREATE TABLE IF NOT EXISTS changes (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  ts TEXT NOT NULL,
  facet TEXT NOT NULL,
  summary TEXT NOT NULL,
  epistemic TEXT NOT NULL,
  json TEXT NOT NULL,
  reducer_version TEXT,
  PRIMARY KEY (session_id, seq, ordinal)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS changes_by_facet ON changes(session_id, facet);
CREATE INDEX IF NOT EXISTS changes_by_ts ON changes(session_id, ts);
CREATE TABLE IF NOT EXISTS checkpoints (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  reducer_version TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS sources (
  path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  agent_id TEXT,
  inode INTEGER,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  line_no INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_by_session ON sources(session_id);
CREATE TABLE IF NOT EXISTS raw_record_fingerprints (
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  record_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('ingest', 'backfill')),
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (session_id, event_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS raw_fingerprints_by_location
  ON raw_record_fingerprints(path, line);
CREATE TABLE IF NOT EXISTS raw_fingerprint_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  candidate_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reingest_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  agent_id TEXT,
  parser_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'missing', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS reingest_jobs_status ON reingest_jobs(status, requested_at, id);
CREATE TABLE IF NOT EXISTS session_pins (
  session_id TEXT PRIMARY KEY,
  pinned_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_tombstones (
  session_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  cutoff TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_rollups (
  internal INTEGER PRIMARY KEY CHECK (internal IN (0, 1)),
  messages INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Schema 6 is deliberately separate from the local evidence DDL. Existing stores create these
 * tables inside the offline migration transaction; a failed migration therefore cannot advertise
 * schema 6 with only part of the sync foundation present. Nothing is backfilled or enabled.
 */
const SCHEMA_6_DDL = `
CREATE TABLE IF NOT EXISTS sync_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  replica_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_streams (
  stream_id TEXT PRIMARY KEY,
  replica_id TEXT NOT NULL,
  -- Positions are unique per generation, not per replica. A replica restored from an older backup
  -- bumps this so its reused positions are a declared restart rather than a content conflict.
  replica_generation INTEGER NOT NULL DEFAULT 1,
  destination_id TEXT NOT NULL UNIQUE,
  next_control_position INTEGER NOT NULL DEFAULT 0,
  next_data_position INTEGER NOT NULL DEFAULT 0,
  acknowledged_control_position INTEGER NOT NULL DEFAULT -1,
  acknowledged_data_position INTEGER NOT NULL DEFAULT -1,
  previous_control_operation_id TEXT,
  previous_data_operation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_consent_revisions (
  stream_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  destination_id TEXT NOT NULL,
  json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (stream_id, grant_id, revision),
  FOREIGN KEY (stream_id) REFERENCES sync_streams(stream_id)
);
CREATE INDEX IF NOT EXISTS sync_consent_current
  ON sync_consent_revisions(stream_id, grant_id, revision DESC);
CREATE TABLE IF NOT EXISTS intelligence_records (
  stream_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_revision INTEGER NOT NULL,
  current INTEGER NOT NULL CHECK (current IN (0, 1)),
  json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (stream_id, item_id, revision),
  FOREIGN KEY (stream_id) REFERENCES sync_streams(stream_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS intelligence_one_current_revision
  ON intelligence_records(stream_id, item_id) WHERE current = 1;
CREATE TABLE IF NOT EXISTS intelligence_evidence_map (
  evidence_id TEXT PRIMARY KEY,
  independence_id TEXT NOT NULL,
  session_id TEXT,
  event_id TEXT,
  authority TEXT NOT NULL,
  role TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  descriptor_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intelligence_tombstones (
  stream_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  delete_through_revision INTEGER NOT NULL,
  reason TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  receipt_id TEXT,
  completed_at TEXT,
  PRIMARY KEY (stream_id, item_id),
  FOREIGN KEY (stream_id) REFERENCES sync_streams(stream_id)
);
CREATE TABLE IF NOT EXISTS sync_outbox (
  stream_id TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('control', 'data')),
  position INTEGER NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  operation_type TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  grant_id TEXT,
  item_id TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  acknowledged_at TEXT,
  -- A destination can refuse an operation permanently. That is a distinct outcome from durable
  -- acceptance and must never be recorded as one, or a refused record would read as delivered.
  refused_at TEXT,
  refusal_code TEXT,
  PRIMARY KEY (stream_id, lane, position),
  FOREIGN KEY (stream_id) REFERENCES sync_streams(stream_id)
);
CREATE INDEX IF NOT EXISTS sync_outbox_pending
  ON sync_outbox(stream_id, lane, acknowledged_at, position);
CREATE TABLE IF NOT EXISTS sync_deletion_receipts (
  receipt_id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  json TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  FOREIGN KEY (stream_id) REFERENCES sync_streams(stream_id)
);
`;

function canonicalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

/**
 * Provider files can outlive their old `sources` cursor row. Event provenance remains durable, so
 * use it as a second recovery index instead of silently excluding those files from repair. Schema
 * 4 guarantees these event JSON values satisfy the current protocol before this query runs.
 */
function eventReferencedSources(db: DatabaseSync): SourceCursor[] {
  const rows = db
    .prepare(`SELECT json_extract(json, '$.source.ref.path') AS path,
                     MIN(session_id) AS session_id,
                     MIN(json_extract(json, '$.source.provider')) AS provider
                FROM events
               WHERE json_extract(json, '$.source.channel') IN ('transcript', 'rollout')
                 AND json_type(json, '$.source.ref.path') = 'text'
                 AND json_extract(json, '$.source.ref.path') <> ''
               GROUP BY json_extract(json, '$.source.ref.path')
              HAVING COUNT(DISTINCT session_id) = 1
                 AND COUNT(DISTINCT json_extract(json, '$.source.provider')) = 1
               ORDER BY path`)
    .all() as Array<{
    path: string;
    session_id: string;
    provider: string;
  }>;
  return rows.map((row) => ({
    path: row.path,
    sessionId: row.session_id,
    provider: row.provider,
    byteOffset: 0,
    lineNo: 0,
  }));
}

function comparableEvent(event: CanonicalEvent | StoredEvent): unknown {
  const copy = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
  delete copy.seq;
  delete copy.redactions;
  const source = copy.source as Record<string, unknown> | undefined;
  const ref = source?.ref as Record<string, unknown> | undefined;
  if (ref) delete ref.recordHash;
  return copy;
}

const CHECKPOINT_GZIP_PREFIX = 'gzip-base64:v1:';
const CHECKPOINT_COMPRESS_MIN_BYTES = 4 * 1024;
const CHECKPOINT_MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;

function encodeCheckpoint(state: RunState): string {
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json) < CHECKPOINT_COMPRESS_MIN_BYTES) return json;
  // Level 1 is intentionally the fast setting: checkpoints are written on the ingest path. The
  // measured store shrinks dramatically even at this level, while replay remains the fallback.
  return `${CHECKPOINT_GZIP_PREFIX}${gzipSync(json, { level: 1 }).toString('base64')}`;
}

function decodeCheckpoint(encoded: string): RunState {
  if (!encoded.startsWith(CHECKPOINT_GZIP_PREFIX)) return JSON.parse(encoded) as RunState;
  const compressed = Buffer.from(encoded.slice(CHECKPOINT_GZIP_PREFIX.length), 'base64');
  const json = gunzipSync(compressed, { maxOutputLength: CHECKPOINT_MAX_DECOMPRESSED_BYTES });
  return JSON.parse(json.toString('utf8')) as RunState;
}

/**
 * Schema 2 separates same-record hook observations from transcript evidence and makes every
 * persisted timestamp safe for the strict wire schema. The migration is deliberately offline:
 * the daemon is the single writer and runs this before accepting hooks or opening the listener.
 */
function migrateToSchema2(db: DatabaseSync): void {
  const existingMigration = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_2_migrated_at'")
    .get() as { value?: string } | undefined;
  const migratedAt = canonicalizeTimestamp(existingMigration?.value) ?? new Date().toISOString();
  const affected = new Set<string>();

  const updateEvent = db.prepare(
    'UPDATE events SET event_id = ?, ts = ?, kind = ?, json = ? WHERE session_id = ? AND seq = ?',
  );
  const eventById = db.prepare(
    'SELECT seq FROM events WHERE session_id = ? AND event_id = ? LIMIT 1',
  );
  const sessionProvider = db.prepare('SELECT provider FROM sessions WHERE id = ?');

  for (const unknownRow of db
    .prepare(
      'SELECT session_id, seq, event_id, ts, kind, json FROM events ORDER BY session_id, seq',
    )
    .iterate()) {
    const row = unknownRow as unknown as {
      session_id: string;
      seq: number;
      event_id: string;
      ts: string;
      kind: string;
      json: string;
    };
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(row.json) as Record<string, unknown>;
    } catch {
      event = {};
    }

    let eventId = row.event_id;
    const source =
      event.source !== null && typeof event.source === 'object'
        ? (event.source as Record<string, unknown>)
        : undefined;
    if (
      source?.provider === 'claude-code' &&
      source.channel === 'hook' &&
      (row.kind === 'tool.called' || row.kind === 'tool.completed' || row.kind === 'tool.failed') &&
      !eventId.endsWith(':hook')
    ) {
      const hookId = `${eventId}:hook`;
      if (eventById.get(row.session_id, hookId)) {
        // Preserve sequence contiguity: strict SSE clients reject any permanent gap. The duplicate
        // becomes an explicit warning at its original sequence rather than disappearing.
        const warningId = `${hookId}:legacy-collision:${row.seq}`;
        const ts = canonicalizeTimestamp(event.ts ?? row.ts) ?? migratedAt;
        updateEvent.run(
          warningId,
          ts,
          'ingest.warning',
          JSON.stringify({
            id: warningId,
            sessionId: row.session_id,
            seq: row.seq,
            ts,
            tsSource: 'ingest',
            source: { provider: 'claude-code', channel: 'salidium' },
            kind: 'ingest.warning',
            code: 'malformed-record',
            detail: 'legacy unsuffixed Claude hook event duplicated a newer :hook observation',
          }),
          row.session_id,
          row.seq,
        );
        affected.add(row.session_id);
        continue;
      }
      eventId = hookId;
      event.id = hookId;
      affected.add(row.session_id);
    }

    const ts = canonicalizeTimestamp(event.ts ?? row.ts);
    if (ts) {
      if (event.ts !== ts || row.ts !== ts || eventId !== row.event_id) {
        event.ts = ts;
        updateEvent.run(eventId, ts, row.kind, JSON.stringify(event), row.session_id, row.seq);
        affected.add(row.session_id);
      }
      continue;
    }

    const providerRow = sessionProvider.get(row.session_id) as { provider?: string } | undefined;
    const provider =
      source?.provider === 'claude-code' || source?.provider === 'codex'
        ? source.provider
        : providerRow?.provider === 'codex'
          ? 'codex'
          : 'claude-code';
    const warningId = `${eventId}:migration-invalid-ts:${row.seq}`;
    const warning = {
      id: warningId,
      sessionId: row.session_id,
      seq: row.seq,
      ts: migratedAt,
      tsSource: 'ingest',
      source: { provider, channel: 'salidium' },
      kind: 'ingest.warning',
      code: 'malformed-record',
      detail: `historical ${row.kind} had a non-canonical timestamp and was quarantined during migration`,
    };
    updateEvent.run(
      warningId,
      migratedAt,
      'ingest.warning',
      JSON.stringify(warning),
      row.session_id,
      row.seq,
    );
    affected.add(row.session_id);
  }

  const updateChange = db.prepare(
    'UPDATE changes SET ts = ?, json = ?, reducer_version = NULL WHERE session_id = ? AND seq = ? AND ordinal = ?',
  );
  for (const unknownRow of db
    .prepare('SELECT session_id, seq, ordinal, ts, json FROM changes')
    .iterate()) {
    const row = unknownRow as unknown as {
      session_id: string;
      seq: number;
      ordinal: number;
      ts: string;
      json: string;
    };
    let change: Record<string, unknown>;
    try {
      change = JSON.parse(row.json) as Record<string, unknown>;
    } catch {
      change = {};
    }
    const ts = canonicalizeTimestamp(change.ts ?? row.ts) ?? migratedAt;
    change.ts = ts;
    updateChange.run(ts, JSON.stringify(change), row.session_id, row.seq, row.ordinal);
  }

  const updateSession = db.prepare(
    'UPDATE sessions SET started_at = ?, last_event_at = ?, ended_at = ?, summary_json = ?, updated_at = ? WHERE id = ?',
  );
  for (const unknownRow of db
    .prepare(
      'SELECT id, started_at, last_event_at, ended_at, summary_json, updated_at FROM sessions',
    )
    .iterate()) {
    const row = unknownRow as unknown as {
      id: string;
      started_at: string | null;
      last_event_at: string | null;
      ended_at: string | null;
      summary_json: string;
      updated_at: string;
    };
    let summary: Record<string, unknown>;
    try {
      summary = JSON.parse(row.summary_json) as Record<string, unknown>;
    } catch {
      summary = {};
    }
    const fields = [
      ['startedAt', row.started_at],
      ['lastEventAt', row.last_event_at],
      ['endedAt', row.ended_at],
    ] as const;
    const canonical: Record<string, string | null> = {};
    for (const [jsonKey, column] of fields) {
      const value = canonicalizeTimestamp(summary[jsonKey] ?? column);
      if (value) summary[jsonKey] = value;
      else delete summary[jsonKey];
      canonical[jsonKey] = value ?? null;
    }
    // `sessions` is a cache and older summaries predate the epistemic field on verification
    // evidence. Keeping an invalid optional object can make the entire list/search wire payload
    // fail current validation before the session is ever loaded and rederived. Preserve it only
    // when the complete current shape (including a canonical instant) is valid.
    if (summary.lastVerification && typeof summary.lastVerification === 'object') {
      const verification = summary.lastVerification as Record<string, unknown>;
      const at = canonicalizeTimestamp(verification.at);
      if (at) verification.at = at;
      const parsed = SessionSummarySchema.shape.lastVerification.safeParse(verification);
      if (!parsed.success) delete summary.lastVerification;
    } else if (summary.lastVerification !== undefined) {
      delete summary.lastVerification;
    }
    updateSession.run(
      canonical.startedAt ?? null,
      canonical.lastEventAt ?? null,
      canonical.endedAt ?? null,
      JSON.stringify(summary),
      canonicalizeTimestamp(row.updated_at) ?? migratedAt,
      row.id,
    );
  }

  // Event ids and timestamps are replay inputs. Never leave a checkpoint made from pre-migration
  // inputs in place; change rows are marked stale above and rebuilt by SessionCoordinator.
  db.exec('DELETE FROM checkpoints');
  for (const sessionId of affected)
    db.prepare('UPDATE changes SET reducer_version = NULL WHERE session_id = ?').run(sessionId);
  const enqueue = db.prepare(`INSERT INTO reingest_jobs
    (path, session_id, provider, agent_id, parser_revision, status, attempts, requested_at,
     started_at, completed_at, error)
    VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL)
    ON CONFLICT(path) DO UPDATE SET
      session_id=excluded.session_id,
      provider=excluded.provider,
      agent_id=excluded.agent_id,
      parser_revision=excluded.parser_revision,
      status='queued',
      attempts=0,
      requested_at=excluded.requested_at,
      started_at=NULL,
      completed_at=NULL,
      error=NULL`);
  for (const unknownSource of db
    .prepare('SELECT path, session_id, provider, agent_id FROM sources ORDER BY path')
    .iterate()) {
    const source = unknownSource as unknown as {
      path: string;
      session_id: string;
      provider: string;
      agent_id: string | null;
    };
    enqueue.run(
      source.path,
      source.session_id,
      source.provider,
      source.agent_id,
      INGEST_PARSER_REVISION,
      migratedAt,
    );
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_2_migrated_at',
    migratedAt,
  );
}

/** Schema 3 keys fingerprints by immutable event identity, not a reusable file location. */
function migrateToSchema3(db: DatabaseSync): void {
  const info = db.prepare("PRAGMA table_info('raw_record_fingerprints')").all() as Array<{
    name: string;
    pk: number;
  }>;
  const primaryKey = info
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name)
    .join(',');
  if (primaryKey !== 'path,line') return;
  db.exec(`
    DROP INDEX IF EXISTS raw_fingerprints_by_event;
    DROP INDEX IF EXISTS raw_fingerprints_by_location;
    ALTER TABLE raw_record_fingerprints RENAME TO raw_record_fingerprints_v2;
    CREATE TABLE raw_record_fingerprints (
      path TEXT NOT NULL,
      line INTEGER NOT NULL,
      record_hash TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('ingest', 'backfill')),
      session_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      PRIMARY KEY (session_id, event_id)
    ) WITHOUT ROWID;
    CREATE INDEX raw_fingerprints_by_location ON raw_record_fingerprints(path, line);
    INSERT OR IGNORE INTO raw_record_fingerprints
      (path, line, record_hash, captured_at, origin, session_id, event_id)
      SELECT path, line, record_hash, captured_at, origin, session_id, event_id
        FROM raw_record_fingerprints_v2;
    DROP TABLE raw_record_fingerprints_v2;
  `);
}

/** Schema 4 quarantines historical rows that no longer satisfy the complete event contract. */
function migrateToSchema4(db: DatabaseSync, migratedAt = new Date().toISOString()): void {
  const update = db.prepare(
    'UPDATE events SET event_id = ?, ts = ?, kind = ?, json = ? WHERE session_id = ? AND seq = ?',
  );
  const affected = new Set<string>();
  for (const unknownRow of db
    .prepare(
      'SELECT session_id, seq, event_id, ts, kind, json FROM events ORDER BY session_id, seq',
    )
    .iterate()) {
    const row = unknownRow as unknown as {
      session_id: string;
      seq: number;
      event_id: string;
      ts: string;
      kind: string;
      json: string;
    };
    let event: Record<string, unknown> = {};
    try {
      event = JSON.parse(row.json) as Record<string, unknown>;
    } catch {
      /* the invalid row is replaced below */
    }
    if (StoredEventWireSchema.safeParse(event).success) continue;
    const source =
      event.source && typeof event.source === 'object'
        ? (event.source as Record<string, unknown>)
        : undefined;
    const sessionProvider = row.session_id.slice(0, row.session_id.indexOf(':'));
    const providerCandidate = source?.provider ?? sessionProvider;
    const provider = ProviderIdSchema.safeParse(providerCandidate).success
      ? (providerCandidate as string)
      : 'claude-code';
    const timestamp = canonicalizeTimestamp(event.ts ?? row.ts) ?? migratedAt;
    const warningId = `${row.event_id}:migration-invalid-shape:${row.seq}`;
    const warning = {
      id: warningId,
      sessionId: row.session_id,
      seq: row.seq,
      ts: timestamp,
      tsSource: 'ingest',
      source: { provider, channel: 'salidium' },
      kind: 'ingest.warning',
      code: 'malformed-record',
      detail: `historical ${row.kind} failed the current event contract and was quarantined during migration`,
    };
    update.run(
      warningId,
      timestamp,
      'ingest.warning',
      JSON.stringify(warning),
      row.session_id,
      row.seq,
    );
    affected.add(row.session_id);
  }
  const invalidateChanges = db.prepare(
    'UPDATE changes SET reducer_version = NULL WHERE session_id = ?',
  );
  const invalidateCheckpoints = db.prepare('DELETE FROM checkpoints WHERE session_id = ?');
  for (const sessionId of affected) {
    invalidateChanges.run(sessionId);
    invalidateCheckpoints.run(sessionId);
  }
}

/** Schema 5 recovers repairable file evidence even when an old tail cursor row was lost. */
function migrateToSchema5(db: DatabaseSync, migratedAt = new Date().toISOString()): void {
  const enqueueMissing = db.prepare(`INSERT INTO reingest_jobs
      (path, session_id, provider, agent_id, parser_revision, status, attempts, requested_at,
       started_at, completed_at, error)
      VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL)
      ON CONFLICT(path) DO NOTHING`);
  for (const source of eventReferencedSources(db))
    enqueueMissing.run(
      source.path,
      source.sessionId,
      source.provider,
      source.agentId ?? null,
      INGEST_PARSER_REVISION,
      migratedAt,
    );
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_5_migrated_at',
    migratedAt,
  );
}

/** Adds an empty, disabled sync foundation. Historical sessions are never enrolled implicitly. */
function migrateToSchema6(db: DatabaseSync, migratedAt = new Date().toISOString()): void {
  db.exec(SCHEMA_6_DDL);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_6_migrated_at',
    migratedAt,
  );
}

/** How many rows the session list asks for when nobody says otherwise. */
export const SESSION_PAGE = 500;

/**
 * A window over the sessions a reader could want, and the two numbers that say what it is a window
 * *of*. `matched` counts the whole matched set, `total` every user session in the store; `sessions`
 * is the newest `limit` of the matched set. All three are counted, none is derived from another.
 */
/*
 * One predicate for "a session a person might want to read", shared by the search and its count so
 * the rows and the number can never be answers to different questions.
 *
 * The title marker is here as well as the `internal` flag because older explainer sessions can be
 * persisted before their first turn sets the flag. Counting on the flag alone can therefore print
 * a total containing rows the panel will never show.
 *
 * `instr`, not `LIKE`, everywhere: LIKE reads `_` and `%` as wildcards and these fields are full of
 * paths. `instr` matches the literal-substring behavior the UI defines.
 */
const REAL_SESSION = `COALESCE(json_extract(summary_json, '$.internal'), 0) = 0
       AND instr(COALESCE(title, ''), '[salidium-explainer]') = 0`;

/*
 * Every typed word has to appear somewhere in the row's name, repo, path or provider session id —
 * the same conjunction, over the same four fields, that the list's own matcher used when this ran
 * in the browser. The id is in there because it is the only thing a "Nothing recorded" row shows,
 * so leaving it out would make the one group a reader has to search the one group they cannot.
 *
 * Terms arrive as a JSON array so the statement text is fixed however many words were typed, and
 * are lowercased by the caller. SQLite's `lower()` is ASCII-only, so casing rules for arbitrary
 * user text remain a limitation rather than an implied Unicode guarantee.
 */
const MATCHES_TERMS = `NOT EXISTS (
             SELECT 1 FROM json_each(?)
              WHERE instr(
                      lower(COALESCE(title, '') || ' ' || COALESCE(repo_root, '') || ' ' ||
                            COALESCE(cwd, '') || ' ' || provider_session_id),
                      json_each.value) = 0)`;

export class SqliteStore implements SalidiumStore {
  private readonly db: DatabaseSync;
  private readonly stmts;

  /**
   * `readOnly` opens the store for inspection: no DDL, no migration, no write lock taken against a
   * daemon that is running. It exists for `salidium audit-claims`, and it is the default posture
   * anything diagnostic should have — a command whose whole job is to report on the store has no
   * business creating tables in it, and a read-write handle alongside the live daemon contends for
   * locks on a database the app is actively writing.
   */
  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    if (opts.readOnly) {
      if (!existsSync(path)) throw new Error(`no store at ${path}`);
      this.db = new DatabaseSync(path, { readOnly: true });
      try {
        rejectNewerSchema(this.db);
        const version = existingSchemaVersion(this.db);
        if (version === undefined || version < SCHEMA_VERSION)
          throw new Error(
            `Salidium store schema ${version ?? 'unknown'} requires an offline daemon upgrade to ${SCHEMA_VERSION}`,
          );
      } catch (err) {
        this.db.close();
        throw err;
      }
      this.stmts = this.prepareAll();
      return;
    }
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    // Existing stores can predate the private-mode rule. Repair on every read-write open rather
    // than relying on the creation mode, before any new session data is committed.
    chmodSync(path, 0o600);
    let priorVersion: number | undefined;
    let hadLegacyTables = false;
    try {
      rejectNewerSchema(this.db);
      priorVersion = existingSchemaVersion(this.db);
      hadLegacyTables = Boolean(
        this.db
          .prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name='events'")
          .get(),
      );
    } catch (err) {
      this.db.close();
      throw err;
    }
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA foreign_keys = ON;',
    );
    this.db.exec(DDL);
    if (priorVersion === undefined && !hadLegacyTables) this.db.exec(SCHEMA_6_DDL);
    /*
     * The change log is derived, exactly as the state is, so it carries the version of the reducer
     * that wrote it. Without this a version bump invalidated checkpoints — state re-derived — and
     * left every historical session's History rail rendering entries the old rules produced, which
     * is a fix that reaches new sessions only. Added by ALTER for stores written before it existed;
     * rows from then carry NULL, which reads as stale and is rewritten on first load.
     */
    try {
      this.db.exec('ALTER TABLE changes ADD COLUMN reducer_version TEXT');
    } catch {
      /* already present */
    }
    if (
      (priorVersion !== undefined && priorVersion < SCHEMA_VERSION) ||
      (priorVersion === undefined && hadLegacyTables)
    ) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if ((priorVersion ?? 0) < 2) migrateToSchema2(this.db);
        if ((priorVersion ?? 0) < 3) migrateToSchema3(this.db);
        if ((priorVersion ?? 0) < 4) migrateToSchema4(this.db);
        if ((priorVersion ?? 0) < 5) migrateToSchema5(this.db);
        if ((priorVersion ?? 0) < 6) migrateToSchema6(this.db);
        this.db.exec('COMMIT');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* COMMIT itself may have failed after ending the transaction */
        }
        this.db.close();
        throw error;
      }
      // The offline migration can invalidate hundreds of megabytes of old checkpoints. Reclaim
      // the WAL immediately so the first upgraded launch does not temporarily require both the
      // old database and an equally large recovery log.
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run('schema_version', String(SCHEMA_VERSION));
    this.stmts = this.prepareAll();
  }

  private prepareAll() {
    return {
      insertEvent: this.db.prepare(
        'INSERT OR IGNORE INTO events (session_id, seq, event_id, ts, kind, agent_id, turn_id, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      insertChange: this.db.prepare(
        'INSERT OR IGNORE INTO changes (session_id, seq, ordinal, ts, facet, summary, epistemic, json, reducer_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      upsertSession:
        this.db.prepare(`INSERT INTO sessions (id, provider, provider_session_id, cwd, repo_root, title, status, started_at, last_event_at, ended_at, latest_seq, summary_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd, repo_root=excluded.repo_root, title=excluded.title, status=excluded.status, started_at=excluded.started_at, last_event_at=excluded.last_event_at, ended_at=excluded.ended_at, latest_seq=excluded.latest_seq, summary_json=excluded.summary_json, updated_at=excluded.updated_at`),
      insertCheckpoint: this.db.prepare(
        'INSERT OR REPLACE INTO checkpoints (session_id, seq, reducer_version, state_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ),
      pruneCheckpoints: this.db.prepare(
        'DELETE FROM checkpoints WHERE session_id = ? AND seq NOT IN (SELECT seq FROM checkpoints WHERE session_id = ? ORDER BY seq DESC LIMIT ?)',
      ),
      latestCheckpoint: this.db.prepare(
        'SELECT seq, reducer_version, state_json FROM checkpoints WHERE session_id = ? AND reducer_version = ? ORDER BY seq DESC LIMIT 1',
      ),
      checkpointAtOrBefore: this.db.prepare(
        'SELECT seq, reducer_version, state_json FROM checkpoints WHERE session_id = ? AND reducer_version = ? AND seq <= ? ORDER BY seq DESC LIMIT 1',
      ),
      deleteCheckpointAtSeq: this.db.prepare(
        'DELETE FROM checkpoints WHERE session_id = ? AND seq = ?',
      ),
      eventsAfter: this.db.prepare(
        'SELECT json FROM events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?',
      ),
      eventById: this.db.prepare('SELECT json FROM events WHERE session_id = ? AND event_id = ?'),
      eventIds: this.db.prepare('SELECT event_id FROM events WHERE session_id = ?'),
      latestSeq: this.db.prepare('SELECT MAX(seq) AS s FROM events WHERE session_id = ?'),
      changesBefore: this.db.prepare(
        'SELECT json FROM changes WHERE session_id = ? AND seq <= ? ORDER BY ts DESC, seq DESC, ordinal DESC LIMIT ?',
      ),
      changesRange: this.db.prepare(
        'SELECT json FROM changes WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY ts ASC, seq ASC, ordinal ASC',
      ),
      /*
       * Salidium's own explainer calls are excluded in SQL, not after the fact, because the limit
       * has to apply to sessions a person might want to read. Explainer sessions can accumulate
       * faster than user sessions, so taking the newest rows and filtering afterward can hide a
       * substantial portion of the user's work.
       *
       * The cap is still right for the default view, but a *query* has to reach the whole store, so
       * matching happens here rather than over whatever page the browser was served.
       *
       * `, id DESC` because SQLite's order among equal timestamps is unspecified: without a
       * tiebreak two fetches of the same query can differ at the LIMIT boundary.
       *
       * The query currently scans sessions and uses a temporary order because the available index
       * is on `last_event_at`, not its COALESCE expression. Paging and indexing need reevaluation as
       * stores grow.
       */
      searchSessions: this.db.prepare(
        `SELECT summary_json FROM sessions
           WHERE ${REAL_SESSION}
             AND ${MATCHES_TERMS}
           ORDER BY COALESCE(last_event_at, started_at) DESC, id DESC
           LIMIT ?`,
      ),
      /** The same predicate, counted rather than windowed: what the list is a window of. */
      countSessions: this.db.prepare(
        `SELECT COUNT(*) AS n FROM sessions WHERE ${REAL_SESSION} AND ${MATCHES_TERMS}`,
      ),
      session: this.db.prepare('SELECT summary_json FROM sessions WHERE id = ?'),
      upsertSource:
        this.db.prepare(`INSERT INTO sources (path, session_id, provider, agent_id, inode, byte_offset, line_no, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET session_id=excluded.session_id, provider=excluded.provider, agent_id=excluded.agent_id, inode=excluded.inode, byte_offset=excluded.byte_offset, line_no=excluded.line_no, updated_at=excluded.updated_at`),
      source: this.db.prepare(
        'SELECT path, session_id, provider, agent_id, inode, byte_offset, line_no FROM sources WHERE path = ?',
      ),
      sourcesForSession: this.db.prepare(
        'SELECT path, session_id, provider, agent_id, inode, byte_offset, line_no FROM sources WHERE session_id = ?',
      ),
      deleteSession: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
      deleteEvents: this.db.prepare('DELETE FROM events WHERE session_id = ?'),
      deleteChanges: this.db.prepare('DELETE FROM changes WHERE session_id = ?'),
      deleteCheckpoints: this.db.prepare('DELETE FROM checkpoints WHERE session_id = ?'),
      deleteSources: this.db.prepare('DELETE FROM sources WHERE session_id = ?'),
      deleteAllSources: this.db.prepare('DELETE FROM sources'),
      allSources: this.db.prepare(
        'SELECT path, session_id, provider, agent_id, inode, byte_offset, line_no FROM sources',
      ),
      countEvents: this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?'),
      sessionIdsByInternal: this.db.prepare(
        `SELECT id FROM sessions WHERE COALESCE(json_extract(summary_json, '$.internal'), 0) = ?`,
      ),
      /*
       * One session's token totals, folded the way the reducer folds them.
       *
       * `agent.usage` is emitted per transcript record, and one API response is stamped onto every
       * record it was split across, so a plain SUM counts a response once per content block. The
       * window takes the LAST row per (session, lane, response), which is the
       * complete one: figures only ever grow across a response's records, so last is also max.
       *
       * Driven one session at a time rather than as a single join over `events`, because
       * `events_by_kind` is (session_id, kind): the join has no session to anchor on and degrades
       * to a full scan.
       */
      usageForSession: this.db.prepare(
        `SELECT COUNT(*) AS messages,
                COALESCE(SUM(inp), 0) AS inputTokens, COALESCE(SUM(outp), 0) AS outputTokens,
                COALESCE(SUM(cr), 0) AS cacheReadTokens, COALESCE(SUM(cw), 0) AS cacheWriteTokens
           FROM (
             SELECT json_extract(json, '$.inputTokens') AS inp,
                    json_extract(json, '$.outputTokens') AS outp,
                    json_extract(json, '$.cacheReadTokens') AS cr,
                    json_extract(json, '$.cacheWriteTokens') AS cw,
                    ROW_NUMBER() OVER (
                      PARTITION BY COALESCE(json_extract(json, '$.agentId'), 'main'),
                                   json_extract(json, '$.messageId')
                      ORDER BY seq DESC) AS rn
               FROM events WHERE session_id = ? AND kind = 'agent.usage'
           ) WHERE rn = 1`,
      ),
      usageRollup: this.db.prepare(
        'SELECT messages, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage_rollups WHERE internal = ?',
      ),
      addUsageRollup: this.db.prepare(`INSERT INTO usage_rollups
          (internal, messages, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(internal) DO UPDATE SET
            messages=messages+excluded.messages,
            input_tokens=input_tokens+excluded.input_tokens,
            output_tokens=output_tokens+excluded.output_tokens,
            cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,
            cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens`),
      agentText: this.db.prepare(
        "SELECT session_id, kind, json FROM events WHERE kind IN ('agent.message','turn.ended') ORDER BY session_id, seq",
      ),
      staleChangeCount: this.db.prepare(
        'SELECT COUNT(*) AS n FROM changes WHERE session_id = ? AND (reducer_version IS NULL OR reducer_version <> ?)',
      ),
      upsertFingerprint: this.db.prepare(`INSERT INTO raw_record_fingerprints
          (path, line, record_hash, captured_at, origin, session_id, event_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, event_id) DO UPDATE SET
            record_hash=excluded.record_hash,
            captured_at=excluded.captured_at,
            origin=CASE WHEN raw_record_fingerprints.origin = 'ingest' THEN 'ingest' ELSE excluded.origin END,
            session_id=excluded.session_id,
            event_id=excluded.event_id`),
      fingerprint: this.db.prepare(
        'SELECT path, line, record_hash, captured_at, origin, session_id, event_id FROM raw_record_fingerprints WHERE session_id = ? AND event_id = ? AND path = ? AND line = ?',
      ),
      fingerprintConflict: this.db.prepare(`INSERT INTO raw_fingerprint_conflicts
          (path, line, candidate_hash, captured_at, session_id, event_id, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?)`),
      enqueueReingest: this.db.prepare(`INSERT INTO reingest_jobs
          (path, session_id, provider, agent_id, parser_revision, status, attempts, requested_at, started_at, completed_at, error)
          VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL)
          ON CONFLICT(path) DO UPDATE SET
            session_id=excluded.session_id,
            provider=excluded.provider,
            agent_id=excluded.agent_id,
            parser_revision=excluded.parser_revision,
            status='queued',
            attempts=0,
            requested_at=excluded.requested_at,
            started_at=NULL,
            completed_at=NULL,
            error=NULL`),
      pendingReingest: this.db.prepare(
        "SELECT id, path, session_id, provider, agent_id, parser_revision, status, attempts, requested_at, error FROM reingest_jobs WHERE status IN ('queued', 'running', 'missing', 'failed') ORDER BY requested_at, id",
      ),
      allReingest: this.db.prepare(
        'SELECT id, path, session_id, provider, agent_id, parser_revision, status, attempts, requested_at, error FROM reingest_jobs ORDER BY requested_at, id',
      ),
      startReingest: this.db.prepare(
        "UPDATE reingest_jobs SET status='running', attempts=attempts+1, started_at=?, completed_at=NULL, error=NULL WHERE id = ?",
      ),
      finishReingest: this.db.prepare(
        'UPDATE reingest_jobs SET status=?, completed_at=?, error=? WHERE id = ?',
      ),
      pinSession: this.db.prepare(
        'INSERT OR REPLACE INTO session_pins (session_id, pinned_at) VALUES (?, ?)',
      ),
      unpinSession: this.db.prepare('DELETE FROM session_pins WHERE session_id = ?'),
      isPinned: this.db.prepare('SELECT 1 AS yes FROM session_pins WHERE session_id = ?'),
      pinnedSessionIds: this.db.prepare('SELECT session_id FROM session_pins'),
      tombstone: this.db.prepare(
        'SELECT deleted_at, cutoff, reason FROM session_tombstones WHERE session_id = ?',
      ),
      insertTombstone: this.db.prepare(`INSERT OR REPLACE INTO session_tombstones
          (session_id, deleted_at, cutoff, reason) VALUES (?, ?, ?, ?)`),
      retentionCandidates: this.db.prepare(
        `SELECT s.id, s.title, s.last_event_at, s.started_at,
                (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS event_count,
                (SELECT COALESCE(SUM(length(json)), 0) FROM events e WHERE e.session_id = s.id) +
                (SELECT COALESCE(SUM(length(json)), 0) FROM changes c WHERE c.session_id = s.id) +
                (SELECT COALESCE(SUM(length(state_json)), 0) FROM checkpoints p WHERE p.session_id = s.id)
                  AS bytes
           FROM sessions s
          WHERE COALESCE(s.last_event_at, s.started_at) < ?
            AND s.status NOT IN ('working', 'waiting')
            AND NOT EXISTS (SELECT 1 FROM session_pins p WHERE p.session_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM json_each(?) x WHERE x.value = s.id)
          ORDER BY COALESCE(s.last_event_at, s.started_at), s.id
          LIMIT ?`,
      ),
      deleteEventsRetained: this.db.prepare('DELETE FROM events WHERE session_id = ?'),
      deleteChangesRetained: this.db.prepare('DELETE FROM changes WHERE session_id = ?'),
      deleteCheckpointsRetained: this.db.prepare('DELETE FROM checkpoints WHERE session_id = ?'),
      deleteFingerprintsRetained: this.db.prepare(
        'DELETE FROM raw_record_fingerprints WHERE session_id = ?',
      ),
      deleteFingerprintConflictsRetained: this.db.prepare(
        'DELETE FROM raw_fingerprint_conflicts WHERE session_id = ?',
      ),
      deleteSessionRetained: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
    };
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  insertEvents(events: StoredEvent[]): void {
    for (const e of events)
      this.stmts.insertEvent.run(
        e.sessionId,
        e.seq,
        e.id,
        e.ts,
        e.kind,
        e.agentId ?? null,
        e.turnId ?? null,
        JSON.stringify(e),
      );
  }

  insertChanges(changes: SemanticChange[], reducerVersion: string): void {
    for (const c of changes)
      this.stmts.insertChange.run(
        c.sessionId,
        c.seq,
        c.ordinal,
        c.ts,
        c.facet,
        c.summary,
        c.epistemic,
        JSON.stringify(c),
        reducerVersion,
      );
  }

  /**
   * Whether this session's stored change log was written by a different reducer than the one
   * running. A `NULL` version is a row from before the column existed, and counts as stale.
   */
  changeLogIsStale(sessionId: string, reducerVersion: string): boolean {
    const r = this.stmts.staleChangeCount.get(sessionId, reducerVersion) as
      | { n: number }
      | undefined;
    return (r?.n ?? 0) > 0;
  }

  /** Drops a session's checkpoints, so the next load replays its whole event log. */
  deleteCheckpoints(sessionId: string): void {
    this.stmts.deleteCheckpoints.run(sessionId);
  }

  /** Replaces a session's whole change log in one transaction. */
  replaceChanges(sessionId: string, changes: SemanticChange[], reducerVersion: string): void {
    this.transaction(() => {
      this.stmts.deleteChanges.run(sessionId);
      this.insertChanges(changes, reducerVersion);
    });
  }

  upsertSession(summary: SessionSummary): void {
    this.stmts.upsertSession.run(
      summary.id,
      summary.provider,
      summary.providerSessionId,
      summary.cwd,
      summary.repoRoot ?? null,
      summary.title ?? null,
      summary.status,
      summary.startedAt ?? null,
      summary.lastEventAt ?? null,
      summary.endedAt ?? null,
      summary.latestSeq,
      JSON.stringify(summary),
      new Date().toISOString(),
    );
  }

  saveCheckpoint(
    sessionId: string,
    seq: number,
    reducerVersion: string,
    state: RunState,
    keep = 6,
  ): void {
    this.stmts.insertCheckpoint.run(
      sessionId,
      seq,
      reducerVersion,
      encodeCheckpoint(state),
      new Date().toISOString(),
    );
    this.stmts.pruneCheckpoints.run(sessionId, sessionId, keep);
  }

  latestCheckpoint(sessionId: string, reducerVersion: string): CheckpointRow | undefined {
    const row = this.stmts.latestCheckpoint.get(sessionId, reducerVersion) as
      | { seq: number; reducer_version: string; state_json: string }
      | undefined;
    if (!row) return undefined;
    try {
      return {
        seq: row.seq,
        reducerVersion: row.reducer_version,
        state: decodeCheckpoint(row.state_json),
      };
    } catch {
      // A checkpoint is a cache, never the source of truth. Quarantine a corrupt cache row and let
      // SessionCoordinator replay the event log instead of making the whole daemon unstartable.
      try {
        this.stmts.deleteCheckpointAtSeq.run(sessionId, row.seq);
      } catch {
        /* a read-only inspector still falls back without attempting repair */
      }
      return undefined;
    }
  }

  checkpointAtOrBefore(
    sessionId: string,
    reducerVersion: string,
    seq: number,
  ): CheckpointRow | undefined {
    const row = this.stmts.checkpointAtOrBefore.get(sessionId, reducerVersion, seq) as
      | { seq: number; reducer_version: string; state_json: string }
      | undefined;
    if (!row) return undefined;
    try {
      return {
        seq: row.seq,
        reducerVersion: row.reducer_version,
        state: decodeCheckpoint(row.state_json),
      };
    } catch {
      try {
        this.stmts.deleteCheckpointAtSeq.run(sessionId, row.seq);
      } catch {
        /* read-only */
      }
      return undefined;
    }
  }

  eventsAfter(
    sessionId: string,
    afterSeq: number,
    untilSeq = Number.MAX_SAFE_INTEGER,
    limit = 100_000,
  ): StoredEvent[] {
    const rows = this.stmts.eventsAfter.all(sessionId, afterSeq, untilSeq, limit) as Array<{
      json: string;
    }>;
    return rows.map((r) => JSON.parse(r.json) as StoredEvent);
  }

  eventById(sessionId: string, eventId: string): StoredEvent | undefined {
    const row = this.stmts.eventById.get(sessionId, eventId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as StoredEvent) : undefined;
  }

  eventIds(sessionId: string): string[] {
    return (this.stmts.eventIds.all(sessionId) as Array<{ event_id: string }>).map(
      (r) => r.event_id,
    );
  }

  latestSeq(sessionId: string): number {
    const row = this.stmts.latestSeq.get(sessionId) as { s: number | null } | undefined;
    return row?.s ?? -1;
  }

  countEvents(sessionId: string): number {
    return (this.stmts.countEvents.get(sessionId) as { n: number } | undefined)?.n ?? 0;
  }

  changesBefore(sessionId: string, beforeSeq: number, limit: number): SemanticChange[] {
    const rows = this.stmts.changesBefore.all(sessionId, beforeSeq, limit) as Array<{
      json: string;
    }>;
    return rows.map((r) => JSON.parse(r.json) as SemanticChange).reverse();
  }

  changesRange(sessionId: string, afterSeq: number, untilSeq: number): SemanticChange[] {
    const rows = this.stmts.changesRange.all(sessionId, afterSeq, untilSeq) as Array<{
      json: string;
    }>;
    return rows.map((r) => JSON.parse(r.json) as SemanticChange);
  }

  /**
   * Every agent message and final turn message in the store, oldest first, grouped by session.
   *
   * Purpose-built for `salidium audit-claims`, which has to see the whole store rather than the
   * window the UI has loaded: the API's session list is capped and filtered for a reader, and an
   * audit that silently measures the newest 500 sessions reports a number nobody can act on. It
   * reads only the two text fields the classifier consumes.
   */
  *agentMessagesBySession(): Generator<{ sessionId: string; messages: AuditMessageRow[] }> {
    let current: { sessionId: string; messages: AuditMessageRow[] } | undefined;
    // Streamed a session at a time rather than collected: a store of 40,000 messages is tens of
    // megabytes of prose, and a diagnostic that grows with the user's history is one that stops
    // working for exactly the people with the most to measure.
    for (const row of this.stmts.agentText.iterate()) {
      const r = row as unknown as { session_id: string; kind: string; json: string };
      const e = JSON.parse(r.json) as { text?: string; lastMessage?: string; phase?: string };
      const text = r.kind === 'agent.message' ? e.text : e.lastMessage;
      if (!text?.trim()) continue;
      if (current && current.sessionId !== r.session_id) {
        yield current;
        current = undefined;
      }
      if (!current) current = { sessionId: r.session_id, messages: [] };
      current.messages.push({
        text,
        phase: r.kind === 'turn.ended' || e.phase === 'final' ? 'final' : 'commentary',
      });
    }
    if (current) yield current;
  }

  /**
   * The newest `limit` user sessions matching every term, and the size of both sets it came out of.
   *
   * `terms` are already lowercased and non-empty; an empty array matches everything, which is the
   * default view. `matched` and `total` are counted separately rather than taken from a window
   * function over the rows, because `limit` 0 is a real request — the panel asks for the totals
   * alone while it is showing what it already holds — and a window function has no row to hang the
   * count on when no rows come back. Nothing can interleave between the three statements: one
   * writer, one synchronous connection, so they see one state of the store.
   */
  searchSessions(terms: string[], limit = SESSION_PAGE): SessionSearchResult {
    const bound = JSON.stringify(terms);
    const sessions =
      limit > 0
        ? (this.stmts.searchSessions.all(bound, limit) as Array<{ summary_json: string }>).map(
            (r) => JSON.parse(r.summary_json) as SessionSummary,
          )
        : [];
    const matched = (this.stmts.countSessions.get(bound) as { n: number }).n;
    // With no terms the two questions are the same question, so ask it once.
    const total =
      terms.length === 0 ? matched : (this.stmts.countSessions.get('[]') as { n: number }).n;
    return { sessions, matched, total };
  }

  listSessions(limit = SESSION_PAGE): SessionSummary[] {
    return (this.stmts.searchSessions.all('[]', limit) as Array<{ summary_json: string }>).map(
      (r) => JSON.parse(r.summary_json) as SessionSummary,
    );
  }

  /**
   * What the agent consumed, summed over every session on one side of the internal flag.
   *
   * Read from the store rather than from the coordinators the daemon happens to be holding. The
   * live set starts empty on every start and is evicted after 60 s idle, so a total taken from it
   * reported `undefined` almost always and reset on restart — which for a figure whose whole job
   * is to say what the explainer has cost is the one answer that is never useful.
   *
   * `undefined` when nothing was observed, so the surface can say nothing rather than a confident
   * zero. Tokens are observed; any figure in currency is arithmetic over a price table and belongs
   * to whatever renders it, not here.
   */
  usageTotals(internal: boolean): UsageTotals | undefined {
    const ids = this.stmts.sessionIdsByInternal.all(internal ? 1 : 0) as Array<{ id: string }>;
    const rolled = this.stmts.usageRollup.get(internal ? 1 : 0) as
      | {
          messages: number;
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_write_tokens: number;
        }
      | undefined;
    const total: UsageTotals = {
      messages: rolled?.messages ?? 0,
      inputTokens: rolled?.input_tokens ?? 0,
      outputTokens: rolled?.output_tokens ?? 0,
      cacheReadTokens: rolled?.cache_read_tokens ?? 0,
      cacheWriteTokens: rolled?.cache_write_tokens ?? 0,
    };
    for (const { id } of ids) {
      const row = this.stmts.usageForSession.get(id) as unknown as UsageTotals | undefined;
      if (!row) continue;
      total.messages += row.messages;
      total.inputTokens += row.inputTokens;
      total.outputTokens += row.outputTokens;
      total.cacheReadTokens += row.cacheReadTokens;
      total.cacheWriteTokens += row.cacheWriteTokens;
    }
    return total.messages > 0 ? total : undefined;
  }

  getSession(id: string): SessionSummary | undefined {
    const row = this.stmts.session.get(id) as { summary_json: string } | undefined;
    return row ? (JSON.parse(row.summary_json) as SessionSummary) : undefined;
  }

  /**
   * Captures the identity of a provider line even when its event id already exists. This sidecar is
   * what lets a parser upgrade strengthen old evidence without mutating the append-only event.
   */
  recordRawFingerprint(
    event: CanonicalEvent,
    origin: RawRecordFingerprint['origin'] = 'ingest',
  ): boolean {
    const ref = event.source.ref;
    if (!ref?.path || ref.line === undefined || !ref.recordHash) return false;
    const capturedAt = new Date().toISOString();
    const existing = this.eventById(event.sessionId, event.id);
    // Current adapters persist the hash inline for new events. The sidecar exists solely to
    // strengthen an already-durable legacy event; writing before that event exists creates a race
    // where a changed duplicate can replace the hash during write-behind.
    if (!existing) return false;
    if (!isDeepStrictEqual(comparableEvent(existing), comparableEvent(event))) {
      this.stmts.fingerprintConflict.run(
        ref.path,
        ref.line,
        ref.recordHash,
        capturedAt,
        event.sessionId,
        event.id,
        're-ingested provider record does not match the immutable stored event',
      );
      return false;
    }
    this.stmts.upsertFingerprint.run(
      ref.path,
      ref.line,
      ref.recordHash,
      capturedAt,
      origin,
      event.sessionId,
      event.id,
    );
    return true;
  }

  rawFingerprint(
    sessionId: string,
    eventId: string,
    path: string,
    line: number,
  ): RawRecordFingerprint | undefined {
    const row = this.stmts.fingerprint.get(sessionId, eventId, path, line) as
      | {
          path: string;
          line: number;
          record_hash: string;
          captured_at: string;
          origin: RawRecordFingerprint['origin'];
          session_id: string;
          event_id: string;
        }
      | undefined;
    return row
      ? {
          path: row.path,
          line: row.line,
          recordHash: row.record_hash,
          capturedAt: row.captured_at,
          origin: row.origin,
          sessionId: row.session_id,
          eventId: row.event_id,
        }
      : undefined;
  }

  enqueueReingest(source: SourceCursor, parserRevision = INGEST_PARSER_REVISION): number {
    this.stmts.enqueueReingest.run(
      source.path,
      source.sessionId,
      source.provider,
      source.agentId ?? null,
      parserRevision,
      new Date().toISOString(),
    );
    const row = this.db.prepare('SELECT id FROM reingest_jobs WHERE path = ?').get(source.path) as {
      id: number;
    };
    return row.id;
  }

  pendingReingestJobs(): ReingestJob[] {
    return this.mapReingestJobs(this.stmts.pendingReingest.all());
  }

  reingestJobs(): ReingestJob[] {
    return this.mapReingestJobs(this.stmts.allReingest.all());
  }

  private mapReingestJobs(rows: unknown[]): ReingestJob[] {
    return (
      rows as Array<{
        id: number;
        path: string;
        session_id: string;
        provider: string;
        agent_id: string | null;
        parser_revision: string;
        status: ReingestJob['status'];
        attempts: number;
        requested_at: string;
        error: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      path: row.path,
      sessionId: row.session_id,
      provider: row.provider,
      agentId: row.agent_id ?? undefined,
      parserRevision: row.parser_revision,
      status: row.status,
      attempts: row.attempts,
      requestedAt: row.requested_at,
      error: row.error ?? undefined,
    }));
  }

  startReingestJob(id: number): void {
    this.stmts.startReingest.run(new Date().toISOString(), id);
  }

  finishReingestJob(
    id: number,
    status: Extract<ReingestJob['status'], 'completed' | 'missing' | 'failed'>,
    error?: string,
  ): void {
    this.stmts.finishReingest.run(status, new Date().toISOString(), error ?? null, id);
  }

  retentionPolicy(): RetentionDays {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'retention_days'").get() as
      | { value?: string }
      | undefined;
    if (row?.value === '30' || row?.value === '90' || row?.value === '365')
      return Number(row.value) as 30 | 90 | 365;
    return 'forever';
  }

  setRetentionPolicy(policy: RetentionDays): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run('retention_days', String(policy));
  }

  pinSession(sessionId: string, pinned = true): boolean {
    if (!this.getSession(sessionId)) return false;
    if (pinned) this.stmts.pinSession.run(sessionId, new Date().toISOString());
    else this.stmts.unpinSession.run(sessionId);
    return true;
  }

  isSessionPinned(sessionId: string): boolean {
    return Boolean(this.stmts.isPinned.get(sessionId));
  }

  pinnedSessionIds(): string[] {
    return (this.stmts.pinnedSessionIds.all() as Array<{ session_id: string }>).map(
      (row) => row.session_id,
    );
  }

  isSessionTombstoned(sessionId: string): boolean {
    return Boolean(this.stmts.tombstone.get(sessionId));
  }

  retentionPreview(
    policy: RetentionDays = this.retentionPolicy(),
    now = new Date(),
    limit = Number.MAX_SAFE_INTEGER,
    excludeSessionIds: readonly string[] = [],
  ): RetentionPreview {
    if (policy === 'forever') return { policy, sessions: [], eventCount: 0, bytes: 0 };
    const cutoff = new Date(now.getTime() - policy * 24 * 60 * 60_000).toISOString();
    const rows = this.stmts.retentionCandidates.all(
      cutoff,
      JSON.stringify(excludeSessionIds),
      limit,
    ) as Array<{
      id: string;
      title: string | null;
      last_event_at: string | null;
      started_at: string | null;
      event_count: number;
      bytes: number;
    }>;
    const sessions = rows.map((row) => ({
      id: row.id,
      ...(row.title ? { title: row.title } : {}),
      ...((row.last_event_at ?? row.started_at)
        ? { lastEventAt: row.last_event_at ?? row.started_at ?? undefined }
        : {}),
      eventCount: row.event_count,
      bytes: row.bytes,
    }));
    return {
      policy,
      cutoff,
      sessions,
      eventCount: sessions.reduce((sum, row) => sum + row.eventCount, 0),
      bytes: sessions.reduce((sum, row) => sum + row.bytes, 0),
    };
  }

  /** Deletes complete inactive sessions only; sources and tombstones remain as anti-resurrection cursors. */
  applyRetention(
    policy: RetentionDays = this.retentionPolicy(),
    now = new Date(),
    batchSize = 50,
    excludeSessionIds: readonly string[] = [],
  ): RetentionPreview {
    const preview = this.retentionPreview(policy, now, batchSize, excludeSessionIds);
    if (policy === 'forever' || !preview.cutoff) return preview;
    const cutoff = preview.cutoff;
    this.transaction(() => {
      for (const row of preview.sessions) {
        const session = this.getSession(row.id);
        const usage = this.stmts.usageForSession.get(row.id) as unknown as UsageTotals | undefined;
        if (usage && usage.messages > 0)
          this.stmts.addUsageRollup.run(
            session?.internal || session?.title?.includes('[salidium-explainer]') ? 1 : 0,
            usage.messages,
            usage.inputTokens,
            usage.outputTokens,
            usage.cacheReadTokens,
            usage.cacheWriteTokens,
          );
        this.stmts.insertTombstone.run(row.id, now.toISOString(), cutoff, `retention:${policy}`);
        this.stmts.deleteEventsRetained.run(row.id);
        this.stmts.deleteChangesRetained.run(row.id);
        this.stmts.deleteCheckpointsRetained.run(row.id);
        this.stmts.deleteFingerprintsRetained.run(row.id);
        this.stmts.deleteFingerprintConflictsRetained.run(row.id);
        this.stmts.deleteSessionRetained.run(row.id);
      }
    });
    return preview;
  }

  /** Explicit Forget is immediate and keeps the same anti-resurrection tombstone as retention. */
  forgetSession(sessionId: string, now = new Date()): boolean {
    if (!this.getSession(sessionId)) return false;
    this.transaction(() => {
      this.stmts.insertTombstone.run(sessionId, now.toISOString(), now.toISOString(), 'forgotten');
      this.stmts.deleteEventsRetained.run(sessionId);
      this.stmts.deleteChangesRetained.run(sessionId);
      this.stmts.deleteCheckpointsRetained.run(sessionId);
      this.stmts.deleteFingerprintsRetained.run(sessionId);
      this.stmts.deleteFingerprintConflictsRetained.run(sessionId);
      this.stmts.deleteSessionRetained.run(sessionId);
      this.stmts.unpinSession.run(sessionId);
    });
    return true;
  }

  /** Offline space reclamation after bounded cleanup batches. */
  compact(): void {
    const integrity = () => {
      const row = this.db.prepare('PRAGMA integrity_check').get() as
        | Record<string, string>
        | undefined;
      return row ? Object.values(row)[0] : undefined;
    };
    const before = integrity();
    if (before !== 'ok') throw new Error(`refusing to compact a store that failed integrity_check`);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    const after = integrity();
    if (after !== 'ok') throw new Error(`compacted store failed integrity_check`);
  }

  /**
   * Forgets how far each session file was read, so the next backfill parses it from the start.
   *
   * A file whose inode and size still match its cursor is skipped entirely — that skip is what
   * makes a cold start of several hundred transcripts take milliseconds, and it also means a
   * finished session is frozen with whatever the adapter understood on the day it was first read.
   * When an adapter learns to recognise something new, every session already in the store keeps
   * the old, thinner reading of its own file forever.
   *
   * Re-reading is safe because event ids are deterministic per provider record: everything already
   * ingested dedupes away and only the newly recognised records land. It cannot un-emit an event a
   * previous adapter got wrong, and it cannot help a session whose provider file has since been
   * deleted; both are reported by the command rather than papered over.
   *
   * Returns the number of cursors cleared.
   */
  clearSourceCursors(sessionId?: string): number {
    const stmt = sessionId ? this.stmts.deleteSources : this.stmts.deleteAllSources;
    const info = sessionId ? stmt.run(sessionId) : stmt.run();
    return Number(info.changes ?? 0);
  }

  /** Every tail cursor in the store, for reporting what a re-read would cover. */
  allSources(): SourceCursor[] {
    const rows = this.stmts.allSources.all() as Array<{
      path: string;
      session_id: string;
      provider: string;
      agent_id: string | null;
      inode: number | null;
      byte_offset: number;
      line_no: number;
    }>;
    return rows.map((r) => ({
      path: r.path,
      sessionId: r.session_id,
      provider: r.provider,
      agentId: r.agent_id ?? undefined,
      inode: r.inode ?? undefined,
      byteOffset: r.byte_offset,
      lineNo: r.line_no,
    }));
  }

  /** Cursor rows first; event provenance fills only paths whose cursor was historically lost. */
  reingestSources(): SourceCursor[] {
    const byPath = new Map(this.allSources().map((source) => [source.path, source]));
    for (const source of eventReferencedSources(this.db))
      if (!byPath.has(source.path)) byPath.set(source.path, source);
    return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  upsertSource(c: SourceCursor): void {
    this.stmts.upsertSource.run(
      c.path,
      c.sessionId,
      c.provider,
      c.agentId ?? null,
      c.inode ?? null,
      c.byteOffset,
      c.lineNo,
      new Date().toISOString(),
    );
  }

  getSource(path: string): SourceCursor | undefined {
    const r = this.stmts.source.get(path) as
      | {
          path: string;
          session_id: string;
          provider: string;
          agent_id: string | null;
          inode: number | null;
          byte_offset: number;
          line_no: number;
        }
      | undefined;
    return r
      ? {
          path: r.path,
          sessionId: r.session_id,
          provider: r.provider,
          agentId: r.agent_id ?? undefined,
          inode: r.inode ?? undefined,
          byteOffset: r.byte_offset,
          lineNo: r.line_no,
        }
      : undefined;
  }

  sourcesForSession(sessionId: string): SourceCursor[] {
    const rows = this.stmts.sourcesForSession.all(sessionId) as Array<{
      path: string;
      session_id: string;
      provider: string;
      agent_id: string | null;
      inode: number | null;
      byte_offset: number;
      line_no: number;
    }>;
    return rows.map((r) => ({
      path: r.path,
      sessionId: r.session_id,
      provider: r.provider,
      agentId: r.agent_id ?? undefined,
      inode: r.inode ?? undefined,
      byteOffset: r.byte_offset,
      lineNo: r.line_no,
    }));
  }

  deleteSession(sessionId: string): void {
    this.forgetSession(sessionId);
  }

  close(): void {
    this.db.close();
  }
}

/** Default authoritative store factory; injected into the daemon at the composition root. */
export const createSqliteStore: SalidiumStoreFactory = (path, options) =>
  new SqliteStore(path, options ?? {});
