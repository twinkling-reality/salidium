import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  StoreCursor,
  StorePollBatch,
  StorePollRequest,
  StorePollResult,
  StoreRawRecord,
  StoreSource,
} from '@salidium/adapter-kit';
import {
  type CanonicalEvent,
  type EventSource,
  makeEventId,
  makeSessionId,
} from '@salidium/protocol';
import {
  assistantText,
  isCopiedForkRow,
  isFinalRow,
  mapMessage,
  mapSession,
  OPENCODE_PROVIDER_ID,
  parseRowData,
  recordHash,
  type SessionContext,
  stableSessionRecord,
  type TurnState,
} from './mapping.ts';
import {
  countMessagesThrough,
  maxSeqThrough,
  readLatestBefore,
  readMessage,
  readMessagesAfter,
  readSequences,
  readSession,
  readSessions,
  type SessionRow,
} from './records.ts';
import { withOpenCodeStore } from './storeAccess.ts';

/** Ceiling for one row read during a raw re-read; matches the daemon's ingest ceiling. */
const RAW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Where OpenCode keeps its store: `$XDG_DATA_HOME/opencode/opencode.db`, else
 * `~/.local/share/opencode/opencode.db` (on macOS too). A relative XDG_DATA_HOME is ignored, as
 * the XDG specification requires.
 */
export function openCodeStorePath(userHome: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(userHome, '.local', 'share');
  return join(base, 'opencode', 'opencode.db');
}

export function cursorKey(storePath: string, sessionId: string): string {
  return `${storePath}#${sessionId}`;
}

function inodeOf(path: string): number | undefined {
  try {
    const ino = statSync(path).ino;
    return ino > 0 ? ino : undefined;
  } catch {
    return undefined;
  }
}

/** Root of a session's parent chain; a missing parent or a cycle stops the walk. */
function rootOf(session: SessionRow, byId: ReadonlyMap<string, SessionRow>): SessionRow {
  let current = session;
  const seen = new Set<string>([current.id]);
  while (current.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

function depth(session: SessionRow, byId: ReadonlyMap<string, SessionRow>): number {
  let n = 0;
  let current = session;
  const seen = new Set<string>([current.id]);
  while (current.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
    n += 1;
  }
  return n;
}

function lastActive(session: SessionRow): number {
  return Math.max(session.timeCreated, session.timeUpdated, session.timeIdle ?? 0);
}

function revertWarning(
  ctx: SessionContext,
  position: number,
  previousCount: number,
  remaining: number,
): CanonicalEvent {
  const source: EventSource = {
    provider: OPENCODE_PROVIDER_ID,
    channel: 'transcript',
    version: ctx.session.version,
    ref: { path: ctx.storePath, recordId: ctx.session.id },
  };
  const removed = previousCount - remaining;
  return {
    id: makeEventId(ctx.sessionId, ctx.session.id, 'revert', position, previousCount, remaining),
    sessionId: ctx.sessionId,
    ts: ctx.observedAt,
    tsSource: 'ingest',
    agentId: ctx.agentId,
    source,
    kind: 'ingest.warning',
    code: 'source-gap',
    detail: `OpenCode removed ${removed} recorded message${removed === 1 ? '' : 's'} from this session (a revert). Salidium keeps what it already recorded; those records can no longer be opened.`,
  };
}

/**
 * The OpenCode store source. It holds one piece of memory between polls: the last durable
 * sequence seen per session, so an unchanged session costs no message read. After a restart the
 * map is empty and every session in the history window is re-checked from its persisted cursor.
 */
export function createOpenCodeStoreSource(): StoreSource {
  // Per cursor key: the sequence last read and the cursor handed back for it. A session is skipped
  // only while both still match, so a batch the daemon failed to persist is read again.
  const seen = new Map<string, { sequence: number; position: number; count: number }>();

  return {
    locate({ userHome, env }) {
      const path = openCodeStorePath(userHome, env);
      return existsSync(path) ? path : undefined;
    },

    changeIndicators(path) {
      return [path, `${path}-wal`];
    },

    poll(request: StorePollRequest): StorePollResult {
      const storeIdentity = inodeOf(request.path);
      return withOpenCodeStore(request.path, (store) => {
        const sessions = readSessions(store);
        const byId = new Map(sessions.map((s) => [s.id, s] as const));
        const sequences = readSequences(store);
        // Roots before their children, so a lane opens after the session it belongs to.
        const ordered = [...sessions].sort(
          (a, b) =>
            depth(a, byId) - depth(b, byId) ||
            a.timeCreated - b.timeCreated ||
            a.id.localeCompare(b.id),
        );
        const batches: StorePollBatch[] = [];
        let budget = Math.max(1, request.rowBudget);
        let more = false;

        for (const session of ordered) {
          if (budget <= 0) {
            more = true;
            break;
          }
          const key = cursorKey(request.path, session.id);
          const stored = request.cursors.get(key);
          const root = rootOf(session, byId);
          if (!stored && Math.max(lastActive(session), lastActive(root)) < request.activeSinceMs)
            continue;
          const sequence = sequences.get(session.id) ?? 0;
          const sameStore = stored?.storeIdentity === storeIdentity;
          const last = seen.get(key);
          if (
            stored &&
            sameStore &&
            last?.sequence === sequence &&
            last.position === stored.position &&
            last.count === stored.count
          )
            continue;

          const ctx: SessionContext = {
            storePath: request.path,
            sessionId: makeSessionId(OPENCODE_PROVIDER_ID, root.id),
            session,
            agentId: root.id === session.id ? undefined : session.id,
            observedAt: request.observedAt,
          };
          const events: CanonicalEvent[] = [...mapSession(ctx)];
          // A replaced store file means positions no longer describe it: read from the start.
          let position = stored && sameStore ? stored.position : -1;
          let count = stored && sameStore ? stored.count : 0;

          if (position >= 0) {
            const remaining = countMessagesThrough(store, session.id, position);
            if (remaining < count) {
              events.push(revertWarning(ctx, position, count, remaining));
              position = maxSeqThrough(store, session.id, position);
              count = remaining;
            }
          }

          const rows = readMessagesAfter(
            store,
            session.id,
            position,
            budget,
            request.maxRecordBytes,
          );
          budget -= rows.length;
          if (rows.length > 0) {
            const turn: TurnState = {
              turnId: readLatestBefore(store, session.id, 'user', position + 1, 0)?.id,
              lastAssistantText: assistantText(
                readLatestBefore(
                  store,
                  session.id,
                  'assistant',
                  position + 1,
                  request.maxRecordBytes,
                ),
              ),
            };
            for (const row of rows) {
              if (isCopiedForkRow(session, row)) {
                // Inherited history: the source session reports it once, under its own identity.
                position = row.seq;
                count += 1;
                continue;
              }
              if (!isFinalRow(row, parseRowData(row))) break;
              events.push(...mapMessage(ctx, row, turn));
              position = row.seq;
              count += 1;
            }
          }
          const exhausted = budget <= 0;
          if (exhausted) more = true;
          else seen.set(key, { sequence, position, count });

          const cursor: StoreCursor = {
            key,
            sessionId: ctx.sessionId,
            providerSessionId: session.id,
            agentId: ctx.agentId,
            position,
            count,
            storeIdentity,
          };
          batches.push({ cursor, events });
        }
        return { batches, more };
      });
    },

    readRawRecord(storePath, ref): StoreRawRecord {
      if (!ref.path || ref.path !== storePath)
        return { raw: undefined, reason: 'the OpenCode store has moved since this was recorded' };
      if (!existsSync(storePath))
        return { raw: undefined, reason: 'OpenCode store no longer on disk' };
      const recordId = ref.recordId;
      if (!recordId) return { raw: undefined, reason: 'no provider record identity' };
      if (!ref.recordHash)
        return { raw: undefined, reason: 'raw fingerprint unavailable; re-ingest this session' };
      try {
        return withOpenCodeStore(storePath, (store): StoreRawRecord => {
          const slash = recordId.indexOf('/');
          if (slash < 0) {
            const session = readSession(store, recordId);
            if (!session)
              return { raw: undefined, reason: 'session no longer in the OpenCode store' };
            const stable = stableSessionRecord(session);
            if (recordHash(stable) !== ref.recordHash)
              return { raw: undefined, reason: 'provider record changed since ingestion' };
            return { raw: stable };
          }
          const sessionId = recordId.slice(0, slash);
          const messageId = recordId.slice(slash + 1);
          const row = readMessage(store, messageId, RAW_MAX_BYTES);
          if (!row || row.sessionId !== sessionId)
            return {
              raw: undefined,
              reason: 'record no longer in the OpenCode store (deleted or reverted)',
            };
          if (row.data === undefined)
            return {
              raw: undefined,
              reason: `provider record exceeds ${RAW_MAX_BYTES} bytes; raw suppressed`,
            };
          if (recordHash(row.data) !== ref.recordHash)
            return { raw: undefined, reason: 'provider record changed since ingestion' };
          return { raw: row.data };
        });
      } catch {
        return { raw: undefined, reason: 'the OpenCode store could not be opened read only' };
      }
    },
  };
}
