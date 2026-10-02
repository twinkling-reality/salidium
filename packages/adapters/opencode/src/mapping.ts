import { createHash } from 'node:crypto';
import { asObject, asString, excerpt, safeJson } from '@salidium/adapter-kit';
import {
  type CanonicalEvent,
  CanonicalTimestampSchema,
  type EventSource,
  makeEventId,
  type ProviderId,
} from '@salidium/protocol';
import type { MessageRow, SessionRow } from './records.ts';
import {
  canonicalToolName,
  contentText,
  failureCause,
  isMigratedPart,
  mapToolInput,
  mapToolResult,
  planItems,
} from './toolMapping.ts';

/*
 * Pure mapping from OpenCode 2.x store rows to canonical events. No I/O: the store source reads
 * rows through the restricted connection and hands them here.
 *
 * Identity. Every event id is composed from OpenCode's own ids (session, message, tool call), so
 * re-reading a row, after a restart or a re-ingest, yields the same events and the store dedupes
 * them. Tool call ids come from the model provider and are short (Ollama's are eight characters),
 * so a call is identified as `<message id>/<call id>`, unique across the session and its lanes.
 *
 * Finality. A step's row is written as soon as it starts and updated while it streams. Only a
 * final row is mapped: an assistant step once `time.completed` or `finish` is set, a shell or
 * compaction row once it leaves `running`. Everything else is final when written.
 */

export const OPENCODE_PROVIDER_ID: ProviderId = 'salidium/opencode';

export interface SessionContext {
  /** Absolute path of the store the rows came from, for provenance. */
  storePath: string;
  /** Salidium session id: the provider id and the root OpenCode session's id. */
  sessionId: string;
  /** The OpenCode session these rows belong to (the root, or a child lane). */
  session: SessionRow;
  /** Child sessions are subagent lanes of the root; their id is the lane id. */
  agentId?: string;
  /** Instant this read began, for warnings that carry no provider time. */
  observedAt: string;
}

/** Turn context carried across rows, and across polls by re-reading it from the store. */
export interface TurnState {
  /** The user message id that opened the current turn. */
  turnId?: string;
  /** Text of the newest assistant step, which an `idle` row reports as the turn's last message. */
  lastAssistantText?: string;
}

export function canonicalTime(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  const iso = date.toISOString();
  return CanonicalTimestampSchema.safeParse(iso).success ? iso : undefined;
}

export function recordHash(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * Record id a message event cites: `<session id>/<message id>`, plus `#<part index>` for an event
 * that stands for one part of an assistant step, or `#step` for the step's own fields (usage). The
 * fingerprint covers the whole row; the raw view returns only the part.
 */
export function messageRecordId(
  row: Pick<MessageRow, 'sessionId' | 'id'>,
  part?: number | 'step',
): string {
  return `${row.sessionId}/${row.id}${part === undefined ? '' : `#${part}`}`;
}

/**
 * The stable part of a session row. The row itself changes on every turn (times, totals), so the
 * session's own events cite only the columns that never change after creation.
 */
export function stableSessionRecord(session: SessionRow): string {
  return JSON.stringify({
    id: session.id,
    parent_id: session.parentId ?? null,
    fork_session_id: session.forkSessionId ?? null,
    directory: session.directory,
    time_created: session.timeCreated,
  });
}

function messageSource(ctx: SessionContext, row: MessageRow, part?: number | 'step'): EventSource {
  return {
    provider: OPENCODE_PROVIDER_ID,
    channel: 'transcript',
    version: ctx.session.version,
    ref: {
      path: ctx.storePath,
      line: row.seq,
      recordId: messageRecordId(row, part),
      ...(row.data === undefined ? {} : { recordHash: recordHash(row.data) }),
    },
  };
}

function sessionSource(ctx: SessionContext): EventSource {
  return {
    provider: OPENCODE_PROVIDER_ID,
    channel: 'transcript',
    version: ctx.session.version,
    ref: {
      path: ctx.storePath,
      recordId: ctx.session.id,
      recordHash: recordHash(stableSessionRecord(ctx.session)),
    },
  };
}

function modelName(model: unknown): string | undefined {
  const m = asObject(model);
  const id = asString(m?.id);
  if (!id) return undefined;
  const provider = asString(m?.providerID);
  return provider ? `${provider}/${id}` : id;
}

/** A forked session starts with copies of its source's rows, re-identified as `<msg id>_<seq>`. */
export function isCopiedForkRow(session: SessionRow, row: Pick<MessageRow, 'id' | 'seq'>): boolean {
  if (!session.forkSessionId) return false;
  const m = /_(\d+)$/.exec(row.id);
  return m !== null && Number(m[1]) === row.seq;
}

/** Whether OpenCode has finished writing the row. */
export function isFinalRow(row: MessageRow, data: Record<string, unknown> | undefined): boolean {
  if (!data) return true;
  switch (row.type) {
    case 'assistant': {
      const time = asObject(data.time);
      return typeof time?.completed === 'number' || typeof data.finish === 'string';
    }
    case 'shell':
    case 'compaction':
      return asString(data.status) !== 'running';
    default:
      return true;
  }
}

export function parseRowData(row: MessageRow): Record<string, unknown> | undefined {
  return row.data === undefined ? undefined : asObject(safeJson(row.data));
}

/** Session-level events for one OpenCode session: the root starts the Salidium session, a child opens a lane. */
export function mapSession(ctx: SessionContext): CanonicalEvent[] {
  const session = ctx.session;
  const ts = canonicalTime(session.timeCreated);
  const source = sessionSource(ctx);
  if (!ts) {
    return [
      {
        id: makeEventId(ctx.sessionId, session.id, 'warning', 'session-time'),
        sessionId: ctx.sessionId,
        ts: ctx.observedAt,
        tsSource: 'ingest',
        source,
        kind: 'ingest.warning',
        code: 'malformed-record',
        detail: 'OpenCode session row has no valid creation time',
      },
    ];
  }
  if (ctx.agentId) {
    return [
      {
        id: makeEventId(ctx.sessionId, session.id, 'subagent', 'started'),
        sessionId: ctx.sessionId,
        ts,
        tsSource: 'provider',
        agentId: ctx.agentId,
        source,
        kind: 'subagent.started',
        subagentId: ctx.agentId,
        agentType: session.agent,
        description: session.title,
      },
    ];
  }
  const events: CanonicalEvent[] = [
    {
      id: makeEventId(ctx.sessionId, session.id, 'session', 'started'),
      sessionId: ctx.sessionId,
      ts,
      tsSource: 'provider',
      source,
      kind: 'session.started',
      cwd: session.directory,
      model: modelName(session.model),
      reason: session.forkSessionId ? 'fork' : undefined,
    },
  ];
  if (session.title) {
    // Titles are generated after the first turn; each distinct title is its own update.
    const updatedAt = canonicalTime(session.timeUpdated) ?? ts;
    events.push({
      id: makeEventId(ctx.sessionId, session.id, 'title', recordHash(session.title).slice(7, 23)),
      sessionId: ctx.sessionId,
      ts: updatedAt,
      tsSource: 'provider',
      source,
      kind: 'session.updated',
      title: session.title,
    });
  }
  return events;
}

function warning(
  ctx: SessionContext,
  row: MessageRow,
  code: 'malformed-record' | 'truncated-record',
  detail: string,
): CanonicalEvent {
  return {
    id: makeEventId(ctx.sessionId, row.id, 'warning', code),
    sessionId: ctx.sessionId,
    ts: ctx.observedAt,
    tsSource: 'ingest',
    agentId: ctx.agentId,
    source: messageSource(ctx, row),
    kind: 'ingest.warning',
    code,
    detail,
  };
}

function textParts(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = asObject(part);
      return p?.type === 'text' ? (asString(p.text) ?? '') : '';
    })
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

/** The text an assistant row says, for turn context. */
export function assistantText(row: MessageRow | undefined): string | undefined {
  if (!row) return undefined;
  const text = textParts(parseRowData(row)?.content);
  return text || undefined;
}

/**
 * Maps one final row. `turn` is updated in place so the next row of the batch sees the turn this
 * row opened or the text it said.
 */
export function mapMessage(
  ctx: SessionContext,
  row: MessageRow,
  turn: TurnState,
  parsed: Record<string, unknown> | undefined = parseRowData(row),
): CanonicalEvent[] {
  if (row.data === undefined)
    return [
      warning(
        ctx,
        row,
        'truncated-record',
        'OpenCode message exceeded the size limit and was skipped',
      ),
    ];
  const data = parsed;
  if (!data)
    return [warning(ctx, row, 'malformed-record', 'OpenCode message is not a JSON object')];
  const created = canonicalTime(num(asObject(data.time)?.created) ?? row.timeCreated);
  if (!created)
    return [warning(ctx, row, 'malformed-record', 'OpenCode message has no valid creation time')];
  const source = messageSource(ctx, row);
  const base = {
    sessionId: ctx.sessionId,
    tsSource: 'provider' as const,
    agentId: ctx.agentId,
    source,
  };
  const id = (...parts: Array<string | number>) => makeEventId(ctx.sessionId, row.id, ...parts);

  switch (row.type) {
    case 'user': {
      if (ctx.agentId) return []; // a lane's prompt is the delegating agent's, shown on its call
      turn.turnId = row.id;
      turn.lastAssistantText = undefined;
      const ex = excerpt(asString(data.text) ?? '', 4000, 1000);
      return [
        {
          ...base,
          id: id('turn', 'started'),
          ts: created,
          turnId: row.id,
          kind: 'turn.started',
          prompt: ex.text,
          promptTruncated: ex.truncated || undefined,
        },
      ];
    }
    case 'assistant':
      return mapAssistant(ctx, row, data, turn, base, created);
    case 'idle': {
      const outcome = asString(data.outcome);
      const last = turn.lastAssistantText
        ? excerpt(turn.lastAssistantText, 6000, 2000).text
        : undefined;
      if (ctx.agentId) {
        return [
          {
            ...base,
            id: id('subagent', 'ended'),
            ts: created,
            kind: 'subagent.ended',
            subagentId: ctx.agentId,
            lastMessage: last,
          },
        ];
      }
      return [
        {
          ...base,
          id: id('turn', 'ended'),
          ts: created,
          turnId: turn.turnId,
          kind: 'turn.ended',
          outcome:
            outcome === 'interrupted'
              ? 'interrupted'
              : outcome === 'failed'
                ? 'failed'
                : 'completed',
          lastMessage: last,
        },
      ];
    }
    case 'compaction': {
      if (asString(data.status) !== 'completed') return [];
      const summary = asString(data.summary);
      return [
        {
          ...base,
          id: id('compaction'),
          ts: created,
          turnId: ctx.agentId ? undefined : turn.turnId,
          kind: 'compaction',
          trigger: asString(data.reason),
          summaryExcerpt: summary ? excerpt(summary, 600, 0).text : undefined,
        },
      ];
    }
    case 'model-switched': {
      const model = modelName(data.model);
      return model
        ? [{ ...base, id: id('model'), ts: created, kind: 'session.updated', model }]
        : [];
    }
    case 'location-switched': {
      const directory = asString(asObject(data.location)?.directory);
      return directory
        ? [{ ...base, id: id('location'), ts: created, kind: 'session.updated', cwd: directory }]
        : [];
    }
    case 'shell': {
      // A command the person ran in the session, not the agent. Kept as a notification so it is
      // visible without being counted as the agent's work.
      const command = asString(data.command) ?? '';
      const exit = data.exit;
      const status = asString(data.status);
      const outcome =
        typeof exit === 'number'
          ? `exit ${exit}`
          : status === 'timeout'
            ? 'timed out'
            : (status ?? 'unknown');
      const finished = canonicalTime(num(asObject(data.time)?.completed)) ?? created;
      return [
        {
          ...base,
          id: id('shell'),
          ts: finished,
          turnId: ctx.agentId ? undefined : turn.turnId,
          kind: 'notification',
          notificationType: 'person-shell',
          message: `The person ran a command: ${excerpt(command.split('\n', 1)[0] ?? '', 200, 0).text} (${outcome})`,
        },
      ];
    }
    default:
      // synthetic reminders, agent and system markers, skills: bookkeeping Salidium does not report.
      return [];
  }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

type Base = {
  sessionId: string;
  tsSource: 'provider';
  agentId?: string;
  source: EventSource;
};

function mapAssistant(
  ctx: SessionContext,
  row: MessageRow,
  data: Record<string, unknown>,
  turn: TurnState,
  base: Base,
  created: string,
): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  const time = asObject(data.time);
  const completed = canonicalTime(num(time?.completed)) ?? created;
  const turnId = ctx.agentId ? undefined : turn.turnId;
  const content = Array.isArray(data.content) ? data.content : [];
  const finish = asString(data.finish);
  const id = (...parts: Array<string | number>) => makeEventId(ctx.sessionId, row.id, ...parts);

  content.forEach((rawPart, index) => {
    const part = asObject(rawPart);
    if (!part) return;
    const partTime = asObject(part.time);
    switch (part.type) {
      case 'reasoning': {
        const text = asString(part.text) ?? '';
        if (!text) return;
        events.push({
          ...base,
          source: messageSource(ctx, row, index),
          id: id('thinking', index),
          ts: canonicalTime(num(partTime?.created)) ?? created,
          turnId,
          kind: 'agent.thinking',
          chars: text.length,
        });
        return;
      }
      case 'text': {
        const text = asString(part.text) ?? '';
        if (!text.trim()) return;
        const ex = excerpt(text, 6000, 2000);
        events.push({
          ...base,
          source: messageSource(ctx, row, index),
          id: id('message', index),
          ts: completed,
          turnId,
          kind: 'agent.message',
          text: ex.text,
          truncated: ex.truncated || undefined,
          phase: finish === 'stop' ? 'final' : 'commentary',
          messageId: row.id,
        });
        return;
      }
      case 'tool':
        events.push(
          ...mapToolPart(
            ctx,
            row,
            part,
            index,
            turnId,
            { ...base, source: messageSource(ctx, row, index) },
            created,
            completed,
          ),
        );
        return;
      default:
        return;
    }
  });

  const tokens = asObject(data.tokens);
  if (tokens) {
    const cache = asObject(tokens.cache);
    events.push({
      ...base,
      source: messageSource(ctx, row, 'step'),
      id: id('usage'),
      ts: completed,
      turnId,
      kind: 'agent.usage',
      messageId: row.id,
      model: modelName(data.model)?.slice(0, 120),
      inputTokens: count(tokens.input),
      outputTokens: count(tokens.output),
      cacheReadTokens: count(cache?.read),
      cacheWriteTokens: count(cache?.write),
    });
  }

  const text = textParts(content);
  if (text) turn.lastAssistantText = text;

  // A declined permission ends the run: OpenCode aborts the step ("Step interrupted") and writes no
  // `idle` row for the turn. Both facts are in this row, so the turn's end is observed here rather
  // than left open until the next prompt closes it by inference.
  const aborted = finish === 'error' && asString(asObject(data.error)?.type) === 'aborted';
  if (!ctx.agentId && aborted && content.some(isDeclinedCall)) {
    events.push({
      ...base,
      id: id('turn', 'ended', 'declined'),
      ts: completed,
      turnId,
      kind: 'turn.ended',
      outcome: 'interrupted',
      error: 'A permission request was declined, which ended the turn',
      lastMessage: turn.lastAssistantText
        ? excerpt(turn.lastAssistantText, 6000, 2000).text
        : undefined,
    });
  }
  return events;
}

function isDeclinedCall(part: unknown): boolean {
  const p = asObject(part);
  if (p?.type !== 'tool') return false;
  const state = asObject(p.state);
  return state?.status === 'error' && failureCause(asObject(state.error)) === 'rejected';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function mapToolPart(
  ctx: SessionContext,
  row: MessageRow,
  part: Record<string, unknown>,
  index: number,
  turnId: string | undefined,
  base: Base,
  stepCreated: string,
  stepCompleted: string,
): CanonicalEvent[] {
  const rawName = (asString(part.name) ?? 'unknown').slice(0, 200);
  const migrated = isMigratedPart(part);
  const toolName = canonicalToolName(rawName, migrated);
  const state = asObject(part.state);
  const status = asString(state?.status);
  const partTime = asObject(part.time);
  // The provider's call id, when it is a plain bounded token; otherwise the part's position.
  const providerCallId = asString(part.id);
  const callId = `${row.id}/${providerCallId && /^[\w-]{1,128}$/.test(providerCallId) ? providerCallId : `part-${index}`}`;
  const id = (...parts: Array<string | number>) => makeEventId(ctx.sessionId, callId, ...parts);
  const calledAt = canonicalTime(num(partTime?.created)) ?? stepCreated;
  const endedAt = canonicalTime(num(partTime?.completed)) ?? stepCompleted;
  const startMs = num(partTime?.ran) ?? num(partTime?.created);
  const endMs = num(partTime?.completed);
  const durationMs =
    startMs !== undefined && endMs !== undefined && endMs >= startMs
      ? Math.round(endMs - startMs)
      : undefined;
  const text = contentText(state?.content);
  const { input, title } = mapToolInput(rawName, state?.input, text, migrated);
  const events: CanonicalEvent[] = [
    {
      ...base,
      id: id('called'),
      ts: calledAt,
      turnId,
      kind: 'tool.called',
      callId,
      toolName,
      input,
      title,
    },
  ];
  if (toolName === 'todowrite' && migrated) {
    const items = planItems(state?.input);
    if (items)
      events.push({
        ...base,
        id: id('plan'),
        ts: calledAt,
        turnId,
        kind: 'plan.updated',
        mode: 'replace',
        items,
      });
  }
  if (status === 'completed') {
    const { result, isError } = mapToolResult(
      rawName,
      state?.input,
      state?.metadata,
      text,
      ctx.session.directory,
      migrated,
    );
    events.push({
      ...base,
      id: id('completed'),
      ts: endedAt,
      turnId,
      kind: 'tool.completed',
      callId,
      toolName,
      result,
      isError,
      durationMs,
    });
  } else if (status === 'error') {
    const error = asObject(state?.error);
    const message = asString(error?.message) ?? text ?? 'tool failed';
    const cause = failureCause(error);
    events.push({
      ...base,
      id: id('failed'),
      ts: endedAt,
      turnId,
      kind: 'tool.failed',
      callId,
      toolName,
      errorExcerpt: excerpt(message || 'tool failed', 800, 400).text,
      cause,
      interrupted: cause === 'interrupted' || undefined,
      durationMs,
    });
  }
  // A part still streaming or running in a final step has no result; the turn's end marks it unknown.
  return events;
}
