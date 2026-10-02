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
import { asObject, asString } from '@salidium/adapter-kit';
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
  type MessageRow,
  maxSeqThrough,
  readLatestBefore,
  readMessage,
  readMessagesAfter,
  readSequences,
  readSession,
  readSessions,
  type SessionRow,
  turnBoundaryAfter,
} from './records.ts';
import { isRegularFile, withOpenCodeStore } from './storeAccess.ts';
import { patchPaths } from './toolMapping.ts';

/** Bytes of row data one poll reads before it hands back and lets the daemon yield. */
const DEFAULT_BYTE_BUDGET = 8 * 1024 * 1024;

/** Milliseconds one poll reads before it hands back. */
const DEFAULT_TIME_BUDGET_MS = 50;

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

function abandonedStepWarning(ctx: SessionContext, row: MessageRow): CanonicalEvent {
  return {
    id: makeEventId(ctx.sessionId, row.id, 'warning', 'abandoned'),
    sessionId: ctx.sessionId,
    ts: ctx.observedAt,
    tsSource: 'ingest',
    agentId: ctx.agentId,
    source: {
      provider: OPENCODE_PROVIDER_ID,
      channel: 'transcript',
      version: ctx.session.version,
      ref: { path: ctx.storePath, line: row.seq, recordId: `${row.sessionId}/${row.id}` },
    },
    kind: 'ingest.warning',
    code: 'source-gap',
    detail:
      'OpenCode left a model step unfinished before a later turn; its tool calls and results are unknown.',
  };
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

/** The fields of an assistant step other than its content: model, timing, finish, usage. */
const STEP_FIELDS = [
  'time',
  'agent',
  'model',
  'finish',
  'rawFinish',
  'cost',
  'tokens',
  'error',
  'retry',
  'snapshot',
] as const;

function stepFields(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of STEP_FIELDS) if (Object.hasOwn(data, field)) out[field] = data[field];
  return out;
}

/** The changed paths a step's snapshot names; they are checked like any other path. */
function snapshotFiles(data: Record<string, unknown>): string[] {
  const files = asObject(data.snapshot)?.files;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [];
}

/** Row types that produce events; any other row is OpenCode bookkeeping and has no raw view. */
const SHOWN_TYPES = new Set([
  'user',
  'assistant',
  'idle',
  'compaction',
  'shell',
  'model-switched',
  'location-switched',
]);

const PATH_KEY = /^(?:path|paths|file|files|file_?path|file_?paths|uri|uris)$/i;

/**
 * Every string under a path-shaped key, unbounded in number (they are only checked, never shown),
 * so a long argument list cannot push a sensitive path past a cut-off.
 */
function pathArguments(input: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown, pathContext: boolean, depth: number): void => {
    if (depth > 32) return;
    if (typeof value === 'string') {
      if (pathContext && value) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, pathContext, depth + 1);
      return;
    }
    const o = asObject(value);
    if (!o) return;
    for (const [key, child] of Object.entries(o))
      visit(child, pathContext || PATH_KEY.test(key), depth + 1);
  };
  visit(input, false, 0);
  return out;
}

/** Paths and commands a tool part names, for the caller's suppression check. */
function partSubjects(part: unknown): { paths: string[]; commands: string[] } {
  const p = asObject(part);
  if (p?.type !== 'tool') return { paths: [], commands: [] };
  const state = asObject(p.state);
  const input = asObject(state?.input) ?? {};
  // Every path-shaped argument, whatever the tool calls it (MCP tools use `file_path`, `paths`,
  // `uri`, ...), plus the files a patch names.
  const paths = pathArguments(input);
  paths.push(...patchPaths(asString(input.patchText) ?? asString(input.patch) ?? ''));
  const files = asObject(state?.metadata)?.files;
  if (Array.isArray(files))
    for (const f of files) {
      const file = asString(asObject(f)?.file);
      if (file) paths.push(file);
    }
  const command = asString(input.command);
  return { paths, commands: command ? [command] : [] };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * What the raw view of a row shows. An assistant step holds every part of the step, so an event
 * gets only its own part (or, for usage, the step's fields without content); a person's shell
 * row is shown without its output. Every other row is a single record and is shown whole.
 */
function rawView(
  type: string,
  data: Record<string, unknown>,
  part: string | undefined,
): { record: unknown; paths: string[]; commands: string[] } | undefined {
  if (type === 'assistant') {
    const content = Array.isArray(data.content) ? data.content : [];
    if (part === undefined || part === 'step') {
      const files = snapshotFiles(data);
      const subjects = part === undefined ? content.map(partSubjects) : [];
      return {
        record: { type, ...stepFields(data) },
        paths: [...files, ...subjects.flatMap((s) => s.paths)],
        commands: subjects.flatMap((s) => s.commands),
      };
    }
    const index = Number(part);
    if (!Number.isInteger(index) || index < 0 || index >= content.length) return undefined;
    const subjects = partSubjects(content[index]);
    return {
      record: { type, ...stepFields(data), content: [content[index]] },
      paths: [...snapshotFiles(data), ...subjects.paths],
      commands: subjects.commands,
    };
  }
  if (part !== undefined || !SHOWN_TYPES.has(type)) return undefined;
  if (type === 'shell') {
    const { output: _output, ...rest } = data;
    const command = asString(data.command);
    return { record: { type, ...rest }, paths: [], commands: command ? [command] : [] };
  }
  if (type === 'user' && Array.isArray(data.files)) {
    // Attached files travel inside the prompt as base64. The raw view names them, never shows
    // their contents, and reports their paths for the caller's sensitive-file check.
    const paths: string[] = [];
    const files = data.files.map((file) => {
      const f = asObject(file) ?? {};
      const { data: content, ...rest } = f;
      const source = asObject(f.source);
      const uri = asString(source?.uri);
      const name = asString(f.name);
      // A `data:` URL is the file's content again; it is neither shown nor treated as a path.
      const inline = uri?.startsWith('data:') === true;
      if (uri && !inline) paths.push(uri.startsWith('file://') ? safeDecode(uri.slice(7)) : uri);
      if (name) paths.push(name);
      return {
        ...rest,
        ...(inline ? { source: { ...source, uri: '[data URL omitted by Salidium]' } } : {}),
        data: `[attachment omitted by Salidium: ${typeof content === 'string' ? content.length : 0} base64 characters]`,
      };
    });
    return { record: { type, ...data, files }, paths, commands: [] };
  }
  return { record: { type, ...data }, paths: [], commands: [] };
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
      // Only a regular file: opening a FIFO or device would block the daemon's thread.
      return isRegularFile(path) ? path : undefined;
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
        // Roots before their children, so a lane opens after the session it belongs to. Each
        // session's depth and root are computed once, not inside the comparator.
        const depths = new Map(sessions.map((x) => [x.id, depth(x, byId)] as const));
        const roots = new Map(sessions.map((x) => [x.id, rootOf(x, byId)] as const));
        const ordered = [...sessions].sort(
          (a, b) =>
            (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0) ||
            a.timeCreated - b.timeCreated ||
            a.id.localeCompare(b.id),
        );
        const startedAt = Date.now();
        const timeBudgetMs = request.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
        const batches: StorePollBatch[] = [];
        let budget = Math.max(1, request.rowBudget);
        let bytesLeft = request.byteBudget ?? DEFAULT_BYTE_BUDGET;
        let more = false;

        for (const session of ordered) {
          // Hand back to the daemon after a few milliseconds of reading, so it can serve requests.
          if (budget <= 0 || bytesLeft <= 0 || Date.now() - startedAt > timeBudgetMs) {
            more = true;
            break;
          }
          const key = cursorKey(request.path, session.id);
          const stored = request.cursors.get(key);
          const root = roots.get(session.id) ?? session;
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

          const read = readMessagesAfter(
            store,
            session.id,
            position,
            budget,
            request.maxRecordBytes,
            bytesLeft,
          );
          const rows = read.rows;
          let blocked: typeof rows = [];
          budget -= rows.length;
          bytesLeft -= read.bytes;
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
            for (const [index, row] of rows.entries()) {
              const data = parseRowData(row);
              if (isCopiedForkRow(session, row)) {
                // Inherited history: the source session reports it once, under its own identity.
                position = row.seq;
                count += 1;
                continue;
              }
              if (!isFinalRow(row, data)) {
                // A row OpenCode is still writing waits for a later poll, unless a later turn has
                // already begun or ended, in which case OpenCode abandoned it (it stopped mid-step)
                // and waiting would hold back every row after it for good.
                if (!turnBoundaryAfter(store, session.id, row.seq)) {
                  blocked = rows.slice(index);
                  break;
                }
                if (row.type === 'assistant') events.push(abandonedStepWarning(ctx, row));
                position = row.seq;
                count += 1;
                continue;
              }
              events.push(...mapMessage(ctx, row, turn, data));
              position = row.seq;
              count += 1;
            }
          }
          // Rows read past a blocking row were not used; return them to the budgets, so a session
          // waiting on a running step neither spends the poll nor asks to be read again at once.
          for (const row of blocked) {
            budget += 1;
            if (row.data !== undefined) bytesLeft += row.size;
          }
          const exhausted = blocked.length === 0 && (budget <= 0 || bytesLeft <= 0);
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
      if (!isRegularFile(storePath))
        return { raw: undefined, reason: 'the OpenCode store is not a regular file' };
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
            return { raw: stable, paths: [], commands: [] };
          }
          const sessionId = recordId.slice(0, slash);
          const hash = recordId.indexOf('#', slash);
          const messageId = recordId.slice(slash + 1, hash < 0 ? undefined : hash);
          const part = hash < 0 ? undefined : recordId.slice(hash + 1);
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
          if (!SHOWN_TYPES.has(row.type))
            return {
              raw: undefined,
              reason: 'this record is OpenCode bookkeeping, not evidence; it has no raw view',
            };
          const data = parseRowData(row);
          if (!data) return { raw: undefined, reason: 'provider record is not a JSON object' };
          const view = rawView(row.type, data, part);
          if (!view) return { raw: undefined, reason: 'record part not found' };
          return { raw: JSON.stringify(view.record), paths: view.paths, commands: view.commands };
        });
      } catch {
        return { raw: undefined, reason: 'the OpenCode store could not be opened read only' };
      }
    },
  };
}
