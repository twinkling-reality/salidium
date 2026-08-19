import type { HookParseContext } from '@salidium/adapter-kit';
import { asObject, asString, excerpt, pathArgumentMetadata } from '@salidium/adapter-kit';
import {
  type CanonicalEvent,
  type EventSource,
  makeEventId,
  makeSessionId,
  type PlanItem,
  type ToolInput,
} from '@salidium/protocol';
import { patchPaths } from './toolMapping.ts';

/** Codex hook events Salidium subscribes to (config in ~/.codex/hooks.json). */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'PostCompact',
  'SessionEnd',
] as const;

/**
 * Codex hooks use the Claude Code wire shape (session_id, transcript_path, cwd, hook_event_name,
 * tool_name, tool_input, tool_response, tool_use_id, last_assistant_message) plus `model` and
 * `turn_id`. Tool names differ: shell/exec match as `Bash`, patches as `apply_patch`, MCP as
 * `mcp__server__tool`, plus local tools like `update_plan`.
 */
export function parseCodexHookPayload(payload: unknown, ctx: HookParseContext): CanonicalEvent[] {
  const p = asObject(payload);
  if (!p) return [];
  const providerSessionId = asString(p.session_id);
  const eventName = asString(p.hook_event_name);
  if (!providerSessionId || !eventName) return [];
  const sessionId = makeSessionId('codex', providerSessionId);
  const ts = ctx.receivedAt;
  const agentId = asString(p.agent_id);
  const turnId = asString(p.turn_id);
  const source: EventSource = { provider: 'codex', channel: 'hook' };
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
    case 'SessionStart':
      return [
        {
          ...base(
            makeEventId(sessionId, 'session', 'start', asString(p.source) ?? 'startup', stamp),
          ),
          agentId: undefined,
          kind: 'session.started',
          cwd: asString(p.cwd) ?? '',
          model: asString(p.model),
          reason: asString(p.source),
          transcriptPath: asString(p.transcript_path) ?? undefined,
        },
      ];
    case 'UserPromptSubmit': {
      const prompt = asString(p.prompt) ?? '';
      const id = turnId ?? `h${stamp}`;
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
      const toolName = asString(p.tool_name) ?? 'tool';
      if (!callId) return [];
      const mapped = mapCodexToolInput(toolName, p.tool_input);
      const events: CanonicalEvent[] = [
        {
          ...base(makeEventId(sessionId, 'tool', callId, 'call')),
          kind: 'tool.called',
          callId,
          toolName,
          input: mapped.input,
          title: mapped.title,
        },
      ];
      const plan = planFromToolInput(toolName, p.tool_input);
      if (plan)
        events.push({
          ...base(makeEventId(sessionId, 'plan', callId)),
          kind: 'plan.updated',
          mode: 'replace',
          items: plan.items,
          explanation: plan.explanation,
        });
      return events;
    }
    case 'PostToolUse': {
      const callId = asString(p.tool_use_id);
      const toolName = asString(p.tool_name) ?? 'tool';
      if (!callId) return [];
      const mapped = mapCodexToolInput(toolName, p.tool_input);
      const response = p.tool_response;
      // Hook results are lower fidelity than the rollout's (no exit code, no diff hunks), so
      // they get their own id: the rollout's `tool:<callId>:result` is stored alongside and can
      // upgrade this provisional result. `tool.called` keeps the canonical id (inputs match).
      const resultId = makeEventId(sessionId, 'tool', callId, 'result', 'hook');
      if (mapped.input.kind === 'command') {
        const text =
          typeof response === 'string'
            ? response
            : response === undefined
              ? ''
              : JSON.stringify(response);
        const ex = excerpt(text);
        const failed = /command timed out/i.test(text.slice(0, 200));
        return [
          {
            ...base(resultId),
            kind: 'tool.completed',
            callId,
            toolName,
            result: {
              kind: 'command',
              exit: { observation: 'unknown' },
              outputExcerpt: ex.text,
              outputChars: text.length,
              truncated: ex.truncated,
              timedOut: failed || undefined,
            },
            isError: false,
          },
        ];
      }
      if (mapped.input.kind === 'fileEdit') {
        const paths = patchPaths(asString(asObject(p.tool_input)?.command) ?? '');
        const text = typeof response === 'string' ? response : '';
        const applied = !/failed|error/i.test(text.slice(0, 200));
        return [
          {
            ...base(resultId),
            kind: 'tool.completed',
            callId,
            toolName,
            result: {
              kind: 'fileChanges',
              changes: paths.map((path) => ({
                path,
                change: 'update' as const,
                linesAdded: 0,
                linesRemoved: 0,
                applied,
              })),
            },
            isError: !applied,
          },
        ];
      }
      const text =
        typeof response === 'string'
          ? response
          : response === undefined
            ? ''
            : JSON.stringify(response);
      const isError = asObject(response)?.isError === true;
      return [
        {
          ...base(resultId),
          kind: 'tool.completed',
          callId,
          toolName,
          result: { kind: 'generic', excerpt: text ? excerpt(text, 600, 200).text : undefined },
          isError,
        },
      ];
    }
    case 'PermissionRequest': {
      const toolName = asString(p.tool_name) ?? 'tool';
      const mapped = mapCodexToolInput(toolName, p.tool_input);
      return [
        {
          ...base(makeEventId(sessionId, 'perm', stamp)),
          kind: 'permission.requested',
          toolName,
          summary: mapped.title,
        },
      ];
    }
    case 'SubagentStart':
      return agentId
        ? [
            {
              ...base(makeEventId(sessionId, 'subagent', agentId, 'start')),
              agentId: undefined,
              kind: 'subagent.started',
              subagentId: agentId,
              agentType: asString(p.agent_type),
            },
          ]
        : [];
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
    case 'PostCompact':
      return [
        {
          ...base(makeEventId(sessionId, 'compact', 'hook', stamp)),
          kind: 'compaction',
          trigger: asString(p.trigger),
        },
      ];
    case 'SessionEnd':
      return [
        {
          ...base(makeEventId(sessionId, 'session', 'end', stamp)),
          agentId: undefined,
          kind: 'session.ended',
          reason: asString(p.reason),
        },
      ];
    default:
      return [];
  }
}

export function mapCodexToolInput(
  toolName: string,
  rawInput: unknown,
): { input: ToolInput; title: string } {
  const input = asObject(rawInput) ?? {};
  if (
    toolName === 'Bash' ||
    toolName === 'shell' ||
    toolName === 'exec_command' ||
    toolName === 'shell_command'
  ) {
    const command = asString(input.command) ?? asString(input.cmd) ?? '';
    return {
      input: { kind: 'command', command, cwd: asString(input.workdir) },
      title: `Run: ${excerpt(command.split('\n')[0] ?? '', 120, 0).text}`,
    };
  }
  if (toolName === 'apply_patch' || toolName === 'Edit' || toolName === 'Write') {
    const paths = patchPaths(asString(input.command) ?? asString(input.patch) ?? '');
    const first = paths[0] ?? asString(input.file_path) ?? 'files';
    return {
      input: { kind: 'fileEdit', path: first },
      title: `Edit ${paths.length <= 1 ? first : `${paths.length} files`}`,
    };
  }
  if (toolName === 'update_plan') return { input: { kind: 'plan' }, title: 'Update plan' };
  if (toolName === 'spawn_agent' || toolName === 'Agent')
    return {
      input: { kind: 'subagent', description: asString(input.task_name) },
      title: `Delegate: ${asString(input.task_name) ?? 'agent'}`,
    };
  if (toolName === 'view_image')
    return {
      input: { kind: 'fileRead', path: asString(input.path) ?? '' },
      title: `View ${asString(input.path) ?? ''}`,
    };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) {
    const pathMetadata = pathArgumentMetadata(input);
    return {
      input: {
        kind: 'mcp',
        server: mcp[1] ?? '',
        tool: mcp[2] ?? '',
        pathArgs: pathMetadata.paths.length ? pathMetadata.paths : undefined,
        pathArgsTruncated: pathMetadata.truncated || undefined,
        argsExcerpt: excerpt(JSON.stringify(input), 300, 0).text,
      },
      title: `${mcp[1]}: ${mcp[2]}`,
    };
  }
  return { input: { kind: 'other', summary: toolName }, title: toolName };
}

function planFromToolInput(
  toolName: string,
  rawInput: unknown,
): { items: PlanItem[]; explanation?: string } | undefined {
  if (toolName !== 'update_plan') return undefined;
  const input = asObject(rawInput) ?? {};
  const plan = Array.isArray(input.plan) ? input.plan : [];
  const items: PlanItem[] = [];
  plan.forEach((s, i) => {
    const o = asObject(s);
    const text = asString(o?.step) ?? '';
    if (!text) return;
    const st = asString(o?.status);
    items.push({
      id: `step-${i}`,
      text,
      status: st === 'in_progress' ? 'in_progress' : st === 'completed' ? 'completed' : 'pending',
    });
  });
  return items.length ? { items, explanation: asString(input.explanation) } : undefined;
}

export function transcriptPathFromCodexHook(
  payload: unknown,
): { sessionId: string; path: string; cwd?: string } | undefined {
  const p = asObject(payload);
  const providerSessionId = asString(p?.session_id);
  const path = asString(p?.transcript_path);
  if (!p || !providerSessionId || !path) return undefined;
  return { sessionId: makeSessionId('codex', providerSessionId), path, cwd: asString(p.cwd) };
}
