import type {
  CanonicalEvent,
  FileChange,
  PlanItem,
  StoredEvent,
  ToolInput,
  ToolResult,
} from '@salidium/protocol';

/**
 * Small builders for synthetic event streams in tests. They mimic what a provider adapter
 * produces so reducer tests read like scenarios.
 */
export class EventBuilder {
  private seq = 0;
  private clock: number;
  readonly sessionId: string;
  private turn = 0;
  private turnId: string | undefined;

  constructor(sessionId = 'claude-code:test-session', startIso = '2026-08-16T10:30:00.000Z') {
    this.sessionId = sessionId;
    this.clock = Date.parse(startIso);
  }

  private base(id: string, secondsLater = 5) {
    this.clock += secondsLater * 1000;
    return {
      id: `${this.sessionId}#${id}`,
      sessionId: this.sessionId,
      ts: new Date(this.clock).toISOString(),
      tsSource: 'provider' as const,
      turnId: this.turnId,
      source: { provider: 'claude-code' as const, channel: 'transcript' as const },
    };
  }

  private stored(e: CanonicalEvent): StoredEvent {
    return { ...e, seq: this.seq++ } as StoredEvent;
  }

  sessionStarted(cwd = '/repo/app', model = 'test-model'): StoredEvent {
    return this.stored({
      ...this.base('session:start', 0),
      kind: 'session.started',
      cwd,
      model,
      reason: 'startup',
    });
  }

  turnStarted(prompt: string): StoredEvent {
    this.turn += 1;
    this.turnId = `p${this.turn}`;
    return this.stored({ ...this.base(`turn:${this.turnId}:start`), kind: 'turn.started', prompt });
  }

  message(text: string, phase: 'commentary' | 'final' = 'commentary'): StoredEvent {
    return this.stored({ ...this.base(`msg:${this.seq}`), kind: 'agent.message', text, phase });
  }

  turnEnded(
    lastMessage?: string,
    outcome: 'completed' | 'interrupted' | 'failed' = 'completed',
    error?: string,
  ): StoredEvent {
    return this.stored({
      ...this.base(`turn:${this.turnId}:end`),
      kind: 'turn.ended',
      lastMessage,
      outcome,
      error,
    });
  }

  toolCalled(callId: string, toolName: string, input: ToolInput, title?: string): StoredEvent {
    return this.stored({
      ...this.base(`tool:${callId}:call`, 2),
      kind: 'tool.called',
      callId,
      toolName,
      input,
      title: title ?? defaultTitle(input),
    });
  }

  toolCompleted(
    callId: string,
    toolName: string,
    result: ToolResult,
    isError = false,
    durationMs?: number,
  ): StoredEvent {
    return this.stored({
      ...this.base(`tool:${callId}:result`, 3),
      kind: 'tool.completed',
      callId,
      toolName,
      result,
      isError,
      durationMs,
    });
  }

  toolFailed(
    callId: string,
    toolName: string,
    errorExcerpt: string,
    exitCode?: number,
    interrupted = false,
  ): StoredEvent {
    return this.stored({
      ...this.base(`tool:${callId}:failed`, 3),
      kind: 'tool.failed',
      callId,
      toolName,
      errorExcerpt,
      cause: interrupted ? 'interrupted' : 'error',
      exit: exitCode === undefined ? undefined : { code: exitCode, observation: 'explicit' },
      interrupted,
    });
  }

  edit(
    callId: string,
    path: string,
    added: number,
    removed: number,
    hunkLines?: string[],
  ): StoredEvent[] {
    const change: FileChange = {
      path,
      change: 'update',
      linesAdded: added,
      linesRemoved: removed,
      applied: true,
      hunks: [
        {
          oldStart: 1,
          oldLines: removed + 1,
          newStart: 1,
          newLines: added + 1,
          lines: hunkLines ?? [
            ' context',
            ...Array(removed).fill('-old'),
            ...Array(added).fill('+new'),
          ],
        },
      ],
    };
    return [
      this.toolCalled(callId, 'Edit', { kind: 'fileEdit', path }),
      this.toolCompleted(callId, 'Edit', { kind: 'fileChanges', changes: [change] }),
    ];
  }

  command(
    callId: string,
    command: string,
    output: string,
    opts: {
      exitCode?: number;
      observation?: 'explicit' | 'inferred-success' | 'inferred-failure' | 'unknown';
      isError?: boolean;
      description?: string;
    } = {},
  ): StoredEvent[] {
    const observation =
      opts.observation ?? (opts.exitCode === undefined ? 'inferred-success' : 'explicit');
    return [
      this.toolCalled(callId, 'Bash', { kind: 'command', command, description: opts.description }),
      this.toolCompleted(
        callId,
        'Bash',
        {
          kind: 'command',
          exit: { code: opts.exitCode, observation },
          outputExcerpt: output,
          outputChars: output.length,
          truncated: false,
        },
        opts.isError ?? (opts.exitCode !== undefined && opts.exitCode !== 0),
      ),
    ];
  }

  plan(
    items: PlanItem[],
    mode: 'replace' | 'merge' = 'replace',
    explanation?: string,
  ): StoredEvent {
    return this.stored({
      ...this.base(`plan:${this.seq}`),
      kind: 'plan.updated',
      mode,
      items,
      explanation,
    });
  }

  permission(toolName: string, summary: string): StoredEvent {
    return this.stored({
      ...this.base(`perm:${this.seq}`),
      kind: 'permission.requested',
      toolName,
      summary,
    });
  }

  sessionEnded(): StoredEvent {
    return this.stored({ ...this.base('session:end'), kind: 'session.ended', reason: 'other' });
  }

  raw(
    e: Omit<CanonicalEvent, 'id' | 'sessionId' | 'ts' | 'tsSource' | 'source'> & { id: string },
  ): StoredEvent {
    return this.stored({ ...this.base(e.id), ...e } as CanonicalEvent);
  }
}

function defaultTitle(input: ToolInput): string {
  switch (input.kind) {
    case 'command':
      return `Run: ${input.command}`;
    case 'fileEdit':
      return `Edit ${input.path}`;
    case 'fileWrite':
      return `Write ${input.path}`;
    case 'fileRead':
      return `Read ${input.path}`;
    case 'question':
      return `Ask: ${input.questions[0] ?? ''}`;
    default:
      return input.kind;
  }
}
