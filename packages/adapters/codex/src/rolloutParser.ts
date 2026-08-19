import { createHash } from 'node:crypto';
import type { RecordParser, RecordParserContext } from '@salidium/adapter-kit';
import {
  asObject,
  asString,
  excerpt,
  hunksFromUnifiedDiff,
  normalizeProviderTimestamp,
  pathArgumentMetadata,
  safeJson,
} from '@salidium/adapter-kit';
import {
  type CanonicalEvent,
  type EventSource,
  type ExitStatus,
  type FileChange,
  makeEventId,
  type PlanItem,
  type ToolInput,
} from '@salidium/protocol';
import {
  codeCellPoll,
  extractCodeCellCommands,
  type ParsedExecOutput,
  parseExecOutput,
  parseShellFunctionArgs,
  patchPaths,
  type RunningHandle,
  runningHandleFromArgs,
  runningHandleKey,
} from './toolMapping.ts';

interface RememberedCall {
  toolName: string;
  input: ToolInput;
  turnId?: string;
  /** For `wait` / `write_stdin`: the cell/session this call polls. */
  polls?: RunningHandle;
}

/** A command whose tool call yielded while the process was still running. */
interface PendingCommand {
  callId: string;
  toolName: string;
  /**
   * Output already collected, in order. A poll returns the next chunk rather than the whole log,
   * so a command that took several polls has its output spread across several records; keeping
   * only the last would lose earlier chunks.
   */
  chunks: string[];
}

/** Envelope builder for one record: id in, everything but `kind` out. */
type BaseFn = (id: string) => Omit<CanonicalEvent, 'kind'> & { turnId?: string };

/**
 * Parses Codex rollout JSONL (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`).
 * Every line is `{timestamp, type, payload}`. The format is Codex-internal (types live in
 * codex-rs/protocol); this parser handles the legacy history mode observed locally and ignores
 * unknown records. Command exit codes are frequently unavailable in rollouts (exec_command_end
 * is not persisted; code-mode `exec` prints script status, not shell exit) — the parser records
 * exactly what it can observe and marks the rest unknown.
 *
 * Long-running commands: when an `exec` cell or `exec_command` yields with "running with cell ID
 * N" / "session ID N", the real result arrives in a later `wait` / `write_stdin` output. The
 * parser maps that handle back to the original call and emits a second `tool.completed` with the
 * id `tool:<callId>:result:final`, so the store keeps both and the reducer can upgrade the
 * provisional (still-running) result.
 */
export class CodexRolloutParser implements RecordParser {
  private readonly ctx: RecordParserContext;
  private readonly calls = new Map<string, RememberedCall>();
  /** Still-running commands by handle key (`cell:N` / `session:N`). */
  private readonly pending = new Map<string, PendingCommand>();
  /** Fallback target for a `wait` / `write_stdin` whose arguments name no handle. */
  private lastRunning: PendingCommand | undefined;
  /** Turns for which a `turn.started` with the canonical id has been emitted. */
  private readonly startedTurns = new Set<string>();
  private currentTurnId: string | undefined;
  private modelSeen: string | undefined;
  private lastReasoning: string | undefined;
  /**
   * `/root/implementer` → the thread id that lane was started with.
   *
   * Codex names a subagent two different ways: `sub_agent_activity` identifies it by
   * `agent_thread_id` and carries the path only as a label, while an inter-agent message
   * identifies the sender by path and never mentions the thread. Keyed on the wrong one, a
   * subagent's own report opens a second, empty lane beside the one it belongs to, and the lane
   * that did the work stays "running" forever with no result against it.
   */
  private readonly agentThreadByPath = new Map<string, string>();

  constructor(ctx: RecordParserContext) {
    this.ctx = ctx;
  }

  parseRecord(line: string, lineNo: number): CanonicalEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const record = asObject(safeJson(trimmed));
    if (!record) return [this.warning(lineNo, 'record is not a JSON object', trimmed)];
    const ts = normalizeProviderTimestamp(record.timestamp);
    if (!ts)
      return [
        this.warning(
          lineNo,
          typeof record.timestamp === 'string'
            ? 'record has an invalid RFC 3339 timestamp'
            : 'record has no timestamp',
          trimmed,
        ),
      ];
    const type = asString(record.type);
    const payload = asObject(record.payload) ?? {};
    const source: EventSource = {
      provider: 'codex',
      channel: 'rollout',
      ref: { path: this.ctx.path, line: lineNo, recordHash: recordHash(trimmed) },
    };
    const base = (id: string) => ({
      id,
      sessionId: this.ctx.sessionId,
      ts,
      tsSource: 'provider' as const,
      turnId: this.currentTurnId,
      source,
    });
    const sid = this.ctx.sessionId;

    switch (type) {
      case 'session_meta': {
        const git = asObject(payload.git);
        return [
          {
            ...base(makeEventId(sid, 'session', 'start', 'rollout')),
            kind: 'session.started',
            cwd: asString(payload.cwd) ?? '',
            entrypoint: asString(payload.originator) ?? sourceLabel(payload.source),
            gitBranch: asString(git?.branch),
            transcriptPath: this.ctx.path,
            title: asString(asObject(payload.thread_name)?.name),
          },
        ];
      }
      case 'turn_context': {
        const turnId = asString(payload.turn_id);
        if (turnId) this.currentTurnId = turnId;
        const model = asString(payload.model);
        const events: CanonicalEvent[] = [];
        if (model && model !== this.modelSeen) {
          this.modelSeen = model;
          events.push({
            ...base(makeEventId(sid, 'session', 'model', model)),
            kind: 'session.updated',
            model,
            cwd: asString(payload.cwd),
          });
        }
        return events;
      }
      case 'event_msg':
        return this.parseEventMsg(payload, base, lineNo);
      case 'response_item':
        return this.parseResponseItem(payload, base, lineNo);
      case 'compacted':
        return [{ ...base(makeEventId(sid, 'compact', lineNo)), kind: 'compaction' }];
      default:
        return [];
    }
  }

  private warning(lineNo: number, detail: string, raw?: string): CanonicalEvent {
    return {
      id: makeEventId(this.ctx.sessionId, 'ingest', 'warning', lineNo),
      sessionId: this.ctx.sessionId,
      ts: this.ctx.observedAt,
      tsSource: 'ingest',
      source: {
        provider: 'codex',
        channel: 'rollout',
        ref: {
          path: this.ctx.path,
          line: lineNo,
          recordHash: raw ? recordHash(raw) : undefined,
        },
      },
      kind: 'ingest.warning',
      code: 'malformed-record',
      detail: `line ${lineNo}: ${detail}`,
    };
  }

  private parseEventMsg(
    p: Record<string, unknown>,
    base: BaseFn,
    lineNo: number,
  ): CanonicalEvent[] {
    const sid = this.ctx.sessionId;
    const t = asString(p.type);
    switch (t) {
      case 'task_started': {
        const turnId = asString(p.turn_id);
        if (turnId) this.currentTurnId = turnId;
        return [];
      }
      case 'user_message': {
        const message = asString(p.message) ?? '';
        if (!message.trim()) return [];
        const turnId = this.currentTurnId ?? `line${lineNo}`;
        if (!this.currentTurnId) this.currentTurnId = turnId;
        const ex = excerpt(message, 4000, 1000);
        // Codex can deliver a second user message mid-turn (queued/steering input) with no new
        // task_started; only the first message per turn owns the canonical id so the later one
        // is stored rather than dropped as a duplicate.
        const first = !this.startedTurns.has(turnId);
        this.startedTurns.add(turnId);
        return [
          {
            ...base(
              first
                ? makeEventId(sid, 'turn', turnId, 'start')
                : makeEventId(sid, 'turn', turnId, 'start', lineNo),
            ),
            turnId,
            kind: 'turn.started',
            prompt: ex.text,
            promptTruncated: ex.truncated || undefined,
          },
        ];
      }
      case 'agent_message': {
        const message = asString(p.message) ?? '';
        if (!message.trim()) return [];
        const phase = p.phase === 'final_answer' ? 'final' : 'commentary';
        const ex = excerpt(message, 6000, 2000);
        return [
          {
            ...base(makeEventId(sid, 'msg', lineNo)),
            kind: 'agent.message',
            text: ex.text,
            truncated: ex.truncated || undefined,
            phase,
          },
        ];
      }
      case 'agent_reasoning': {
        const text = asString(p.text) ?? '';
        if (!text.trim() || text === this.lastReasoning) return [];
        this.lastReasoning = text;
        return [
          {
            ...base(makeEventId(sid, 'reason', lineNo)),
            kind: 'agent.message',
            text: excerpt(text, 2000, 500).text,
            phase: 'commentary',
          },
        ];
      }
      case 'task_complete': {
        const turnId = asString(p.turn_id) ?? this.currentTurnId;
        if (!turnId) return [];
        const last = asString(p.last_agent_message);
        const err = asObject(p.error);
        return [
          {
            ...base(makeEventId(sid, 'turn', turnId, 'end')),
            turnId,
            kind: 'turn.ended',
            outcome: err ? 'failed' : 'completed',
            lastMessage: last ? excerpt(last, 6000, 2000).text : undefined,
            error: asString(err?.message),
          },
        ];
      }
      case 'turn_aborted': {
        const turnId = asString(p.turn_id) ?? this.currentTurnId;
        if (!turnId) return [];
        return [
          {
            ...base(makeEventId(sid, 'turn', turnId, 'end')),
            turnId,
            kind: 'turn.ended',
            outcome: 'interrupted',
            error: asString(p.reason),
          },
        ];
      }
      case 'patch_apply_end': {
        const callId = asString(p.call_id) ?? `patch-${lineNo}`;
        const success = p.success !== false;
        const changesObj = asObject(p.changes) ?? {};
        const changes: FileChange[] = [];
        for (const [path, raw] of Object.entries(changesObj)) {
          const c = asObject(raw);
          if (!c) continue;
          const kind = asString(c.type);
          if (kind === 'add') {
            const content = asString(c.content) ?? '';
            changes.push({
              path,
              change: 'add',
              linesAdded: content ? content.split('\n').length : 0,
              linesRemoved: 0,
              applied: success,
            });
          } else if (kind === 'delete') {
            const content = asString(c.content) ?? '';
            changes.push({
              path,
              change: 'delete',
              linesAdded: 0,
              linesRemoved: content ? content.split('\n').length : 0,
              applied: success,
            });
          } else {
            const diff = asString(c.unified_diff) ?? '';
            const hunks = hunksFromUnifiedDiff(diff);
            let added = 0;
            let removed = 0;
            for (const h of hunks)
              for (const l of h.lines)
                if (l.startsWith('+')) added++;
                else if (l.startsWith('-')) removed++;
            const movedTo = asString(c.move_path);
            changes.push({
              path: movedTo ?? path,
              change: movedTo ? 'move' : 'update',
              movedFrom: movedTo ? path : undefined,
              hunks: hunks.length ? hunks : undefined,
              linesAdded: added,
              linesRemoved: removed,
              applied: success,
            });
          }
        }
        const events: CanonicalEvent[] = [];
        if (!this.calls.has(callId)) {
          const first = changes[0]?.path ?? 'files';
          events.push({
            ...base(makeEventId(sid, 'tool', callId, 'call')),
            kind: 'tool.called',
            callId,
            toolName: 'apply_patch',
            input: { kind: 'fileEdit', path: first },
            title: `Edit ${changes.length === 1 ? first : `${changes.length} files`}`,
          });
        }
        events.push({
          ...base(makeEventId(sid, 'tool', callId, 'result')),
          kind: 'tool.completed',
          callId,
          toolName: 'apply_patch',
          result: { kind: 'fileChanges', changes },
          isError: !success,
        });
        this.calls.delete(callId);
        return events;
      }
      case 'mcp_tool_call_end': {
        const callId = asString(p.call_id) ?? `mcp-${lineNo}`;
        const inv = asObject(p.invocation);
        const server = asString(inv?.server) ?? 'mcp';
        const tool = asString(inv?.tool) ?? 'tool';
        const invocationArgs = inv?.arguments ?? {};
        const pathMetadata = pathArgumentMetadata(invocationArgs);
        const result = asObject(p.result);
        const isError = result?.Err !== undefined || asObject(result?.Ok)?.isError === true;
        const events: CanonicalEvent[] = [];
        if (!this.calls.has(callId))
          events.push({
            ...base(makeEventId(sid, 'tool', callId, 'call')),
            kind: 'tool.called',
            callId,
            toolName: `mcp__${server}__${tool}`,
            input: {
              kind: 'mcp',
              server,
              tool,
              pathArgs: pathMetadata.paths.length ? pathMetadata.paths : undefined,
              pathArgsTruncated: pathMetadata.truncated || undefined,
              argsExcerpt: excerpt(JSON.stringify(invocationArgs), 300, 0).text,
            },
            title: `${server}: ${tool}`,
          });
        events.push({
          ...base(makeEventId(sid, 'tool', callId, 'result')),
          kind: 'tool.completed',
          callId,
          toolName: `mcp__${server}__${tool}`,
          result: {
            kind: 'generic',
            excerpt: excerpt(JSON.stringify(result ?? {}), 600, 200).text,
          },
          isError,
        });
        this.calls.delete(callId);
        return events;
      }
      case 'web_search_end': {
        const callId = asString(p.call_id) ?? `web-${lineNo}`;
        const query = asString(p.query) ?? '';
        return [
          {
            ...base(makeEventId(sid, 'tool', callId, 'call')),
            kind: 'tool.called',
            callId,
            toolName: 'web_search',
            input: { kind: 'webSearch', target: query },
            title: `Web search: ${query}`,
          },
          {
            ...base(makeEventId(sid, 'tool', callId, 'result')),
            kind: 'tool.completed',
            callId,
            toolName: 'web_search',
            result: { kind: 'generic' },
            isError: false,
          },
        ];
      }
      case 'exec_command_end': {
        const callId = asString(p.call_id) ?? `exec-${lineNo}`;
        const code = typeof p.exit_code === 'number' ? p.exit_code : undefined;
        const out = `${asString(p.stdout) ?? asString(p.aggregated_output) ?? ''}${asString(p.stderr) ? `\n${asString(p.stderr)}` : ''}`;
        const ex = excerpt(out);
        return [
          {
            ...base(makeEventId(sid, 'tool', callId, 'result')),
            kind: 'tool.completed',
            callId,
            toolName: 'exec_command',
            result: {
              kind: 'command',
              exit:
                code === undefined ? { observation: 'unknown' } : { code, observation: 'explicit' },
              outputExcerpt: ex.text,
              outputChars: out.length,
              truncated: ex.truncated,
            },
            isError: code !== undefined && code !== 0,
          },
        ];
      }
      case 'context_compacted':
        return [{ ...base(makeEventId(sid, 'compact', lineNo)), kind: 'compaction' }];
      case 'sub_agent_activity': {
        const agentId = asString(p.agent_thread_id);
        if (!agentId) return [];
        const path = asString(p.agent_path);
        if (path) this.agentThreadByPath.set(path, agentId);
        const kind = asString(p.kind);
        if (kind === 'started')
          return [
            {
              ...base(makeEventId(sid, 'subagent', agentId, 'start')),
              kind: 'subagent.started',
              subagentId: agentId,
              description: asString(p.agent_path),
            },
          ];
        // An interrupted lane is finished, and saying so is the difference between a subagent that
        // is still working and one that stopped. `interacted` is neither and is not an event.
        if (kind === 'interrupted')
          return [
            {
              ...base(makeEventId(sid, 'subagent', agentId, 'end')),
              kind: 'subagent.ended',
              subagentId: agentId,
            },
          ];
        return [];
      }
      default:
        return [];
    }
  }

  private parseResponseItem(
    p: Record<string, unknown>,
    base: BaseFn,
    lineNo: number,
  ): CanonicalEvent[] {
    const sid = this.ctx.sessionId;
    const t = asString(p.type);
    const passthrough = asObject(p.internal_chat_message_metadata_passthrough);
    const turnIdHint = asString(passthrough?.turn_id);
    if (turnIdHint) this.currentTurnId = turnIdHint;
    switch (t) {
      case 'function_call': {
        const callId = asString(p.call_id) ?? `fc-${lineNo}`;
        const name = asString(p.name) ?? 'function';
        const args = asObject(safeJson(asString(p.arguments) ?? '{}')) ?? {};
        return this.functionCall(callId, name, args, base);
      }
      case 'function_call_output': {
        const callId = asString(p.call_id) ?? `fc-${lineNo}`;
        const call = this.calls.get(callId);
        const output = outputText(p.output);
        this.calls.delete(callId);
        if (!call) return [];
        if (call.toolName === 'wait' || call.toolName === 'write_stdin')
          return this.pollResult(call, output, base);
        if (call.input.kind === 'command') {
          const parsed = parseExecOutput(output);
          this.trackRunning(callId, call.toolName, parsed);
          return [this.commandCompleted(callId, call.toolName, parsed, base)];
        }
        if (call.input.kind === 'plan') return [];
        return [
          {
            ...base(makeEventId(sid, 'tool', callId, 'result')),
            kind: 'tool.completed',
            callId,
            toolName: call.toolName,
            result: { kind: 'generic', excerpt: excerpt(output, 600, 200).text },
            isError: false,
          },
        ];
      }
      case 'custom_tool_call': {
        const callId = asString(p.call_id) ?? `ctc-${lineNo}`;
        const name = asString(p.name) ?? 'custom';
        const input = asString(p.input) ?? '';
        if (name === 'apply_patch') {
          const paths = patchPaths(input);
          const first = paths[0] ?? 'files';
          const call: ToolInput = { kind: 'fileEdit', path: first };
          this.calls.set(callId, {
            toolName: 'apply_patch',
            input: call,
            turnId: this.currentTurnId,
          });
          return [
            {
              ...base(makeEventId(sid, 'tool', callId, 'call')),
              kind: 'tool.called',
              callId,
              toolName: 'apply_patch',
              input: call,
              title: `Edit ${paths.length <= 1 ? first : `${paths.length} files`}`,
            },
          ];
        }
        if (name === 'exec') {
          const polls = codeCellPoll(input);
          // Only when the command it polls is one we saw yield. A handle we never saw start
          // cannot be attributed to anything, and silently filing the cell under it would drop
          // whatever the poll returned. Unlinkable, it stays a cell.
          if (polls && this.pending.has(runningHandleKey(polls))) {
            // Not an activity of its own: the output belongs to the command that yielded.
            this.calls.set(callId, {
              toolName: 'exec',
              input: { kind: 'other', summary: 'poll' },
              turnId: this.currentTurnId,
              polls,
            });
            return [];
          }
          const cmds = extractCodeCellCommands(input);
          const command = cmds.length
            ? cmds.join(' && ')
            : (input.trim().split('\n')[0] ?? 'code cell');
          const call: ToolInput = {
            kind: 'command',
            command,
            description:
              cmds.length > 1
                ? `Code cell with ${cmds.length} commands`
                : cmds.length === 0
                  ? 'Code cell'
                  : undefined,
          };
          this.calls.set(callId, { toolName: 'exec', input: call, turnId: this.currentTurnId });
          const title = cmds.length
            ? `Run: ${excerpt(cmds[0] ?? '', 120, 0).text}${cmds.length > 1 ? ` (+${cmds.length - 1} more)` : ''}`
            : 'Code cell';
          return [
            {
              ...base(makeEventId(sid, 'tool', callId, 'call')),
              kind: 'tool.called',
              callId,
              toolName: 'exec',
              input: call,
              title,
            },
          ];
        }
        const call: ToolInput = { kind: 'other', summary: name };
        this.calls.set(callId, { toolName: name, input: call, turnId: this.currentTurnId });
        return [
          {
            ...base(makeEventId(sid, 'tool', callId, 'call')),
            kind: 'tool.called',
            callId,
            toolName: name,
            input: call,
            title: name,
          },
        ];
      }
      case 'custom_tool_call_output': {
        const callId = asString(p.call_id) ?? `ctc-${lineNo}`;
        const call = this.calls.get(callId);
        const output = outputText(p.output);
        this.calls.delete(callId);
        if (!call) return [];
        if (call.polls) return this.pollResult(call, output, base);
        if (call.toolName === 'exec') {
          const parsed = parseExecOutput(output);
          this.trackRunning(callId, 'exec', parsed);
          return [this.commandCompleted(callId, 'exec', parsed, base)];
        }
        if (call.toolName === 'apply_patch') {
          // patch_apply_end carries the structured changes; this output is just the text summary.
          if (this.calls.has(callId)) return [];
          return [];
        }
        return [
          {
            ...base(makeEventId(sid, 'tool', callId, 'result')),
            kind: 'tool.completed',
            callId,
            toolName: call.toolName,
            result: { kind: 'generic', excerpt: excerpt(output, 600, 200).text },
            isError: false,
          },
        ];
      }
      case 'agent_message':
        return this.interAgentMessage(p, base, lineNo);
      default:
        return []; // message, reasoning: covered by event_msg records in legacy mode
    }
  }

  /**
   * A message from one agent to another, in Codex's multi-agent mode.
   *
   * These were dropped by the `default` above, on the reasoning that `agent_message` arrives on
   * `event_msg` records too. It does, but that is a different thing: `event_msg/agent_message` is
   * the *root* agent narrating to the user, while `response_item/agent_message` always carries an
   * `author` and is one agent reporting to another. `FINAL_ANSWER` payloads are the subagents'
   * actual write-ups of what they did and must not be dropped.
   *
   * Most of the traffic genuinely cannot be read: `MESSAGE` (316) and `NEW_TASK` (134) carry their
   * body as `encrypted_content`, and there is no key here. Those still produce nothing, which is
   * correct rather than lossy. `FINAL_ANSWER` is plaintext, and it is the half worth having: the
   * result, attributed to the agent that produced it.
   */
  private interAgentMessage(
    p: Record<string, unknown>,
    base: BaseFn,
    lineNo: number,
  ): CanonicalEvent[] {
    const author = asString(p.author);
    if (!author) return [];
    const parts = Array.isArray(p.content) ? p.content : [];
    const text = parts
      .map((c) => (asObject(c) ? (asString(asObject(c)?.text) ?? '') : ''))
      .join('')
      .trim();
    // The header names the sender and the kind; the payload after it is the message.
    const kind = /^Message Type:\s*(\w+)/m.exec(text)?.[1] ?? '';
    const body = text.replace(/^[\s\S]*?^Payload:\s*$/m, '').trim();
    if (!body) return []; // encrypted, or a bare header with nothing readable behind it
    const sid = this.ctx.sessionId;
    const final = kind === 'FINAL_ANSWER';
    const ex = excerpt(body, 6000, 2000);
    /*
     * The lane this belongs to is the one `sub_agent_activity` opened, identified by thread id.
     * The path is all the message carries, so it is resolved through the map built there. Falling
     * back to the path keeps a report that arrives without a matching start attributable rather
     * than anonymous, which is the better failure of the two.
     */
    const lane = this.agentThreadByPath.get(author) ?? author;
    const message: CanonicalEvent = {
      ...base(makeEventId(sid, 'agentmsg', author, lineNo)),
      kind: 'agent.message',
      // Attributed to the agent that wrote it, which keeps it out of the root agent's narration
      // and lets the projection show it as that subagent's own account.
      agentId: lane,
      text: ex.text,
      truncated: ex.truncated || undefined,
      phase: final ? 'final' : 'commentary',
    };
    if (!final) return [message];
    // A final answer is the only completion signal Codex gives: `sub_agent_activity` has
    // `started`, `interacted` and `interrupted`, and nothing that means "done".
    return [
      message,
      {
        ...base(makeEventId(sid, 'subagent', lane, 'end')),
        kind: 'subagent.ended',
        subagentId: lane,
        lastMessage: ex.text.slice(0, 600),
      },
    ];
  }

  private functionCall(
    callId: string,
    name: string,
    args: Record<string, unknown>,
    base: BaseFn,
  ): CanonicalEvent[] {
    const sid = this.ctx.sessionId;
    const remember = (toolName: string, input: ToolInput) =>
      this.calls.set(callId, { toolName, input, turnId: this.currentTurnId });
    switch (name) {
      case 'shell':
      case 'shell_command':
      case 'exec_command':
      case 'container.exec': {
        const command = parseShellFunctionArgs(args);
        const input: ToolInput = {
          kind: 'command',
          command,
          cwd: asString(args.workdir) ?? asString(args.cwd),
        };
        remember(name, input);
        return [
          {
            ...base(makeEventId(sid, 'tool', callId, 'call')),
            kind: 'tool.called',
            callId,
            toolName: name,
            input,
            title: `Run: ${excerpt(command.split('\n')[0] ?? '', 120, 0).text}`,
          },
        ];
      }
      case 'wait':
      case 'write_stdin':
        // Polls of a still-running command; not activities of their own. The output is the
        // original command's late result (see pollResult).
        this.calls.set(callId, {
          toolName: name,
          input: { kind: 'other', summary: name },
          turnId: this.currentTurnId,
          polls: runningHandleFromArgs(name, args),
        });
        return [];
      case 'update_plan': {
        const explanation = asString(args.explanation);
        const plan = Array.isArray(args.plan) ? args.plan : [];
        const items: PlanItem[] = [];
        plan.forEach((s, i) => {
          const o = asObject(s);
          const text = asString(o?.step) ?? '';
          if (!text) return;
          const st = asString(o?.status);
          items.push({
            id: `step-${i}`,
            text,
            status:
              st === 'in_progress' ? 'in_progress' : st === 'completed' ? 'completed' : 'pending',
          });
        });
        remember(name, { kind: 'plan' });
        if (items.length === 0) return [];
        return [
          {
            ...base(makeEventId(sid, 'plan', callId)),
            kind: 'plan.updated',
            mode: 'replace',
            items,
            explanation,
          },
        ];
      }
      case 'spawn_agent': {
        const input: ToolInput = {
          kind: 'subagent',
          description: asString(args.task_name) ?? asString(args.name),
          agentType: asString(args.agent_type),
        };
        remember(name, input);
        return [
          {
            ...base(makeEventId(sid, 'tool', callId, 'call')),
            kind: 'tool.called',
            callId,
            toolName: name,
            input,
            title: `Delegate: ${input.description ?? 'agent'}`,
          },
        ];
      }
      case 'view_image': {
        const input: ToolInput = { kind: 'fileRead', path: asString(args.path) ?? '' };
        remember(name, input);
        return [
          {
            ...base(makeEventId(sid, 'tool', callId, 'call')),
            kind: 'tool.called',
            callId,
            toolName: name,
            input,
            title: `View ${input.path}`,
          },
        ];
      }
      default: {
        const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
        const pathMetadata = mcp ? pathArgumentMetadata(args) : undefined;
        const input: ToolInput = mcp
          ? {
              kind: 'mcp',
              server: mcp[1] ?? '',
              tool: mcp[2] ?? '',
              pathArgs: pathMetadata?.paths.length ? pathMetadata.paths : undefined,
              pathArgsTruncated: pathMetadata?.truncated || undefined,
              argsExcerpt: excerpt(JSON.stringify(args), 300, 0).text,
            }
          : { kind: 'other', summary: name };
        remember(name, input);
        return [
          {
            ...base(makeEventId(sid, 'tool', callId, 'call')),
            kind: 'tool.called',
            callId,
            toolName: name,
            input,
            title: mcp ? `${mcp[1]}: ${mcp[2]}` : name,
          },
        ];
      }
    }
  }

  /** Builds the `tool.completed` for a command result; `final` marks a late result of a running command. */
  private commandCompleted(
    callId: string,
    toolName: string,
    parsed: ParsedExecOutput,
    base: BaseFn,
    final = false,
  ): CanonicalEvent {
    const ex = excerpt(parsed.body);
    const id = final
      ? makeEventId(this.ctx.sessionId, 'tool', callId, 'result', 'final')
      : makeEventId(this.ctx.sessionId, 'tool', callId, 'result');
    return {
      ...base(id),
      kind: 'tool.completed',
      callId,
      toolName,
      result: {
        kind: 'command',
        exit: parsed.exit,
        outputExcerpt: ex.text,
        outputChars: parsed.body.length,
        truncated: ex.truncated || parsed.truncated,
      },
      isError:
        parsed.exit.observation === 'inferred-failure' ||
        (parsed.exit.observation === 'explicit' && (parsed.exit.code ?? 0) !== 0),
    };
  }

  /** Remembers a command whose call yielded while still running, keyed by its poll handle. */
  private trackRunning(callId: string, toolName: string, parsed: ParsedExecOutput): void {
    if (!parsed.running) return;
    const existing =
      this.lastRunning?.callId === callId
        ? this.lastRunning
        : [...this.pending.values()].find((c) => c.callId === callId);
    const cmd: PendingCommand = existing ?? {
      callId,
      toolName,
      chunks: parsed.body ? [parsed.body] : [],
    };
    this.pending.set(runningHandleKey(parsed.running), cmd);
    this.lastRunning = cmd;
  }

  /**
   * Output of a `wait` / `write_stdin` call: either the command is still running (nothing to
   * report yet) or this is the real result of the command that yielded earlier, emitted as a
   * distinct `…:result:final` completion for that command's call id.
   */
  private pollResult(call: RememberedCall, output: string, base: BaseFn): CanonicalEvent[] {
    const parsed = parseExecOutput(output);
    const key = call.polls ? runningHandleKey(call.polls) : undefined;
    let target = key ? this.pending.get(key) : undefined;
    if (!target && !call.polls) target = this.lastRunning; // handle-less poll: last thing still running
    if (target && parsed.body) target.chunks.push(parsed.body);
    if (parsed.running) {
      // Still running: keep (or refresh) the handle → call mapping and wait for a later poll.
      if (target) {
        this.pending.set(runningHandleKey(parsed.running), target);
        this.lastRunning = target;
      }
      return [];
    }
    if (!target) return [];
    if (key) this.pending.delete(key);
    for (const [k, v] of this.pending) if (v.callId === target.callId) this.pending.delete(k);
    if (this.lastRunning?.callId === target.callId) this.lastRunning = undefined;
    // The whole log the command produced, not just the chunk that happened to close it.
    const whole: ParsedExecOutput = { ...parsed, body: target.chunks.join('') };
    return [this.commandCompleted(target.callId, target.toolName, whole, base, true)];
  }
}

function recordHash(line: string): string {
  return `sha256:${createHash('sha256').update(line).digest('hex')}`;
}

function outputText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((b) => asString(asObject(b)?.text) ?? '').join('');
  return '';
}

function sourceLabel(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  const o = asObject(v);
  if (!o) return undefined;
  return Object.keys(o)[0];
}

export type { ExitStatus };
