import type { DatabaseSync } from 'node:sqlite';
import { ProviderIdSchema, SessionSummarySchema, StoredEventWireSchema } from '@salidium/protocol';
import type { SourceCursor } from './salidiumStore.ts';
import {
  canonicalizeTimestamp,
  decodeEventJson,
  type EncodedJson,
  OPTIMIZED_STORE_PAGE_SIZE,
} from './sqliteEncoding.ts';

/**
 * Local SQLite persistence (node:sqlite, WAL). Events are the source of truth Salidium owns;
 * changes are the semantic history; checkpoints make cold loads fast; sessions is a cached
 * summary index for the list; sources track tail cursors so ingestion resumes exactly.
 *
 * All rows carry session_id so cross-session queries (project, provider, time) are cheap later.
 */
export const SCHEMA_VERSION = 8;

/** Parser contract written into durable re-ingestion jobs. Bump when record interpretation changes. */
export const INGEST_PARSER_REVISION = '2026-08-19.1';

export function existingSchemaVersion(db: DatabaseSync): number | undefined {
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

export function rejectNewerSchema(db: DatabaseSync): void {
  const version = existingSchemaVersion(db);
  if (version !== undefined && version > SCHEMA_VERSION)
    throw new Error(
      `Salidium store schema ${version} is newer than this version supports (${SCHEMA_VERSION})`,
    );
}

export const DDL = `
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
  updated_at TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0, 1)),
  activity_at TEXT NOT NULL DEFAULT ''
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
  json BLOB NOT NULL,
  PRIMARY KEY (session_id, seq)
);
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
  state_json BLOB NOT NULL,
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
export const SCHEMA_6_DDL = `
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

/**
 * Small, privacy-minimized local operations history. It contains aggregate counts and states only:
 * no session ids, provider paths, event bodies, prompts, or command output.
 */
export const SCHEMA_7_DDL = `
CREATE TABLE IF NOT EXISTS operations_health_samples (
  observed_at TEXT PRIMARY KEY,
  queue_files INTEGER,
  queue_bytes INTEGER,
  store_bytes INTEGER,
  active_gaps INTEGER NOT NULL,
  total_gaps INTEGER NOT NULL,
  daemon_state TEXT NOT NULL CHECK (daemon_state IN ('running', 'unresponsive', 'stopped')),
  collection_state TEXT NOT NULL CHECK (collection_state IN ('active', 'paused')),
  maintenance_phase TEXT
) WITHOUT ROWID;
`;

/**
 * Request-time reads must remain bounded as the archive grows. The usage ledger stores the newest
 * observation for each provider response, while `session_usage` is the small materialized total
 * read by settings. Explicit session columns keep the default list off JSON extraction and give
 * SQLite an index matching its filter and order.
 */
export const SCHEMA_8_DDL = `
CREATE INDEX IF NOT EXISTS sessions_internal_activity
  ON sessions(internal, activity_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS usage_messages (
  session_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  PRIMARY KEY (session_id, lane, message_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_usage (
  session_id TEXT PRIMARY KEY,
  messages INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS usage_backfill_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  rowid_cursor INTEGER NOT NULL DEFAULT 0,
  session_cursor TEXT NOT NULL DEFAULT '',
  seq_cursor INTEGER NOT NULL DEFAULT -1,
  scanned_events INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1))
);
`;

/**
 * Provider files can outlive their old `sources` cursor row. Event provenance remains durable, so
 * use it as a second recovery index instead of silently excluding those files from repair. Schema
 * 4 guarantees these event JSON values satisfy the current protocol before this query runs.
 */
export function eventReferencedSources(db: DatabaseSync): SourceCursor[] {
  const paths = new Map<string, { sessionId: string; provider: string; ambiguous: boolean }>();
  // Decode once per event. Repeating a JSON scalar function in GROUP BY, WHERE, SELECT, and HAVING
  // multiplied gzip work across the whole store during explicit re-ingestion inventory.
  for (const unknownRow of db.prepare('SELECT session_id, json FROM events').iterate()) {
    const row = unknownRow as unknown as { session_id: string; json: EncodedJson };
    const event = decodeEventJson(row.json);
    if (event.source.channel !== 'transcript' && event.source.channel !== 'rollout') continue;
    const path = event.source.ref?.path;
    if (!path) continue;
    const provider = event.source.provider;
    const existing = paths.get(path);
    if (!existing) paths.set(path, { sessionId: row.session_id, provider, ambiguous: false });
    else if (existing.sessionId !== row.session_id || existing.provider !== provider)
      existing.ambiguous = true;
  }
  return [...paths]
    .filter(([, value]) => !value.ambiguous)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, value]) => ({
      path,
      sessionId: value.sessionId,
      provider: value.provider,
      byteOffset: 0,
      lineNo: 0,
    }));
}

export function hasOptimizedStorageLayout(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")
    .get() as { sql?: string } | undefined;
  const page = db.prepare('PRAGMA page_size').get() as Record<string, number> | undefined;
  const pageSize = page ? Object.values(page)[0] : undefined;
  return Boolean(
    row?.sql &&
      !/WITHOUT\s+ROWID/i.test(row.sql) &&
      /json\s+BLOB\s+NOT\s+NULL/i.test(row.sql) &&
      pageSize === OPTIMIZED_STORE_PAGE_SIZE,
  );
}

export function eventsTableHasRowid(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")
    .get() as { sql?: string } | undefined;
  return !/WITHOUT\s+ROWID/i.test(row?.sql ?? '');
}

/**
 * Schema 2 separates same-record hook observations from transcript evidence and makes every
 * persisted timestamp safe for the strict wire schema. The migration is deliberately offline:
 * the daemon is the single writer and runs this before accepting hooks or opening the listener.
 */
export function migrateToSchema2(db: DatabaseSync): void {
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
export function migrateToSchema3(db: DatabaseSync): void {
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
export function migrateToSchema4(db: DatabaseSync, migratedAt = new Date().toISOString()): void {
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
export function migrateToSchema5(db: DatabaseSync, migratedAt = new Date().toISOString()): void {
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
export function migrateToSchema6(db: DatabaseSync, migratedAt = new Date().toISOString()): void {
  db.exec(SCHEMA_6_DDL);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_6_migrated_at',
    migratedAt,
  );
}

export function migrateToSchema7(db: DatabaseSync, migratedAt = new Date().toISOString()): void {
  db.exec(SCHEMA_7_DDL);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_7_migrated_at',
    migratedAt,
  );
}

/** Installs bounded read models without putting historical reconstruction on the startup path. */
export function migrateToSchema8(db: DatabaseSync, migratedAt = new Date().toISOString()): void {
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info('sessions')").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  if (!columns.has('internal'))
    db.exec(
      'ALTER TABLE sessions ADD COLUMN internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0, 1))',
    );
  if (!columns.has('activity_at'))
    db.exec("ALTER TABLE sessions ADD COLUMN activity_at TEXT NOT NULL DEFAULT ''");

  db.exec(SCHEMA_8_DDL);
  db.exec(`UPDATE sessions
              SET internal = CASE
                    WHEN COALESCE(json_extract(summary_json, '$.internal'), 0) = 1
                      OR instr(COALESCE(title, ''), '[salidium-explainer]') > 0 THEN 1
                    ELSE 0
                  END,
                  activity_at = COALESCE(last_event_at, started_at, '')`);

  // A 5 GB archive can take minutes to traverse even on an SSD. Mark it for the daemon's
  // resumable post-listen worker instead of making health and stop wait behind an offline scan.
  // Rebuilding is idempotent for a retry or a deliberately downgraded test store.
  db.exec(
    'DELETE FROM usage_messages; DELETE FROM session_usage; DELETE FROM usage_backfill_state;',
  );
  const hasEvents = Boolean(db.prepare('SELECT 1 AS yes FROM events LIMIT 1').get());
  db.prepare(`INSERT INTO usage_backfill_state
      (singleton, rowid_cursor, session_cursor, seq_cursor, scanned_events, complete)
      VALUES (1, 0, '', -1, 0, ?)`).run(hasEvents ? 0 : 1);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_8_migrated_at',
    migratedAt,
  );
}
