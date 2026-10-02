import { asObject, asString, safeJson } from '@salidium/adapter-kit';
import type { OpenCodeStoreConnection } from './storeAccess.ts';

/*
 * Typed reads over OpenCode 2.x's store. Every statement here goes through the restricted
 * connection; the shapes were verified against the pinned OpenCode 2.0.18.
 *
 * `session_message` holds one row per durable message: `user`, one `assistant` row per model step
 * (its tool calls and their results live inside it), `idle` closing a turn, plus `shell`,
 * `compaction`, `synthetic` and a few switch markers. `seq` is the per-session durable sequence of
 * the event that created the row. Rows are inserted early and updated in place while a step runs.
 */

export interface SessionRow {
  id: string;
  parentId?: string;
  forkSessionId?: string;
  directory: string;
  title?: string;
  version?: string;
  /** OpenCode's `{providerID, id}` model reference, as stored. */
  model?: { providerID?: string; id?: string };
  agent?: string;
  timeCreated: number;
  timeUpdated: number;
  timeIdle?: number;
}

export interface MessageRow {
  id: string;
  sessionId: string;
  type: string;
  seq: number;
  timeCreated: number;
  timeUpdated: number;
  /** Size of `data` in bytes. */
  size: number;
  /** The row's JSON text, absent when it exceeded the size ceiling and was not read. */
  data?: string;
}

const SESSION_COLUMNS =
  'id, parent_id, fork_session_id, directory, title, version, model, agent, time_created, time_updated, time_idle';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sessionRow(row: Record<string, unknown>): SessionRow | undefined {
  const id = str(row.id);
  const directory = str(row.directory);
  const timeCreated = num(row.time_created);
  if (!id || !directory || timeCreated === undefined) return undefined;
  const model = asObject(typeof row.model === 'string' ? safeJson(row.model) : undefined);
  return {
    id,
    parentId: str(row.parent_id),
    forkSessionId: str(row.fork_session_id),
    directory,
    title: str(row.title),
    version: str(row.version),
    model: model ? { providerID: asString(model.providerID), id: asString(model.id) } : undefined,
    agent: str(row.agent),
    timeCreated,
    timeUpdated: num(row.time_updated) ?? timeCreated,
    timeIdle: num(row.time_idle),
  };
}

function messageRow(row: Record<string, unknown>): MessageRow | undefined {
  const id = str(row.id);
  const sessionId = str(row.session_id);
  const type = str(row.type);
  const seq = num(row.seq);
  if (!id || !sessionId || !type || seq === undefined) return undefined;
  return {
    id,
    sessionId,
    type,
    seq,
    timeCreated: num(row.time_created) ?? 0,
    timeUpdated: num(row.time_updated) ?? 0,
    size: num(row.size) ?? 0,
    data: typeof row.data === 'string' ? row.data : undefined,
  };
}

export function readSessions(store: OpenCodeStoreConnection): SessionRow[] {
  return store
    .all(`SELECT ${SESSION_COLUMNS} FROM session_v2`)
    .flatMap((row) => sessionRow(row) ?? []);
}

export function readSession(store: OpenCodeStoreConnection, id: string): SessionRow | undefined {
  const row = store.get(`SELECT ${SESSION_COLUMNS} FROM session_v2 WHERE id = ?`, id);
  return row ? sessionRow(row) : undefined;
}

/** The last durable sequence number of every aggregate (sessions and projects). */
export function readSequences(store: OpenCodeStoreConnection): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of store.all('SELECT aggregate_id, seq FROM event_sequence')) {
    const id = str(row.aggregate_id);
    const seq = num(row.seq);
    if (id && seq !== undefined) out.set(id, seq);
  }
  return out;
}

/**
 * Message columns. `size` is the row's JSON in bytes (`length` of a TEXT value counts characters,
 * so the value is cast to a BLOB first), and `data` is returned only when it fits the ceiling,
 * which is the statement's first bound parameter.
 */
const MESSAGE_COLUMNS =
  'id, session_id, type, seq, time_created, time_updated, length(CAST(data AS BLOB)) AS size, CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data END AS data';

function ceiling(maxBytes: number): number {
  return Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
}

/**
 * Rows of one session after `afterSeq`, in sequence order, stopping at `limit` rows or once the
 * rows read hold `byteBudget` bytes (always at least one row, so progress is never blocked).
 */
export function readMessagesAfter(
  store: OpenCodeStoreConnection,
  sessionId: string,
  afterSeq: number,
  limit: number,
  maxBytes: number,
  byteBudget = Number.POSITIVE_INFINITY,
): { rows: MessageRow[]; bytes: number } {
  const rows: MessageRow[] = [];
  let bytes = 0;
  for (const raw of store.iterate(
    `SELECT ${MESSAGE_COLUMNS} FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    ceiling(maxBytes),
    sessionId,
    afterSeq,
    Math.max(1, Math.floor(limit)),
  )) {
    const row = messageRow(raw);
    if (!row) continue;
    rows.push(row);
    if (row.data !== undefined) bytes += row.size;
    if (bytes >= byteBudget) break;
  }
  return { rows, bytes };
}

export function readMessage(
  store: OpenCodeStoreConnection,
  id: string,
  maxBytes: number,
): MessageRow | undefined {
  const row = store.get(
    `SELECT ${MESSAGE_COLUMNS} FROM session_message WHERE id = ?`,
    ceiling(maxBytes),
    id,
  );
  return row ? messageRow(row) : undefined;
}

/** How many rows of the session sit at or below `seq`. A drop means OpenCode deleted rows. */
export function countMessagesThrough(
  store: OpenCodeStoreConnection,
  sessionId: string,
  seq: number,
): number {
  const row = store.get(
    'SELECT count(*) AS n FROM session_message WHERE session_id = ? AND seq <= ?',
    sessionId,
    seq,
  );
  return num(row?.n) ?? 0;
}

/** Whether a later `user` or `idle` row exists: a turn began or ended after `seq`. */
export function turnBoundaryAfter(
  store: OpenCodeStoreConnection,
  sessionId: string,
  seq: number,
): boolean {
  const row = store.get(
    "SELECT count(*) AS n FROM session_message WHERE session_id = ? AND seq > ? AND type IN ('user', 'idle')",
    sessionId,
    seq,
  );
  return (num(row?.n) ?? 0) > 0;
}

/** The highest row seq of the session at or below `seq`, or -1. */
export function maxSeqThrough(
  store: OpenCodeStoreConnection,
  sessionId: string,
  seq: number,
): number {
  const row = store.get(
    'SELECT max(seq) AS m FROM session_message WHERE session_id = ? AND seq <= ?',
    sessionId,
    seq,
  );
  return num(row?.m) ?? -1;
}

/** The newest row of a type strictly before `beforeSeq`, for turn context across polls. */
export function readLatestBefore(
  store: OpenCodeStoreConnection,
  sessionId: string,
  type: string,
  beforeSeq: number,
  maxBytes: number,
): MessageRow | undefined {
  const row = store.get(
    `SELECT ${MESSAGE_COLUMNS} FROM session_message WHERE session_id = ? AND type = ? AND seq < ? ORDER BY seq DESC LIMIT 1`,
    ceiling(maxBytes),
    sessionId,
    type,
    beforeSeq,
  );
  return row ? messageRow(row) : undefined;
}
