import { applyEvent, createInitialState, projectSession } from '@salidium/core';
import {
  type CanonicalEvent,
  CanonicalEventSchema,
  makeSessionId,
  type StoredEvent,
} from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from './claudeCodeAdapter.ts';
import { parseClaudeCodeHookPayload } from './hookPayloads.ts';
import { buildSyntheticTranscript } from './testing/syntheticTranscript.ts';

function parseAll(
  lines: string[],
  sessionId: string,
  providerSessionId: string,
  path = '/tmp/x.jsonl',
): CanonicalEvent[] {
  const parser = claudeCodeAdapter.createRecordParser({
    sessionId,
    providerSessionId,
    path,
    observedAt: '2026-08-19T00:00:00.000Z',
  });
  return lines.flatMap((l, i) => parser.parseRecord(l, i));
}

describe('ClaudeCodeTranscriptParser', () => {
  const { sessionId: pid, lines, ids } = buildSyntheticTranscript();
  const sessionId = makeSessionId('claude-code', pid);
  const events = parseAll(lines, sessionId, pid);

  it('produces schema-valid canonical events for every record and warns on malformed lines', () => {
    for (const e of events) expect(() => CanonicalEventSchema.parse(e)).not.toThrow();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('session.started');
    expect(kinds.filter((k) => k === 'turn.started')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'tool.called')).toHaveLength(8);
    expect(kinds.filter((k) => k === 'tool.completed')).toHaveLength(7);
    expect(kinds.filter((k) => k === 'tool.failed')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'plan.updated')).toHaveLength(2);
    expect(kinds).toContain('compaction');
    // The malformed JSON plus two provider records with no timestamp are warnings only. A title
    // without an instant cannot be placed into canonical history by borrowing a nearby time.
    expect(kinds.filter((k) => k === 'ingest.warning')).toHaveLength(3);
    expect(
      events
        .filter((e) => e.kind === 'session.updated')
        .some((e) => e.kind === 'session.updated' && e.title === 'Login session refresh fix'),
    ).toBe(false);
    // Compaction summaries and meta prompts are not turns.
    expect(
      events
        .filter((e) => e.kind === 'turn.started')
        .map((e) => e.kind === 'turn.started' && e.prompt),
    ).toEqual([
      'Fix login session handling so concurrent refreshes do not interfere',
      'Also add a regression test',
    ]);
    expect(
      events
        .filter((event) => event.source.ref?.recordId)
        .every((event) => event.source.ref?.recordHash?.startsWith('sha256:')),
    ).toBe(true);
  });

  it('maps tool shapes precisely', () => {
    const edit = events.find((e) => e.kind === 'tool.completed' && e.callId === ids.edit1);
    expect(
      edit?.kind === 'tool.completed' &&
        edit.result.kind === 'fileChanges' &&
        edit.result.changes[0],
    ).toMatchObject({ change: 'update', linesAdded: 2, linesRemoved: 1, applied: true });
    const write = events.find((e) => e.kind === 'tool.completed' && e.callId === ids.write1);
    expect(
      write?.kind === 'tool.completed' &&
        write.result.kind === 'fileChanges' &&
        write.result.changes[0],
    ).toMatchObject({ change: 'add', linesAdded: 2, linesRemoved: 0 });
    const fail = events.find((e) => e.kind === 'tool.failed');
    expect(fail).toMatchObject({
      callId: ids.bashFail,
      cause: 'error',
      exit: { code: 1, observation: 'explicit' },
    });
    const ok = events.find((e) => e.kind === 'tool.completed' && e.callId === ids.bash2);
    expect(ok?.kind === 'tool.completed' && ok.result.kind === 'command' && ok.result.exit).toEqual(
      { observation: 'inferred-success' },
    );
    const agent = events.find((e) => e.kind === 'tool.completed' && e.callId === ids.agent1);
    expect(agent?.kind === 'tool.completed' && agent.result).toMatchObject({
      kind: 'subagent',
      status: 'launched',
      agentId: 'ab12cd34ef56ab78c',
    });
    const plan = events.filter((e) => e.kind === 'plan.updated');
    expect(plan[0]?.kind === 'plan.updated' && plan[0].items[0]).toMatchObject({
      id: '1',
      status: 'pending',
    });
    expect(plan[1]?.kind === 'plan.updated' && plan[1].items[0]).toMatchObject({
      id: '1',
      status: 'in_progress',
    });
    const ends = events.filter((e) => e.kind === 'turn.ended');
    expect(ends[0]).toMatchObject({ outcome: 'completed', turnId: ids.promptId });
    expect(ends[0]?.kind === 'turn.ended' && ends[0].lastMessage).toBeUndefined(); // thinking-only end record
    expect(ends[1]?.kind === 'turn.ended' && ends[1].lastMessage).toContain('45/45 tests pass');
    expect(ends[2]).toMatchObject({ outcome: 'interrupted', turnId: ids.promptId2 });
  });

  it('reduces into the expected semantic state', () => {
    const state = createInitialState({
      sessionId,
      provider: 'claude-code',
      providerSessionId: pid,
    });
    let seq = 0;
    const changes = events.flatMap((e) => applyEvent(state, { ...e, seq: seq++ } as StoredEvent));
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]?.outcome).toBe('completed');
    expect(state.turns[1]?.outcome).toBe('interrupted');
    expect(state.counters.filesChanged).toBe(2);
    expect(state.verifications.map((v) => v.outcome)).toEqual(['fail', 'pass']);
    expect(state.verifications[0]?.outcomeEpistemic).toBe('observed');
    expect(state.verifications[1]?.outcomeEpistemic).toBe('inferred');
    expect(state.plan.items).toEqual([
      {
        id: '1',
        text: 'Move refresh ownership into SessionManager',
        status: 'in_progress',
        activeForm: 'Moving refresh ownership',
      },
    ]);
    expect(state.title).toBeUndefined();
    expect(state.model).toBe('claude-opus-5');
    expect(state.counters.compactions).toBe(1);
    expect(state.counters.ingestWarnings).toBe(3);
    const view = projectSession(state);
    expect(view.left.items.map((i) => i.text)).toContain(
      'Move refresh ownership into SessionManager',
    );
    const summaries = changes.map((c) => c.summary);
    expect(summaries).toContain('Changed SessionManager.ts (+2 −1)');
    expect(summaries).toContain('3 of 45 tests failed (vitest)');
    expect(summaries).toContain('45/45 tests passed (vitest)');
    expect(summaries).toContain('Now: Moving refresh ownership');
  });

  it('normalizes explicit offsets and emits stable ingest-time warnings for bad timestamps', () => {
    const valid = JSON.stringify({
      type: 'user',
      timestamp: '2026-08-19T08:34:56.7-04:00',
      uuid: 'u-offset',
      promptId: 'p-offset',
      cwd: '/repo',
      message: { role: 'user', content: 'test offset handling' },
    });
    const normalized = parseAll([valid], sessionId, pid);
    expect(normalized.length).toBeGreaterThan(0);
    expect(normalized.every((event) => event.ts === '2026-08-19T12:34:56.700Z')).toBe(true);

    const bad = (timestamp?: string) =>
      JSON.stringify({
        type: 'user',
        ...(timestamp === undefined ? {} : { timestamp }),
        uuid: 'u-bad',
        cwd: '/repo',
        message: { role: 'user', content: 'must not become a turn' },
      });
    const warnings = parseAll(
      [bad(), bad('2026-08-19T12:34:56'), bad('08/19/2026 12:34:56')],
      sessionId,
      pid,
    );
    expect(warnings).toHaveLength(3);
    expect(warnings.every((event) => event.kind === 'ingest.warning')).toBe(true);
    expect(warnings.every((event) => event.ts === '2026-08-19T00:00:00.000Z')).toBe(true);
    expect(warnings.map((event) => event.id)).toEqual([
      `${sessionId}#ingest:warning:main:0`,
      `${sessionId}#ingest:warning:main:1`,
      `${sessionId}#ingest:warning:main:2`,
    ]);
  });

  it('deterministically reconciles channel-specific hook and transcript tool observations', () => {
    const receivedAt = '2026-08-16T10:31:00.000Z';
    const hookEvents = [
      parseClaudeCodeHookPayload(
        {
          session_id: pid,
          hook_event_name: 'PreToolUse',
          prompt_id: ids.promptId,
          tool_name: 'Edit',
          tool_use_id: ids.edit1,
          tool_input: {
            file_path: '/repo/app/src/auth/SessionManager.ts',
            old_string: 'a',
            new_string: 'b',
          },
          cwd: '/repo/app',
          transcript_path: '/tmp/x.jsonl',
        },
        { receivedAt },
      ),
      parseClaudeCodeHookPayload(
        {
          session_id: pid,
          hook_event_name: 'PostToolUse',
          prompt_id: ids.promptId,
          tool_name: 'Edit',
          tool_use_id: ids.edit1,
          tool_input: { file_path: '/repo/app/src/auth/SessionManager.ts' },
          tool_response: {
            filePath: '/repo/app/src/auth/SessionManager.ts',
            structuredPatch: [
              {
                oldStart: 2,
                oldLines: 3,
                newStart: 2,
                newLines: 4,
                lines: [' a', '-b', '+c', '+d', ' e'],
              },
            ],
            userModified: false,
          },
          duration_ms: 12.4,
        },
        { receivedAt },
      ),
      parseClaudeCodeHookPayload(
        {
          session_id: pid,
          hook_event_name: 'Stop',
          prompt_id: ids.promptId,
          last_assistant_message: 'done',
          stop_hook_active: false,
        },
        { receivedAt },
      ),
      parseClaudeCodeHookPayload(
        {
          session_id: pid,
          hook_event_name: 'SessionStart',
          source: 'startup',
          cwd: '/repo/app',
          model: 'claude-opus-5',
          transcript_path: '/tmp/x.jsonl',
        },
        { receivedAt },
      ),
      parseClaudeCodeHookPayload(
        {
          session_id: pid,
          hook_event_name: 'PostToolUseFailure',
          prompt_id: ids.promptId,
          tool_name: 'Bash',
          tool_use_id: ids.bashFail,
          tool_input: { command: 'pnpm vitest run' },
          error: 'Exit code 1\nTests  3 failed | 42 passed (45)',
          duration_ms: 1500,
        },
        { receivedAt },
      ),
      parseClaudeCodeHookPayload(
        {
          session_id: pid,
          hook_event_name: 'TaskCreated',
          task_id: '1',
          task_subject: 'Move refresh ownership into SessionManager',
        },
        { receivedAt },
      ),
    ].flat();
    for (const e of hookEvents) expect(() => CanonicalEventSchema.parse(e)).not.toThrow();
    const transcriptIds = new Set(events.map((e) => e.id));
    const hookTools = hookEvents.filter(
      (event) =>
        event.kind === 'tool.called' ||
        event.kind === 'tool.completed' ||
        event.kind === 'tool.failed',
    );
    expect(hookTools.every((event) => event.id.endsWith(':hook'))).toBe(true);
    expect(hookTools.every((event) => !transcriptIds.has(event.id))).toBe(true);

    const reconcileEdit = (hookFirst: boolean) => {
      const transcriptPair = events.filter(
        (event) =>
          'callId' in event &&
          event.callId === ids.edit1 &&
          (event.kind === 'tool.called' || event.kind === 'tool.completed'),
      );
      const hookPair = hookEvents.filter(
        (event) =>
          'callId' in event &&
          event.callId === ids.edit1 &&
          (event.kind === 'tool.called' || event.kind === 'tool.completed'),
      );
      const state = createInitialState({
        sessionId,
        provider: 'claude-code',
        providerSessionId: pid,
      });
      const ordered = hookFirst
        ? [...hookPair, ...transcriptPair]
        : [...transcriptPair, ...hookPair];
      ordered.forEach((event, seq) => {
        applyEvent(state, { ...event, seq } as StoredEvent);
      });
      const activity = state.activities[ids.edit1];
      const file = state.files['/repo/app/src/auth/SessionManager.ts'];
      return {
        activity: {
          title: activity?.title,
          input: activity?.input,
          startedAt: activity?.startedAt,
          endedAt: activity?.endedAt,
          durationMs: activity?.durationMs,
          result: activity?.result,
          eventIds: activity?.eventIds,
        },
        file: file && {
          linesAdded: file.linesAdded,
          linesRemoved: file.linesRemoved,
          lastChangedAt: file.lastChangedAt,
          lastHunks: file.lastHunks,
        },
        counters: {
          filesChanged: state.counters.filesChanged,
          linesAdded: state.counters.linesAdded,
          linesRemoved: state.counters.linesRemoved,
        },
      };
    };
    const hookFirstEdit = reconcileEdit(true);
    const transcriptFirstEdit = reconcileEdit(false);
    expect(hookFirstEdit).toEqual(transcriptFirstEdit);
    expect(hookFirstEdit.activity.durationMs).toBe(2000);
    expect(hookFirstEdit.file?.lastHunks?.[0]?.lines).toContain('+  await this.lock.acquire();');

    const reconcileFailure = (hookFirst: boolean) => {
      const transcriptPair = events.filter(
        (event) =>
          'callId' in event &&
          event.callId === ids.bashFail &&
          (event.kind === 'tool.called' || event.kind === 'tool.failed'),
      );
      const hookFailure = hookEvents.filter(
        (event) => event.kind === 'tool.failed' && event.callId === ids.bashFail,
      );
      const state = createInitialState({
        sessionId,
        provider: 'claude-code',
        providerSessionId: pid,
      });
      const ordered = hookFirst
        ? [...hookFailure, ...transcriptPair]
        : [...transcriptPair, ...hookFailure];
      ordered.forEach((event, seq) => {
        applyEvent(state, { ...event, seq } as StoredEvent);
      });
      const activity = state.activities[ids.bashFail];
      return {
        status: activity?.status,
        input: activity?.input,
        errorExcerpt: activity?.errorExcerpt,
        exit: activity?.exit,
        durationMs: activity?.durationMs,
        eventIds: activity?.eventIds,
        verification: state.verifications.map(({ seq: _seq, ...verification }) => verification),
      };
    };
    expect(reconcileFailure(true)).toEqual(reconcileFailure(false));
    // Turn ends deliberately do not share ids across channels (each end_turn record is its own
    // event); the reducer ends the turn once and merges the final message.
    const state = createInitialState({
      sessionId,
      provider: 'claude-code',
      providerSessionId: pid,
    });
    let seq = 0;
    const turnStart = events.find((e) => e.kind === 'turn.started' && e.turnId === ids.promptId);
    for (const e of [
      turnStart,
      ...hookEvents.filter((e) => e.kind === 'turn.ended'),
      ...events.filter((e) => e.kind === 'turn.ended' && e.turnId === ids.promptId),
    ])
      if (e) applyEvent(state, { ...e, seq: seq++ } as StoredEvent);
    expect(state.turns).toHaveLength(1);
    // The hook's last_assistant_message arrived first and wins; the transcript's later end record does not overwrite it.
    expect(state.turns[0]?.lastMessage).toBe('done');
    const post = hookEvents.find((e) => e.kind === 'tool.completed');
    expect(post?.kind === 'tool.completed' && post.durationMs).toBe(12);
    expect(
      claudeCodeAdapter.transcriptPathFromHook({
        session_id: pid,
        transcript_path: '/tmp/x.jsonl',
        cwd: '/repo/app',
        hook_event_name: 'SessionStart',
      }),
    ).toEqual({
      sessionId,
      path: '/tmp/x.jsonl',
      cwd: '/repo/app',
      agentPath: undefined,
      agentId: undefined,
    });
  });

  it('matches session files and subagent files by path', () => {
    expect(
      claudeCodeAdapter.matchSessionFile(
        '/Users/me/.claude/projects/-Users-me-app/11111111-2222-4333-8444-555555555555.jsonl',
      ),
    ).toEqual({ sessionId, providerSessionId: pid });
    expect(
      claudeCodeAdapter.matchSessionFile(
        '/Users/me/.claude/projects/-Users-me-app/11111111-2222-4333-8444-555555555555/subagents/agent-abc123.jsonl',
      ),
    ).toEqual({ sessionId, providerSessionId: pid, agentId: 'abc123' });
    expect(
      claudeCodeAdapter.matchSessionFile(
        '/Users/me/.claude/projects/-Users-me-app/11111111-2222-4333-8444-555555555555/subagents/workflows/wf_1/agent-abc123.jsonl',
      )?.agentId,
    ).toBe('abc123');
    expect(
      claudeCodeAdapter.matchSessionFile(
        'C:\\Users\\me\\.claude\\projects\\-Users-me-app\\11111111-2222-4333-8444-555555555555.jsonl',
      ),
    ).toEqual({ sessionId, providerSessionId: pid });
    expect(
      claudeCodeAdapter.matchSessionFile(
        'C:\\Users\\me\\.claude\\projects\\-Users-me-app\\11111111-2222-4333-8444-555555555555\\subagents\\workflows\\wf_1\\agent-abc123.jsonl',
      ),
    ).toEqual({ sessionId, providerSessionId: pid, agentId: 'abc123' });
    expect(
      claudeCodeAdapter.matchSessionFile(
        '/Users/me/.claude/projects/-Users-me-app/11111111-2222-4333-8444-555555555555/tool-results/toolu_1.txt',
      ),
    ).toBeUndefined();
  });
});
