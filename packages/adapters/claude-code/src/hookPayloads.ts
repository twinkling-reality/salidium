import type { HookParseContext } from '@salidium/adapter-kit';
import { asObject, asString, excerpt } from '@salidium/adapter-kit';
import {
  type CanonicalEvent,
  type EventSource,
  makeEventId,
  makeSessionId,
} from '@salidium/protocol';
import { mapPlanUpdate, mapToolInput, mapToolResult, parseFailure } from './toolMapping.ts';

/** Hook events Salidium subscribes to (see hookConfig.ts). */
export const CLAUDE_CODE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'StopFailure',
  'PostCompact',
  'CwdChanged',
  'SessionEnd',
] as const;

/**
 * Normalizes one Claude Code hook payload (the JSON Claude Code writes to the hook's stdin)
 * into canonical events. Tool observations keep a `hook` suffix so the durable transcript can be
 * retained too; the reducer reconciles the pair by deterministic information/source fidelity.
 */
export function parseClaudeCodeHookPayload(
  payload: unknown,
  ctx: HookParseContext,
): CanonicalEvent[] {
  const p = asObject(payload);
  if (!p) return [];
  const providerSessionId = asString(p.session_id);
  const eventName = asString(p.hook_event_name);
  if (!providerSessionId || !eventName) return [];
  const sessionId = makeSessionId('claude-code', providerSessionId);
  const ts = ctx.receivedAt;
  const agentId = asString(p.agent_id);
  const turnId = asString(p.prompt_id);
  const source: EventSource = { provider: 'claude-code', channel: 'hook' };
  const base = (id: string) => ({
    id,
    sessionId,
    ts,
    tsSource: 'ingest' as const,
    agentId,
    turnId,
    source,
  });
  const stamp = ts.replace(/[^0-9]/g, '');

  switch (eventName) {
    case 'SessionStart': {
      const reason = asString(p.source) ?? 'startup';
      return [
        {
          ...base(makeEventId(sessionId, 'session', 'start', reason, stamp)),
          agentId: undefined,
          kind: 'session.started',
          cwd: asString(p.cwd) ?? '',
          model: asString(p.model),
          reason,
          title: asString(p.session_title),
          transcriptPath: asString(p.transcript_path),
        },
      ];
    }
    case 'UserPromptSubmit': {
      const prompt = asString(p.prompt) ?? '';
      const id = turnId ?? `h${fnv(prompt)}`;
      const ex = excerpt(prompt, 4000, 1000);
      return [
        {
          ...base(makeEventId(sessionId, 'turn', id, 'start')),
          turnId: id,
          kind: 'turn.started',
          prompt: ex.text,
          promptTruncated: ex.truncated || undefined,
        },
      ];
    }
    case 'PreToolUse': {
      const callId = asString(p.tool_use_id);
      const toolName = asString(p.tool_name) ?? 'unknown';
      if (!callId) return [];
      const mapped = mapToolInput(toolName, p.tool_input);
      return [
        {
          ...base(makeEventId(sessionId, 'tool', callId, 'call', 'hook')),
          kind: 'tool.called',
          callId,
          toolName,
          input: mapped.input,
          title: mapped.title,
        },
      ];
    }
    case 'PostToolUse': {
      const callId = asString(p.tool_use_id);
      const toolName = asString(p.tool_name) ?? 'unknown';
      if (!callId) return [];
      const mapped = mapToolResult(
        toolName,
        p.tool_input,
        p.tool_response,
        typeof p.tool_response === 'string' ? p.tool_response : undefined,
      );
      const durationMs = typeof p.duration_ms === 'number' ? Math.round(p.duration_ms) : undefined;
      const events: CanonicalEvent[] = [
        {
          ...base(makeEventId(sessionId, 'tool', callId, 'result', 'hook')),
          kind: 'tool.completed',
          callId,
          toolName,
          result: mapped.result,
          isError: false,
          durationMs,
        },
      ];
      const plan = mapPlanUpdate(toolName, p.tool_input, p.tool_response);
      if (plan && plan.items.length > 0 && !agentId)
        events.push({
          ...base(makeEventId(sessionId, 'plan', callId)),
          kind: 'plan.updated',
          mode: plan.mode,
          items: plan.items,
        });
      return events;
    }
    case 'PostToolUseFailure': {
      const callId = asString(p.tool_use_id);
      const toolName = asString(p.tool_name) ?? 'unknown';
      if (!callId) return [];
      const f = parseFailure(asString(p.error) ?? 'error');
      const durationMs = typeof p.duration_ms === 'number' ? Math.round(p.duration_ms) : undefined;
      return [
        {
          ...base(makeEventId(sessionId, 'tool', callId, 'failed', 'hook')),
          kind: 'tool.failed',
          callId,
          toolName,
          errorExcerpt: f.errorExcerpt,
          cause: p.is_interrupt === true ? 'interrupted' : f.cause,
          exit: f.exit,
          interrupted: p.is_interrupt === true || f.interrupted,
          durationMs,
        },
      ];
    }
    case 'PermissionRequest': {
      const toolName = asString(p.tool_name) ?? 'tool';
      const mapped = mapToolInput(toolName, p.tool_input);
      return [
        {
          ...base(makeEventId(sessionId, 'perm', stamp)),
          kind: 'permission.requested',
          toolName,
          summary: mapped.title,
        },
      ];
    }
    case 'Notification': {
      const message = asString(p.message) ?? '';
      const notificationType = asString(p.notification_type);
      return [
        {
          ...base(makeEventId(sessionId, 'notif', notificationType ?? 'n', stamp)),
          kind: 'notification',
          notificationType,
          message: excerpt(message, 300, 0).text,
        },
      ];
    }
    case 'SubagentStart': {
      if (!agentId) return [];
      return [
        {
          ...base(makeEventId(sessionId, 'subagent', agentId, 'start')),
          agentId: undefined,
          kind: 'subagent.started',
          subagentId: agentId,
          agentType: asString(p.agent_type),
        },
      ];
    }
    case 'SubagentStop': {
      if (!agentId) return [];
      const last = asString(p.last_assistant_message);
      return [
        {
          ...base(makeEventId(sessionId, 'subagent', agentId, 'end')),
          agentId: undefined,
          kind: 'subagent.ended',
          subagentId: agentId,
          lastMessage: last ? excerpt(last, 1500, 500).text : undefined,
        },
      ];
    }
    case 'TaskCreated': {
      const id = asString(p.task_id);
      const text = asString(p.task_subject) ?? '';
      if (!id || !text) return [];
      return [
        {
          ...base(makeEventId(sessionId, 'plan', 'hook', 'created', id)),
          kind: 'plan.updated',
          mode: 'merge',
          items: [{ id, text, status: 'pending' }],
        },
      ];
    }
    case 'TaskCompleted': {
      const id = asString(p.task_id);
      if (!id) return [];
      return [
        {
          ...base(makeEventId(sessionId, 'plan', 'hook', 'completed', id)),
          kind: 'plan.updated',
          mode: 'merge',
          items: [{ id, text: asString(p.task_subject) ?? '', status: 'completed' }],
        },
      ];
    }
    case 'Stop': {
      if (!turnId) return [];
      const last = asString(p.last_assistant_message);
      return [
        {
          ...base(makeEventId(sessionId, 'turn', turnId, 'end')),
          kind: 'turn.ended',
          outcome: 'completed',
          lastMessage: last ? excerpt(last, 6000, 2000).text : undefined,
        },
      ];
    }
    case 'StopFailure': {
      if (!turnId) return [];
      const error = [asString(p.error), asString(p.error_description)].filter(Boolean).join(': ');
      return [
        {
          ...base(makeEventId(sessionId, 'turn', turnId, 'end')),
          kind: 'turn.ended',
          outcome: 'failed',
          error: error || 'error',
        },
      ];
    }
    case 'PostCompact': {
      const summary = asString(p.compact_summary);
      return [
        {
          ...base(makeEventId(sessionId, 'compact', 'hook', stamp)),
          kind: 'compaction',
          trigger: asString(p.trigger),
          summaryExcerpt: summary ? excerpt(summary, 1500, 0).text : undefined,
        },
      ];
    }
    case 'CwdChanged': {
      const cwd = asString(p.new_cwd);
      if (!cwd) return [];
      return [
        { ...base(makeEventId(sessionId, 'session', 'cwd', stamp)), kind: 'session.updated', cwd },
      ];
    }
    case 'SessionEnd': {
      return [
        {
          ...base(makeEventId(sessionId, 'session', 'end', stamp)),
          agentId: undefined,
          kind: 'session.ended',
          reason: asString(p.reason),
        },
      ];
    }
    default:
      return [];
  }
}

export function transcriptPathFromClaudeCodeHook(
  payload: unknown,
):
  | { sessionId: string; path: string; cwd?: string; agentPath?: string; agentId?: string }
  | undefined {
  const p = asObject(payload);
  const providerSessionId = asString(p?.session_id);
  const path = asString(p?.transcript_path);
  if (!p || !providerSessionId || !path) return undefined;
  return {
    sessionId: makeSessionId('claude-code', providerSessionId),
    path,
    cwd: asString(p.cwd),
    agentPath: asString(p.agent_transcript_path),
    agentId: asString(p.agent_id),
  };
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
