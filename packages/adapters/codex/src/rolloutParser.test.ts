import { applyEvent, createInitialState, projectSession } from '@salidium/core';
import {
  type CanonicalEvent,
  CanonicalEventSchema,
  makeSessionId,
  type StoredEvent,
} from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from './codexAdapter.ts';
import { parseCodexHookPayload } from './hookPayloads.ts';
import { buildSyntheticRollout } from './testing/syntheticRollout.ts';
import { parseExecOutput } from './toolMapping.ts';

function parseAll(lines: string[], sessionId: string, providerSessionId: string): CanonicalEvent[] {
  const parser = codexAdapter.createRecordParser({
    sessionId,
    providerSessionId,
    path: '/tmp/rollout.jsonl',
    observedAt: '2026-08-19T00:00:00.000Z',
  });
  return lines.flatMap((l, i) => parser.parseRecord(l, i));
}

describe('CodexRolloutParser', () => {
  const { threadId, lines, ids } = buildSyntheticRollout();
  const sessionId = makeSessionId('codex', threadId);
  const events = parseAll(lines, sessionId, threadId);

  it('produces schema-valid, deterministic events and tolerates unknown/malformed records', () => {
    for (const e of events) expect(() => CanonicalEventSchema.parse(e)).not.toThrow();
    const again = parseAll(lines, sessionId, threadId);
    expect(again.map((e) => e.id)).toEqual(events.map((e) => e.id));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('session.started');
    expect(kinds.filter((k) => k === 'turn.started').length).toBeGreaterThanOrEqual(2);
    expect(kinds.filter((k) => k === 'turn.ended').length).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain('plan.updated');
    expect(kinds).toContain('compaction');
    expect(kinds.filter((k) => k === 'ingest.warning')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'turn.started').map((e) => e.turnId)).toEqual(
      expect.arrayContaining([ids.turn1, ids.turn2]),
    );
  });

  it('records exit codes only where the runtime printed them', () => {
    const byCall = (id: string) =>
      events.filter((e) => e.kind === 'tool.completed' && e.callId === id);
    const exec1 = byCall(ids.exec1 ?? '')[0];
    expect(
      exec1?.kind === 'tool.completed' && exec1.result.kind === 'command' && exec1.result.exit,
    ).toMatchObject({ observation: 'explicit', code: 0 });
    const cell1 = byCall(ids.cell1 ?? '')[0];
    expect(
      cell1?.kind === 'tool.completed' && cell1.result.kind === 'command' && cell1.result.exit,
    ).toEqual({ observation: 'unknown' });
    const cell3 = byCall(ids.cell3 ?? '')[0];
    expect(
      cell3?.kind === 'tool.completed' && cell3.result.kind === 'command' && cell3.result.exit,
    ).toEqual({ observation: 'inferred-failure' });
    // Long-running cell: the first output says "running", the real result arrives via wait and
    // is stored as a distinct, final completion for the same call.
    const cell2 = byCall(ids.cell2 ?? '');
    expect(cell2.length).toBeGreaterThanOrEqual(2);
    expect(cell2.some((e) => e.id.endsWith(':result:final'))).toBe(true);
    const patch = byCall(ids.patch1 ?? '')[0];
    expect(patch?.kind === 'tool.completed' && patch.result.kind === 'fileChanges').toBe(true);
  });

  it('reduces to a coherent state', () => {
    const state = createInitialState({ sessionId, provider: 'codex', providerSessionId: threadId });
    let seq = 0;
    for (const e of events) applyEvent(state, { ...e, seq: seq++ } as StoredEvent);
    expect(state.turns.length).toBeGreaterThanOrEqual(2);
    expect(state.counters.filesChanged).toBeGreaterThan(0);
    expect(state.plan.items.length).toBeGreaterThan(0);
    expect(state.model).toBeDefined();
    const view = projectSession(state, Date.parse('2026-08-16T16:30:00.000Z'));
    expect(view.strip.turns).toBe(state.turns.length);
    // Late "final" results upgraded the running cell rather than duplicating activities.
    expect(Object.keys(state.activities).filter((id) => id === ids.cell2)).toHaveLength(1);
  });

  it('hook payloads share call ids with the rollout but keep provisional results distinct', () => {
    const receivedAt = '2026-08-16T15:58:00.000Z';
    const hook = parseCodexHookPayload(
      {
        session_id: threadId,
        hook_event_name: 'PreToolUse',
        turn_id: ids.turn1,
        tool_name: 'Bash',
        tool_use_id: ids.exec1,
        tool_input: { command: 'pnpm vitest run' },
        transcript_path: '/tmp/rollout.jsonl',
        cwd: '/repo/app',
      },
      { receivedAt },
    );
    const post = parseCodexHookPayload(
      {
        session_id: threadId,
        hook_event_name: 'PostToolUse',
        turn_id: ids.turn1,
        tool_name: 'Bash',
        tool_use_id: ids.exec1,
        tool_input: { command: 'pnpm vitest run' },
        tool_response: ' Tests  5 passed (5)',
      },
      { receivedAt },
    );
    const rolloutCall = events.find((e) => e.kind === 'tool.called' && e.callId === ids.exec1);
    expect(hook[0]?.id).toBe(rolloutCall?.id);
    expect(post[0]?.id.endsWith(':result:hook')).toBe(true);
    // Rollout (explicit exit) upgrades the hook's unknown exit when both are reduced.
    const state = createInitialState({ sessionId, provider: 'codex', providerSessionId: threadId });
    let seq = 0;
    const rolloutResult = events.find((e) => e.kind === 'tool.completed' && e.callId === ids.exec1);
    for (const e of [hook[0], post[0], rolloutResult])
      if (e) applyEvent(state, { ...e, seq: seq++ } as StoredEvent);
    expect(state.activities[ids.exec1 ?? '']?.exit).toMatchObject({ observation: 'explicit' });
    expect(state.verifications.filter((v) => v.callId === ids.exec1)).toHaveLength(1);
  });

  it('matches rollout paths', () => {
    expect(
      codexAdapter.matchSessionFile(
        `/Users/me/.codex/sessions/2026/08/16/rollout-2026-08-16T15-57-00-${threadId}.jsonl`,
      ),
    ).toEqual({ sessionId, providerSessionId: threadId });
    expect(
      codexAdapter.matchSessionFile(
        `/Users/me/.codex/archived_sessions/rollout-2026-08-16T15-57-00-${threadId}.jsonl`,
      ),
    ).toEqual({ sessionId, providerSessionId: threadId });
    expect(
      codexAdapter.matchSessionFile(
        `C:\\Users\\me\\.codex\\sessions\\2026\\08\\16\\rollout-2026-08-16T15-57-00-${threadId}.jsonl`,
      ),
    ).toEqual({ sessionId, providerSessionId: threadId });
    expect(
      codexAdapter.matchSessionFile(
        `C:\\Users\\me\\.codex\\archived_sessions\\rollout-2026-08-16T15-57-00-${threadId}.jsonl`,
      ),
    ).toEqual({ sessionId, providerSessionId: threadId });
    expect(codexAdapter.matchSessionFile('/Users/me/.codex/history.jsonl')).toBeUndefined();
  });

  it('normalizes explicit offsets and never assigns invalid record time to semantic evidence', () => {
    const valid = JSON.stringify({
      timestamp: '2026-08-19T08:34:56.7-04:00',
      type: 'session_meta',
      payload: { cwd: '/repo' },
    });
    expect(parseAll([valid], sessionId, threadId)[0]?.ts).toBe('2026-08-19T12:34:56.700Z');

    const invalid = [
      { type: 'session_meta', payload: { cwd: '/repo' } },
      {
        timestamp: '2026-08-19T12:34:56',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'do not turn this into work' },
      },
    ].map(JSON.stringify);
    const warnings = parseAll(invalid, sessionId, threadId);
    expect(warnings).toHaveLength(2);
    expect(warnings.every((event) => event.kind === 'ingest.warning')).toBe(true);
    expect(warnings.every((event) => event.ts === '2026-08-19T00:00:00.000Z')).toBe(true);
  });
});

/**
 * Codex multi-agent mode. The synthetic records below preserve the provider's observed shape.
 *
 * These were dropped by a `default` branch whose comment said `agent_message` was "covered by
 * event_msg records" — true of the root agent narrating to the user, and not true of these, which
 * always carry an `author` and are one agent reporting to another. `FINAL_ANSWER` write-ups must
 * reach the delegated-agent lane rather than being dropped.
 */
describe('CodexRolloutParser: multi-agent traffic', () => {
  const sessionId = makeSessionId('codex', 'thread-1');
  const rec = (o: unknown) => JSON.stringify(o);

  const FINAL_ANSWER = rec({
    timestamp: '2026-08-16T23:04:29.585Z',
    type: 'response_item',
    payload: {
      type: 'agent_message',
      id: 'amsg_1',
      author: '/root/practice_topics',
      recipient: '/root',
      content: [
        {
          type: 'input_text',
          text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/practice_topics\nPayload:\nImplemented the Practice Bank with schema v1 to v2 migration.',
        },
      ],
    },
  });

  // The body is encrypted and there is no key here, so the header alone must produce nothing.
  const ENCRYPTED = rec({
    timestamp: '2026-08-16T23:04:29.585Z',
    type: 'response_item',
    payload: {
      type: 'agent_message',
      id: 'amsg_2',
      author: '/root/language_help',
      recipient: '/root',
      content: [
        {
          type: 'input_text',
          text: 'Message Type: MESSAGE\nTask name: /root\nSender: /root/language_help\nPayload:\n',
        },
        { type: 'encrypted_content', encrypted_content: 'gAAAAABqgkH9STKn4PU_isJ' },
      ],
    },
  });

  const STARTED = rec({
    timestamp: '2026-08-16T23:03:49.600Z',
    type: 'event_msg',
    payload: {
      type: 'sub_agent_activity',
      agent_thread_id: '01a00cd1-29f1-7e11',
      agent_path: '/root/practice_topics',
      kind: 'started',
    },
  });

  const INTERACTED = rec({
    timestamp: '2026-08-16T23:03:50.600Z',
    type: 'event_msg',
    payload: {
      type: 'sub_agent_activity',
      agent_thread_id: '01a00cd1-29f1-7e11',
      agent_path: '/root/language_help',
      kind: 'interacted',
    },
  });

  const INTERRUPTED = rec({
    timestamp: '2026-08-16T23:05:50.600Z',
    type: 'event_msg',
    payload: {
      type: 'sub_agent_activity',
      agent_thread_id: '01a00cd1-29f1-7e11',
      agent_path: '/root/language_help',
      kind: 'interrupted',
    },
  });

  const events = parseAll(
    [STARTED, INTERACTED, FINAL_ANSWER, ENCRYPTED, INTERRUPTED],
    sessionId,
    'thread-1',
  );

  it('keeps a subagent’s written result, attributed to the lane that produced it', () => {
    const msg = events.find((e) => e.kind === 'agent.message');
    expect(msg).toBeDefined();
    // Resolved to the thread id `sub_agent_activity` opened the lane with, not the path the
    // message names itself by: keyed on the path, the report opens a second empty lane beside the
    // one that did the work, and that lane never stops reading as "running".
    expect(msg?.agentId).toBe('01a00cd1-29f1-7e11');
    expect((msg as { phase?: string }).phase).toBe('final');
    // The routing header is not the message; the payload beneath it is.
    expect((msg as { text: string }).text).toBe(
      'Implemented the Practice Bank with schema v1 to v2 migration.',
    );
  });

  it('says nothing at all when the payload is encrypted', () => {
    // One readable report in, one message out: the encrypted record contributes no narration and
    // no phantom subagent. Relaying its routing header would be inventing content from a wrapper.
    expect(events.filter((e) => e.kind === 'agent.message')).toHaveLength(1);
    expect(
      events
        .filter((e) => e.kind === 'agent.message')
        .some((e) => e.agentId === '/root/language_help'),
    ).toBe(false);
  });

  it('treats a final answer as the completion signal, because Codex sends no other', () => {
    const ended = events.filter((e) => e.kind === 'subagent.ended');
    expect(ended.map((e) => (e as { subagentId: string }).subagentId)).toContain(
      '01a00cd1-29f1-7e11',
    );
    // The result lands on the lane, so the section can say what the subagent actually produced
    // rather than only that one existed.
    expect((ended[0] as { lastMessage?: string }).lastMessage).toContain('Practice Bank');
  });

  it('falls back to the path when a report arrives with no matching start', () => {
    const orphan = parseAll([FINAL_ANSWER], sessionId, 'thread-1');
    expect(orphan.find((e) => e.kind === 'agent.message')?.agentId).toBe('/root/practice_topics');
  });

  it('does not turn every interaction into a lifecycle event', () => {
    // `interacted` fires 457 times across the store against 134 `started`; it means traffic, not
    // a state change, and emitting it would make a working lane look like it restarted constantly.
    expect(events.filter((e) => e.kind === 'subagent.started')).toHaveLength(1);
  });

  it('is deterministic, so re-ingest after a restart is a no-op', () => {
    const again = parseAll(
      [STARTED, INTERACTED, FINAL_ANSWER, ENCRYPTED, INTERRUPTED],
      sessionId,
      'thread-1',
    );
    expect(again.map((e) => e.id)).toEqual(events.map((e) => e.id));
    for (const e of events) expect(() => CanonicalEventSchema.parse(e)).not.toThrow();
  });
});

/**
 * Codex's code-mode `exec` wrapper reports whether the *script* ran, not the shell exit of the
 * command inside it. The exit status can still be present in the record: cells end
 * `text(JSON.stringify(r))` and `r` is `exec_command`'s own result object.
 */
describe('parseExecOutput on code-mode results', () => {
  const cell = (body: string) => `Script completed\nWall time 0.2 seconds\nOutput:\n${body}`;
  const blob = (o: Record<string, unknown>) => JSON.stringify({ chunk_id: 'ab12', ...o });

  it('reads the exit code and unescapes the real output', () => {
    const r = parseExecOutput(cell(blob({ exit_code: 1, output: 'ℹ pass 0\nℹ fail 1\n' })));
    expect(r.exit).toEqual({ code: 1, observation: 'explicit' });
    // Left JSON-escaped, a summary matched at the start of a line has no line to start on.
    expect(r.body).toBe('ℹ pass 0\nℹ fail 1\n');
  });

  it('refuses to attribute an exit code when one cell ran several commands and they disagree', () => {
    const mixed = cell(
      `${blob({ exit_code: 0, output: 'a\n' })}${blob({ exit_code: 3, output: 'b\n' })}`,
    );
    expect(parseExecOutput(mixed).exit).toEqual({ observation: 'unknown' });
    expect(parseExecOutput(mixed).body).toBe('a\n\nb\n');
    // All zero attributes safely: whichever command was classified, it passed.
    const allZero = cell(
      `${blob({ exit_code: 0, output: 'a\n' })}${blob({ exit_code: 0, output: 'b\n' })}`,
    );
    expect(allZero && parseExecOutput(allZero).exit).toEqual({ code: 0, observation: 'explicit' });
  });

  it('treats a still-open session as running rather than as a result', () => {
    const r = parseExecOutput(cell(blob({ session_id: 97079, output: 'partial\n' })));
    expect(r.exit).toEqual({ observation: 'unknown' });
    expect(r.running).toEqual({ kind: 'session', id: '97079' });
    // A sibling that finished must not close a cell that has not.
    const half = cell(
      `${blob({ exit_code: 0, output: 'a\n' })}${blob({ session_id: 5, output: 'b\n' })}`,
    );
    expect(parseExecOutput(half).running).toEqual({ kind: 'session', id: '5' });
  });

  it('finds the object even when a brace appears inside the output it carries', () => {
    const r = parseExecOutput(cell(blob({ exit_code: 0, output: 'printed {"a":"}"} here\n' })));
    expect(r.body).toBe('printed {"a":"}"} here\n');
  });

  it('carries the mid-output truncation marker Codex writes', () => {
    expect(
      parseExecOutput(cell(blob({ exit_code: 0, output: 'head…1171 tokens truncated…tail' })))
        .truncated,
    ).toBe(true);
  });

  it('leaves the other wrappers alone', () => {
    expect(
      parseExecOutput('Exit code: 0\nWall time: 0.2 seconds\nOutput:\nM README.md\n').exit,
    ).toEqual({ code: 0, observation: 'explicit' });
    expect(
      parseExecOutput('Script running with cell ID 217\nWall time 10.0 seconds\nOutput:\n').running,
    ).toEqual({ kind: 'cell', id: '217' });
    expect(parseExecOutput('Script completed\nOutput:\nℹ pass 1\n').exit).toEqual({
      observation: 'unknown',
    });
  });
});

describe('truncation caveats', () => {
  it('does not read the unified-exec header as evidence of truncation', () => {
    // `Original token count` is printed on every result; only the warning means anything.
    const complete =
      'Chunk ID: ab\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 13\nOutput:\nfine\n';
    expect(parseExecOutput(complete).truncated).toBe(false);
    expect(
      parseExecOutput(`Warning: truncated output (original token count: 21975)\n${complete}`)
        .truncated,
    ).toBe(true);
  });
});

/**
 * A command that outlives its call is collected by polling, and Codex records the poll either as
 * a `wait` function call or as another code cell whose whole body is the poll. Read as a cell it
 * becomes a command named after the JavaScript that fetched the result, and the command that
 * actually ran keeps the empty stub it yielded with.
 */
describe('code cells that only poll', () => {
  const rec = (payload: Record<string, unknown>) =>
    JSON.stringify({ timestamp: '2026-07-18T07:16:33.000Z', type: 'response_item', payload });
  const blob = (o: Record<string, unknown>) => JSON.stringify({ chunk_id: 'ab12', ...o });

  it('attributes the poll to the command that yielded, and keeps every chunk', () => {
    const lines = [
      rec({
        type: 'custom_tool_call',
        call_id: 'c1',
        name: 'exec',
        input: 'const r = await tools.exec_command({cmd:"npm test"});\ntext(r.output);',
      }),
      rec({
        type: 'custom_tool_call_output',
        call_id: 'c1',
        output: `Script completed\nOutput:\n${blob({ session_id: 42, output: 'first\n' })}`,
      }),
      rec({
        type: 'custom_tool_call',
        call_id: 'c2',
        name: 'exec',
        input: 'const r = await tools.write_stdin({session_id:42,chars:""});\ntext(r.output);',
      }),
      rec({
        type: 'custom_tool_call_output',
        call_id: 'c2',
        output: `Script completed\nOutput:\n${blob({ session_id: 42, output: 'middle\n' })}`,
      }),
      rec({
        type: 'custom_tool_call',
        call_id: 'c3',
        name: 'exec',
        input: 'const r = await tools.write_stdin({session_id:42,chars:""});\ntext(r.output);',
      }),
      rec({
        type: 'custom_tool_call_output',
        call_id: 'c3',
        output: `Script completed\nOutput:\n${blob({ exit_code: 0, output: 'ℹ pass 3\nℹ fail 0\n' })}`,
      }),
    ];
    const evs = parseAll(lines, 'codex:t1', 't1');
    // One command, not three.
    expect(evs.filter((e) => e.kind === 'tool.called').map((e) => e.callId)).toEqual(['c1']);
    const final = evs.find((e) => e.id.endsWith(':result:final'));
    expect(final).toBeDefined();
    const result = (final as { result?: { exit?: unknown; outputExcerpt?: string } }).result;
    expect(result?.exit).toEqual({ code: 0, observation: 'explicit' });
    expect(result?.outputExcerpt).toBe('first\nmiddle\nℹ pass 3\nℹ fail 0\n');
  });

  it('leaves a poll it cannot attribute as a cell of its own, rather than dropping its output', () => {
    const lines = [
      rec({
        type: 'custom_tool_call',
        call_id: 'c9',
        name: 'exec',
        input: 'const r = await tools.write_stdin({session_id:777,chars:""});\ntext(r.output);',
      }),
      rec({
        type: 'custom_tool_call_output',
        call_id: 'c9',
        output: 'Script completed\nOutput:\nwork nobody saw start\n',
      }),
    ];
    const evs = parseAll(lines, 'codex:t2', 't2');
    expect(evs.some((e) => e.kind === 'tool.called')).toBe(true);
    const done = evs.find((e) => e.kind === 'tool.completed') as {
      result?: { outputExcerpt?: string };
    };
    expect(done?.result?.outputExcerpt).toContain('work nobody saw start');
  });
});
