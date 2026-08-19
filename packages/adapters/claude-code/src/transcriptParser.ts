import { createHash } from 'node:crypto';
import type { RecordParser, RecordParserContext } from '@salidium/adapter-kit';
import {
  asObject,
  asString,
  excerpt,
  normalizeProviderTimestamp,
  safeJson,
} from '@salidium/adapter-kit';
import { type CanonicalEvent, type EventSource, makeEventId } from '@salidium/protocol';
import { mapPlanUpdate, mapToolInput, mapToolResult, parseFailure } from './toolMapping.ts';

/**
 * Parses Claude Code session transcript JSONL (`~/.claude/projects/<slug>/<sessionId>.jsonl` and
 * subagent files under `<sessionId>/subagents/`). The format is internal to Claude Code and may
 * change between releases; this parser is deliberately tolerant: unknown record types are
 * ignored, malformed lines become `ingest.warning` events, and every field access is guarded.
 *
 * Transcript records carry their own event ids and source fingerprints so lower-fidelity hooks
 * can be retained without winning reconciliation or pointing evidence at a rewritten line.
 */
export class ClaudeCodeTranscriptParser implements RecordParser {
  private readonly ctx: RecordParserContext;
  private readonly calls = new Map<
    string,
    { toolName: string; input: unknown; agentId?: string; turnId?: string }
  >();
  private currentPromptId: string | undefined;
  /** The newest usage already emitted, so an unchanged repeat of it can be dropped — see below. */
  private lastUsage: { messageId: string; figures: string } | undefined;
  private sessionStarted = false;
  private modelSeen: string | undefined;
  private lastBranch: string | undefined;
  private lastTitle: string | undefined;

  constructor(ctx: RecordParserContext) {
    this.ctx = ctx;
  }

  parseRecord(line: string, lineNo: number): CanonicalEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const record = asObject(safeJson(trimmed));
    if (!record)
      return [
        this.warning(lineNo, 'malformed-record', `line ${lineNo} is not a JSON object`, trimmed),
      ];
    const ts = normalizeProviderTimestamp(record.timestamp);
    if (!ts)
      return [
        this.warning(
          lineNo,
          'malformed-record',
          typeof record.timestamp === 'string'
            ? `line ${lineNo} has an invalid RFC 3339 timestamp`
            : `line ${lineNo} has no timestamp`,
          trimmed,
        ),
      ];
    const type = asString(record.type);
    const source: EventSource = {
      provider: 'claude-code',
      channel: 'transcript',
      version: asString(record.version),
      ref: {
        path: this.ctx.path,
        line: lineNo,
        recordId: asString(record.uuid),
        recordHash: recordHash(trimmed),
      },
    };
    const agentId = this.ctx.agentId ?? asString(record.agentId);
    const events: CanonicalEvent[] = [];

    if (!this.sessionStarted && asString(record.cwd)) {
      this.sessionStarted = true;
      this.lastBranch = asString(record.gitBranch);
      if (!agentId) {
        events.push({
          ...this.base(
            makeEventId(this.ctx.sessionId, 'session', 'start', 'transcript'),
            ts,
            source,
          ),
          kind: 'session.started',
          cwd: asString(record.cwd) ?? '',
          entrypoint: asString(record.entrypoint),
          gitBranch: this.lastBranch,
          transcriptPath: this.ctx.path,
        });
      } else {
        events.push({
          ...this.base(makeEventId(this.ctx.sessionId, 'subagent', agentId, 'start'), ts, source),
          kind: 'subagent.started',
          subagentId: agentId,
          transcriptPath: this.ctx.path,
        });
      }
    }
    if (!agentId) {
      const branch = asString(record.gitBranch);
      if (branch && branch !== this.lastBranch) {
        this.lastBranch = branch;
        events.push({
          ...this.base(
            makeEventId(this.ctx.sessionId, 'session', 'branch', branch, lineNo),
            ts,
            source,
          ),
          kind: 'session.updated',
          gitBranch: branch,
        });
      }
    }

    switch (type) {
      case 'user':
        events.push(...this.parseUser(record, ts, source, agentId, lineNo));
        break;
      case 'assistant':
        events.push(...this.parseAssistant(record, ts, source, agentId));
        break;
      case 'system':
        events.push(...this.parseSystem(record, ts, source, agentId));
        break;
      case 'custom-title':
      case 'ai-title': {
        const title = asString(record.customTitle) ?? asString(record.aiTitle);
        if (title && !agentId && title !== this.lastTitle) {
          this.lastTitle = title;
          events.push({
            ...this.base(makeEventId(this.ctx.sessionId, 'session', 'title', lineNo), ts, source),
            kind: 'session.updated',
            title,
          });
        }
        break;
      }
      default:
        // attachment, queue-operation, last-prompt, mode, permission-mode, pr-link, file-history-*, bridge-session, ...
        break;
    }
    return events;
  }

  private base(id: string, ts: string, source: EventSource) {
    return { id, sessionId: this.ctx.sessionId, ts, tsSource: 'provider' as const, source };
  }

  private warning(
    lineNo: number,
    code: 'malformed-record' | 'unsupported-record',
    detail: string,
    raw?: string,
  ): CanonicalEvent {
    return {
      ...this.base(
        makeEventId(this.ctx.sessionId, 'ingest', 'warning', this.ctx.agentId ?? 'main', lineNo),
        this.ctx.observedAt,
        {
          provider: 'claude-code',
          channel: 'transcript',
          ref: {
            path: this.ctx.path,
            line: lineNo,
            recordHash: raw ? recordHash(raw) : undefined,
          },
        },
      ),
      tsSource: 'ingest',
      kind: 'ingest.warning',
      code,
      detail,
    };
  }

  private parseUser(
    record: Record<string, unknown>,
    ts: string,
    source: EventSource,
    agentId: string | undefined,
    lineNo: number,
  ): CanonicalEvent[] {
    const message = asObject(record.message);
    if (!message) return [];
    const content = message.content;
    const promptId = asString(record.promptId);
    if (promptId) this.currentPromptId = promptId;
    const turnId = this.currentPromptId;
    const events: CanonicalEvent[] = [];

    // Tool results.
    if (Array.isArray(content)) {
      let sawToolResult = false;
      for (const block of content) {
        const b = asObject(block);
        if (b?.type !== 'tool_result') continue;
        sawToolResult = true;
        const callId = asString(b.tool_use_id);
        if (!callId) continue;
        const call = this.calls.get(callId);
        const toolName = call?.toolName ?? 'unknown';
        const text = contentText(b.content);
        const isError = b.is_error === true;
        const structured = record.toolUseResult;
        const durationMs = undefined;
        if (
          isError ||
          (typeof structured === 'string' && /^(Error:|<tool_use_error>)/.test(structured))
        ) {
          const f = parseFailure(typeof structured === 'string' ? structured : text);
          events.push({
            ...this.base(makeEventId(this.ctx.sessionId, 'tool', callId, 'failed'), ts, source),
            agentId,
            turnId: call?.turnId ?? turnId,
            kind: 'tool.failed',
            callId,
            toolName,
            errorExcerpt: f.errorExcerpt,
            cause: f.cause,
            exit: f.exit,
            interrupted: f.interrupted,
            durationMs,
          });
        } else {
          const mapped = mapToolResult(toolName, call?.input, structured, text);
          events.push({
            ...this.base(makeEventId(this.ctx.sessionId, 'tool', callId, 'result'), ts, source),
            agentId,
            turnId: call?.turnId ?? turnId,
            kind: 'tool.completed',
            callId,
            toolName,
            result: mapped.result,
            isError: false,
            durationMs,
          });
          const plan = mapPlanUpdate(toolName, call?.input, structured);
          if (plan && plan.items.length > 0 && !agentId) {
            events.push({
              ...this.base(makeEventId(this.ctx.sessionId, 'plan', callId), ts, source),
              agentId,
              turnId: call?.turnId ?? turnId,
              kind: 'plan.updated',
              mode: plan.mode,
              items: plan.items,
            });
          }
        }
        this.calls.delete(callId);
      }
      if (sawToolResult) return events;
    }

    // A human prompt (string content, or text blocks without tool results).
    if (
      record.isMeta === true ||
      record.isCompactSummary === true ||
      record.isVisibleInTranscriptOnly === true
    )
      return events;
    const text =
      typeof content === 'string' ? content : Array.isArray(content) ? contentText(content) : '';
    if (!text.trim()) return events;
    if (/^\[Request interrupted by user/.test(text.trim())) {
      if (turnId) {
        events.push({
          ...this.base(makeEventId(this.ctx.sessionId, 'turn', turnId, 'end'), ts, source),
          agentId,
          turnId,
          kind: 'turn.ended',
          outcome: 'interrupted',
        });
      }
      return events;
    }
    if (/<local-command-stdout>|<local-command-caveat>/.test(text)) return events;
    if (agentId) return events; // subagent "prompts" are the parent's delegation, not user turns
    const commandName = /<command-name>([^<]+)<\/command-name>/.exec(text)?.[1];
    const prompt = commandName ? `/${commandName.replace(/^\//, '')}` : stripPromptWrappers(text);
    if (!prompt.trim()) return events;
    const id = turnId ?? `line${lineNo}`;
    if (!turnId) this.currentPromptId = id;
    const ex = excerpt(prompt, 4000, 1000);
    events.push({
      ...this.base(makeEventId(this.ctx.sessionId, 'turn', id, 'start'), ts, source),
      turnId: id,
      kind: 'turn.started',
      prompt: ex.text,
      promptTruncated: ex.truncated || undefined,
    });
    return events;
  }

  private parseAssistant(
    record: Record<string, unknown>,
    ts: string,
    source: EventSource,
    agentId: string | undefined,
  ): CanonicalEvent[] {
    const message = asObject(record.message);
    if (!message) return [];
    const events: CanonicalEvent[] = [];
    const uuid = asString(record.uuid) ?? `l${source.ref?.line ?? 0}`;
    const turnId = this.currentPromptId;
    const model = asString(message.model);
    if (model && model !== this.modelSeen && !agentId) {
      this.modelSeen = model;
      events.push({
        ...this.base(makeEventId(this.ctx.sessionId, 'session', 'model', model), ts, source),
        kind: 'session.updated',
        model,
      });
    }
    // API error records can carry empty usage objects. They are not completed model responses, so
    // do not treat their placeholder counters or error text as ordinary assistant evidence.
    if (record.isApiErrorMessage === true) return events;
    events.push(...this.usageEvents(message, ts, source, agentId, uuid, model));
    const content = Array.isArray(message.content) ? message.content : [];
    const texts: string[] = [];
    content.forEach((block, i) => {
      const b = asObject(block);
      if (!b) return;
      switch (b.type) {
        case 'text': {
          const text = asString(b.text) ?? '';
          if (!text.trim()) return;
          texts.push(text);
          const ex = excerpt(text, 6000, 2000);
          events.push({
            ...this.base(makeEventId(this.ctx.sessionId, 'msg', uuid, i), ts, source),
            agentId,
            turnId,
            kind: 'agent.message',
            text: ex.text,
            truncated: ex.truncated || undefined,
            phase: 'commentary',
            messageId: asString(message.id),
          });
          return;
        }
        case 'tool_use': {
          const callId = asString(b.id);
          const toolName = asString(b.name) ?? 'unknown';
          if (!callId) return;
          const mapped = mapToolInput(toolName, b.input);
          this.calls.set(callId, { toolName, input: b.input, agentId, turnId });
          events.push({
            ...this.base(makeEventId(this.ctx.sessionId, 'tool', callId, 'call'), ts, source),
            agentId,
            turnId,
            kind: 'tool.called',
            callId,
            toolName,
            input: mapped.input,
            title: mapped.title,
          });
          return;
        }
        default:
          return; // thinking, redacted_thinking, server_tool_use, ...
      }
    });
    if (message.stop_reason === 'end_turn' && !agentId && turnId) {
      // Claude Code writes each content block of the final message as its own record, all
      // stamped end_turn. Each gets its own event id; the reducer ends the turn on the first and
      // merges the final text from whichever record carries it.
      const last = texts.join('\n\n');
      const ex = excerpt(last, 6000, 2000);
      events.push({
        ...this.base(makeEventId(this.ctx.sessionId, 'turn', turnId, 'end', uuid), ts, source),
        turnId,
        kind: 'turn.ended',
        outcome: 'completed',
        lastMessage: last ? ex.text : undefined,
      });
    }
    return events;
  }

  /**
   * What the API response this record belongs to consumed.
   *
   * Claude Code writes one record per content block and stamps the whole response's usage onto
   * every one of them, so the id is the record's — deterministic, and unique, so a re-ingest
   * regenerates exactly this set — while `messageId` names the response, and the reducer replaces
   * per response rather than adding. Keying the id on the message id instead would look tidier and
   * be wrong: the store inserts events OR IGNORE, so the first write would win and keep an early
   * partial snapshot.
   *
   * A record whose usage is identical to the one just emitted is dropped. That is not an
   * optimisation the reducer needs — replacing is idempotent — it is a volume decision. What makes the drop safe is
   * one layer up: `TranscriptTailer` only ever hands a parser byte 0. A file whose size and inode
   * still match its cursor is skipped without being parsed at all, and every other path resets the
   * offset to zero and builds a fresh parser, so this slot is always continuous from the file's
   * first record and a re-ingest regenerates exactly the ids the store already holds. Resume a
   * parser mid-file and the arithmetic moves instead: the records this slot would have dropped are
   * emitted under ids nobody has seen, and the reducer's per-lane memory has long left their
   * response, so they add a second time rather than replacing. A mid-file restart can therefore
   * overcount response usage unless the parser's identity remains stable.
   */
  private usageEvents(
    message: Record<string, unknown>,
    ts: string,
    source: EventSource,
    agentId: string | undefined,
    uuid: string,
    model: string | undefined,
  ): CanonicalEvent[] {
    const usage = asObject(message.usage);
    if (!usage) return [];
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const inputTokens = num(usage.input_tokens);
    const outputTokens = num(usage.output_tokens);
    const cacheReadTokens = num(usage.cache_read_input_tokens);
    const cacheWriteTokens = num(usage.cache_creation_input_tokens);
    // Without a response id every record is its own response, which is the honest reading: with
    // nothing to group by there is no evidence that two records describe one call.
    const messageId = asString(message.id) ?? uuid;
    const figures = `${inputTokens}/${outputTokens}/${cacheReadTokens}/${cacheWriteTokens}`;
    if (this.lastUsage?.messageId === messageId && this.lastUsage.figures === figures) return [];
    this.lastUsage = { messageId, figures };
    return [
      {
        ...this.base(makeEventId(this.ctx.sessionId, 'usage', uuid), ts, source),
        agentId,
        turnId: this.currentPromptId,
        kind: 'agent.usage',
        messageId,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      },
    ];
  }

  private parseSystem(
    record: Record<string, unknown>,
    ts: string,
    source: EventSource,
    agentId: string | undefined,
  ): CanonicalEvent[] {
    const subtype = asString(record.subtype);
    if (subtype === 'compact_boundary' && !agentId) {
      const meta = asObject(record.compactMetadata);
      return [
        {
          ...this.base(
            makeEventId(this.ctx.sessionId, 'compact', asString(record.uuid) ?? ts),
            ts,
            source,
          ),
          kind: 'compaction',
          trigger: asString(meta?.trigger),
        },
      ];
    }
    if (subtype === 'api_error' && !agentId) {
      const err = asObject(record.error);
      const message = asString(err?.message) ?? asString(record.content) ?? 'API error';
      const attempt = typeof record.retryAttempt === 'number' ? record.retryAttempt : undefined;
      const max = typeof record.maxRetries === 'number' ? record.maxRetries : undefined;
      if (attempt !== undefined && max !== undefined && attempt < max) return [];
      return [
        {
          ...this.base(
            makeEventId(this.ctx.sessionId, 'notif', 'api-error', asString(record.uuid) ?? ts),
            ts,
            source,
          ),
          kind: 'notification',
          notificationType: 'api_error',
          message: excerpt(message, 300, 0).text,
        },
      ];
    }
    return [];
  }
}

function recordHash(line: string): string {
  return `sha256:${createHash('sha256').update(line).digest('hex')}`;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const o = asObject(b);
      if (!o) return '';
      if (o.type === 'text') return asString(o.text) ?? '';
      if (o.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Removes system-injected wrappers from a prompt so the developer's own words remain. */
function stripPromptWrappers(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/g, '')
    .trim();
}
