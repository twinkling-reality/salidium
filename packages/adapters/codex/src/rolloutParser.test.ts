import { readFileSync } from 'node:fs';
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
import { writesCommandItems } from './rolloutParser.ts';
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

/*
 * Every Codex build since 0.144 writes item-based rollouts and no longer persists
 * `patch_apply_end`; an applied patch appears only as an `item_completed` FileChange item. The
 * fixtures are cut from real rollouts: each record keeps its keys, nesting and order, while ids,
 * paths, times, diffs and every piece of text are synthetic.
 */
describe('CodexRolloutParser: item-based rollouts', () => {
  const THREAD = '01a00001-0000-7000-8000-000000000001';
  const fixture = (name: string) =>
    readFileSync(new URL(`./testing/fixtures/${name}`, import.meta.url), 'utf8')
      .split('\n')
      .filter(Boolean);
  const sessionId = makeSessionId('codex', THREAD);
  const reduce = (events: CanonicalEvent[]) => {
    const state = createInitialState({ sessionId, provider: 'codex', providerSessionId: THREAD });
    let seq = 0;
    for (const e of events) applyEvent(state, { ...e, seq: seq++ } as StoredEvent);
    return state;
  };
  const changesOf = (events: CanonicalEvent[]) =>
    events.flatMap((e) =>
      e.kind === 'tool.completed' && e.result.kind === 'fileChanges'
        ? e.result.changes.map((c) => ({ callId: e.callId, turnId: e.turnId, ...c }))
        : [],
    );

  describe('code mode (0.158 desktop)', () => {
    const lines = fixture('codex-0.158-code-mode.jsonl');
    const events = parseAll(lines, sessionId, THREAD);
    const changes = changesOf(events);

    it('records each applied patch from its FileChange item, not from the script', () => {
      for (const e of events) expect(() => CanonicalEventSchema.parse(e)).not.toThrow();
      expect(parseAll(lines, sessionId, THREAD).map((e) => e.id)).toEqual(events.map((e) => e.id));
      // Whole-file counts follow the convention both adapters share: the content split on
      // newlines, so a file of 62 lines ending in a newline counts 63.
      expect(changes.map((c) => [c.path, c.change, c.linesAdded, c.linesRemoved])).toEqual([
        ['/repo/src/file1.mjs', 'add', 63, 0],
        ['/repo/src/file2.swift', 'update', 1, 1],
        ['/repo/src/file2.swift', 'delete', 0, 36],
      ]);
      expect(changes.every((c) => c.applied && c.callId.startsWith('exec-'))).toBe(true);
      // The cell that carried the patch stays a step of its own; nothing is read from its text.
      const cells = events.filter((e) => e.kind === 'tool.called' && e.toolName === 'exec');
      expect(cells).toHaveLength(3);
    });

    it('files each change under the turn the item names', () => {
      expect(new Set(changes.map((c) => c.turnId))).toEqual(
        new Set(['01a00003-0000-7000-8000-000000000003']),
      );
    });

    it('reduces to the files the session changed', () => {
      const state = reduce(events);
      expect(Object.keys(state.files).sort()).toEqual([
        '/repo/src/file1.mjs',
        '/repo/src/file2.swift',
      ]);
      expect(state.counters.filesChanged).toBe(2);
      expect(state.files['/repo/src/file2.swift']?.kinds).toEqual(['update', 'delete']);
    });

    it('merges with the hook that reported the same nested call, without counting it twice', () => {
      const item = changes[1];
      if (!item) throw new Error('fixture has an update');
      const receivedAt = '2026-01-01T00:14:50.830Z';
      const hookInput = {
        command:
          '*** Begin Patch\n*** Update File: /repo/src/file2.swift\n@@\n-line\n+line\n*** End Patch',
      };
      const hook = [
        ...parseCodexHookPayload(
          {
            session_id: THREAD,
            hook_event_name: 'PreToolUse',
            turn_id: item.turnId,
            tool_name: 'apply_patch',
            tool_use_id: item.callId,
            tool_input: hookInput,
            cwd: '/repo',
          },
          { receivedAt },
        ),
        ...parseCodexHookPayload(
          {
            session_id: THREAD,
            hook_event_name: 'PostToolUse',
            turn_id: item.turnId,
            tool_name: 'apply_patch',
            tool_use_id: item.callId,
            tool_input: hookInput,
            tool_response: 'Success. Updated the following files:\nM /repo/src/file2.swift\n',
          },
          { receivedAt },
        ),
      ];
      const rollout = events.filter((e) => 'callId' in e && e.callId === item.callId);
      // The hook's call and the rollout's call are one event; the results are two observations.
      expect(hook[0]?.id).toBe(rollout.find((e) => e.kind === 'tool.called')?.id);
      const state = reduce([...hook, ...rollout]);
      expect(Object.keys(state.activities).filter((id) => id === item.callId)).toHaveLength(1);
      expect(state.files['/repo/src/file2.swift']).toMatchObject({
        changeCount: 1,
        linesAdded: 1,
        linesRemoved: 1,
      });
      expect(state.counters.filesChanged).toBe(1);
    });
  });

  it('completes a direct apply_patch call with the item that carries its id', () => {
    const events = parseAll(fixture('codex-direct-apply-patch.jsonl'), sessionId, THREAD);
    const calls = events.filter((e) => e.kind === 'tool.called' && e.toolName === 'apply_patch');
    expect(calls.map((e) => 'callId' in e && e.callId)).toEqual([
      'call_Synthetic001xxxxxxxxxxxx',
      'call_Synthetic002xxxxxxxxxxxx',
    ]);
    const changes = changesOf(events);
    expect(changes.map((c) => [c.callId.slice(0, 17), c.path, c.change])).toEqual([
      ['call_Synthetic001', '/repo/src/file2.swift', 'update'],
      ['call_Synthetic001', '/repo/src/file1.swift', 'update'],
      ['call_Synthetic002', '/repo/src/file4.swift', 'update'],
      ['call_Synthetic002', '/repo/src/file3.swift', 'add'],
    ]);
    expect(reduce(events).counters.filesChanged).toBe(4);
  });

  it('keeps a move as a move, from its source path', () => {
    const events = parseAll(fixture('codex-code-mode-move.jsonl'), sessionId, THREAD);
    expect(changesOf(events)).toMatchObject([
      { path: '/repo/src/file2.ts', movedFrom: '/repo/src/file1.ts', change: 'move' },
    ]);
  });

  it('ignores an item from another thread, and marks a patch that did not apply', () => {
    const [line] = fixture('codex-0.158-code-mode.jsonl').filter((l) => l.includes('"FileChange"'));
    const record = JSON.parse(line ?? '{}');
    const other = {
      ...record,
      payload: { ...record.payload, thread_id: '01a0ffff-0000-7000-8000-00000000ffff' },
    };
    expect(changesOf(parseAll([JSON.stringify(other)], sessionId, THREAD))).toEqual([]);
    const failed = {
      ...record,
      payload: { ...record.payload, item: { ...record.payload.item, status: 'failed' } },
    };
    const events = parseAll([JSON.stringify(failed)], sessionId, THREAD);
    expect(changesOf(events).every((c) => !c.applied)).toBe(true);
    expect(events.find((e) => e.kind === 'tool.completed')).toMatchObject({ isError: true });
  });

  it('does not invent a change for a file written through the shell (0.157 app server)', () => {
    const events = parseAll(fixture('codex-0.157-app-server-shell-write.jsonl'), sessionId, THREAD);
    expect(changesOf(events)).toEqual([]);
    const command = events.find((e) => e.kind === 'tool.called');
    expect(command).toMatchObject({ toolName: 'exec_command', input: { kind: 'command' } });
    expect(reduce(events).counters.filesChanged).toBe(0);
  });
});

/*
 * `CommandExecution` items record each process a command tool started, with its exit code. The
 * fixture is a real sequence cut from a 0.155 rollout, every value replaced: `npm test` starts in a
 * code cell and yields a running session, a second cell polls it, the item arrives, and the poll
 * returns the result. The first run fails, the second passes.
 */
describe('CodexRolloutParser: command exit codes from items', () => {
  const THREAD = '01a00001-0000-7000-8000-000000000001';
  const sessionId = makeSessionId('codex', THREAD);
  const read = (name: string) =>
    readFileSync(new URL(`./testing/fixtures/${name}`, import.meta.url), 'utf8')
      .split('\n')
      .filter(Boolean);
  const lines = read('codex-0.155-yielded-test-runs.jsonl');
  const isItem = (l: string) => l.includes('"CommandExecution"');
  const reduce = (events: CanonicalEvent[]) => {
    const state = createInitialState({ sessionId, provider: 'codex', providerSessionId: THREAD });
    let seq = 0;
    for (const e of events) applyEvent(state, { ...e, seq: seq++ } as StoredEvent);
    return state;
  };
  const exits = (events: CanonicalEvent[]) =>
    events.flatMap((e) =>
      e.kind === 'tool.completed' && e.result.kind === 'command'
        ? [{ callId: e.callId, id: e.id, exit: e.result.exit, isError: e.isError }]
        : [],
    );
  const finalExit = (events: CanonicalEvent[], callId: string) =>
    exits(events)
      .filter((e) => e.callId === callId)
      .at(-1)?.exit;
  const FIRST = 'call_Exit001xxxxxxxxxxxxxxxxx';
  const SECOND = 'call_Exit003xxxxxxxxxxxxxxxxx';
  const record = (predicate: (o: Record<string, unknown>) => boolean) => {
    const found = lines.map((l) => JSON.parse(l)).find(predicate);
    if (!found) throw new Error('fixture record missing');
    return found;
  };

  const RUN1 = 'exec-01a00001-0000-7000-8000-000000000001';
  const RUN2 = 'exec-01a00002-0000-7000-8000-000000000002';

  it('observes each process as its own command, failing then passing', () => {
    const events = parseAll(lines, sessionId, THREAD);
    for (const e of events) expect(() => CanonicalEventSchema.parse(e)).not.toThrow();
    expect(finalExit(events, RUN1)).toEqual({ code: 1, observation: 'explicit' });
    expect(finalExit(events, RUN2)).toEqual({ code: 0, observation: 'explicit' });
    const runs = reduce(events).verifications;
    expect(runs.map((v) => [v.callId, v.method, v.outcome, v.exit?.observation])).toEqual([
      [RUN1, 'test', 'fail', 'explicit'],
      [RUN2, 'test', 'pass', 'explicit'],
    ]);
    // Without the items, the cells say only that their scripts ran: no process, so no check.
    const without = parseAll(
      lines.filter((l) => !isItem(l)),
      sessionId,
      THREAD,
    );
    expect(exits(without)).toEqual([]);
    expect(reduce(without).verifications).toEqual([]);
  });

  it('counts each process once, as a command, and each cell as a step that is not one', () => {
    const state = reduce(parseAll(lines, sessionId, THREAD));
    const kinds = Object.values(state.activities).map((a) => [a.callId.slice(0, 9), a.kind]);
    expect(kinds.filter(([, kind]) => kind === 'command')).toEqual([
      ['exec-01a0', 'command'],
      ['exec-01a0', 'command'],
    ]);
    expect(state.counters.commands).toBe(2);
    expect(state.activities[FIRST]).toMatchObject({ kind: 'other', title: 'Code cell' });
    expect(state.activities[SECOND]).toMatchObject({ kind: 'other', title: 'Code cell' });
  });

  it('keeps unknown when the item has no exit code', () => {
    const stripped = lines.map((l) => {
      if (!isItem(l)) return l;
      const o = JSON.parse(l);
      delete o.payload.item.exit_code;
      return JSON.stringify(o);
    });
    const events = parseAll(stripped, sessionId, THREAD);
    expect(finalExit(events, RUN1)).toEqual({ observation: 'unknown' });
    expect(finalExit(events, RUN2)).toEqual({ observation: 'unknown' });
  });

  it('reports a process when its item lands, though the poll returning its output never came', () => {
    const cut = lines.slice(0, lines.findIndex(isItem) + 1);
    const events = parseAll(cut, sessionId, THREAD);
    expect(finalExit(events, RUN1)).toEqual({ code: 1, observation: 'explicit' });
    expect(reduce(events).activities[FIRST]?.kind).toBe('other');
  });

  /*
   * Without `session_meta`, as below, the version is unknown and the parser keeps the behaviour
   * for rollouts that record no processes: the cell is the command, and an item's code is filed
   * under the one open cell whose script names exactly that command.
   */
  describe('a cell that finishes in one call', () => {
    const call = record(
      (o) =>
        (o.payload as { call_id?: string }).call_id === FIRST &&
        (o.payload as { type?: string }).type === 'custom_tool_call',
    );
    const item = record((o) => JSON.stringify(o).includes('"CommandExecution"'));
    const output = (text: string) =>
      JSON.stringify({
        ...call,
        payload: {
          type: 'custom_tool_call_output',
          call_id: FIRST,
          output: [{ type: 'input_text', text }],
        },
      });
    const cell = (...commands: string[]) =>
      JSON.stringify({
        ...call,
        payload: {
          ...call.payload,
          input: commands
            .map((c) => `await tools.exec_command({"cmd":${JSON.stringify(c)},"workdir":"/repo"});`)
            .join('\n'),
        },
      });
    const ran = (command: string, code: number | undefined, n = 1) => {
      const o = structuredClone(item);
      o.payload.item.id = `exec-01a0000${n}-0000-7000-8000-00000000000${n}`;
      o.payload.item.command = ['/bin/zsh', '-lc', command];
      if (code === undefined) delete o.payload.item.exit_code;
      else o.payload.item.exit_code = code;
      return JSON.stringify(o);
    };
    const done = output('Script completed\nWall time 0.1 seconds\nOutput:\nok\n');
    const exitOf = (records: string[]) => finalExit(parseAll(records, sessionId, THREAD), FIRST);

    it('takes the code of the one command it ran', () => {
      expect(exitOf([cell('npm test'), ran('npm test', 2), done])).toEqual({
        code: 2,
        observation: 'explicit',
      });
    });

    it('takes 0 only when every command it names exited 0, and nothing when they disagree', () => {
      expect(
        exitOf([
          cell('npm run lint', 'npm test'),
          ran('npm run lint', 0, 1),
          ran('npm test', 0, 2),
          done,
        ]),
      ).toEqual({ code: 0, observation: 'explicit' });
      expect(
        exitOf([
          cell('npm run lint', 'npm test'),
          ran('npm run lint', 0, 1),
          ran('npm test', 1, 2),
          done,
        ]),
      ).toEqual({ observation: 'unknown' });
      // One command never reported: a pass cannot be claimed for the cell.
      expect(exitOf([cell('npm run lint', 'npm test'), ran('npm run lint', 0, 1), done])).toEqual({
        observation: 'unknown',
      });
    });

    it('does not match a command the script builds at run time, or one two open cells name', () => {
      const dynamic = JSON.stringify({
        ...call,
        payload: {
          ...call.payload,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is a script under test.
          input: 'const t = "test";\nawait tools.exec_command({cmd: `npm ${t}`});',
        },
      });
      expect(exitOf([dynamic, ran('npm test', 1), done])).toEqual({ observation: 'unknown' });
      const other = cell('npm test').replace(FIRST, 'call_Other00xxxxxxxxxxxxxxxx');
      expect(exitOf([cell('npm test'), other, ran('npm test', 1), done])).toEqual({
        observation: 'unknown',
      });
    });

    it('lets a code the output itself printed stand', () => {
      const printed = output(
        'Script completed\nWall time 0.1 seconds\nOutput:\n{"chunk_id":"000009","wall_time_seconds":0.1,"exit_code":0,"original_token_count":1,"output":"ok"}\n',
      );
      expect(exitOf([cell('npm test'), ran('npm test', 0), printed])).toEqual({
        code: 0,
        observation: 'explicit',
      });
    });
  });

  it('observes a function-tool command by its call id, and merges with its hook', () => {
    const shell = read('codex-0.157-app-server-shell-write.jsonl');
    const events = parseAll(shell, sessionId, THREAD);
    const [command] = exits(events);
    expect(command?.exit).toEqual({ code: 0, observation: 'explicit' });
    expect(
      exits(
        parseAll(
          shell.filter((l) => !isItem(l)),
          sessionId,
          THREAD,
        ),
      )[0]?.exit,
    ).toEqual({ observation: 'unknown' });
    const callId = command?.callId ?? '';
    const receivedAt = '2026-01-01T00:02:41.300Z';
    const hook = [
      ...parseCodexHookPayload(
        {
          session_id: THREAD,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_use_id: callId,
          tool_input: { command: "printf 'done' > check.txt && cat check.txt" },
          cwd: '/repo',
        },
        { receivedAt },
      ),
      ...parseCodexHookPayload(
        {
          session_id: THREAD,
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_use_id: callId,
          tool_input: { command: "printf 'done' > check.txt && cat check.txt" },
          tool_response: 'done',
        },
        { receivedAt },
      ),
    ];
    const state = createInitialState({ sessionId, provider: 'codex', providerSessionId: THREAD });
    let seq = 0;
    for (const e of [...hook, ...events]) applyEvent(state, { ...e, seq: seq++ } as StoredEvent);
    expect(Object.keys(state.activities).filter((id) => id === callId)).toHaveLength(1);
    expect(state.activities[callId]?.exit).toEqual({ code: 0, observation: 'explicit' });
  });
});

/*
 * Owner decision D8: which record is a command inside a code-mode cell.
 *
 * A live session with hooks used to show each such command twice: once as the cell (call id
 * `call_…`, its script parsed for commands) and once as the hook's nested command (`exec-<uuid>`).
 * The architecture's reconciliation rule decides it: information content first, the durable record
 * as tie-break. For one process, from the fixture below:
 *
 * - the `CommandExecution` item (rollout, durable) has the exact argv, the process's own exit code,
 *   its output and duration, and the `exec-<uuid>` id the hook reports;
 * - the cell has JavaScript (commands recovered from it best effort, none when built at run time),
 *   the script's status rather than any process's, and at best one code for all its commands,
 *   unknown when they differ, as `npm test` and `npm run lint` do here;
 * - the hook's nested command has the exact command and its output, and no exit code.
 *
 * So the process is the unit, and the item, which shares the hook's id, is its durable record:
 * hook-first and transcript-first ingestion meet on one call id. The cell becomes a step. Codex
 * records processes as items from 0.149 (earlier builds write file-change items only), so older or
 * unversioned rollouts keep the cell as the command. Stores written before this keep their cells as
 * commands too, because stored events never change; the item's call names its cell, and the
 * reducer folds it into a cell that is a command rather than showing the process twice.
 */
describe('CodexRolloutParser: the command inside a code cell (D8)', () => {
  const THREAD = '01a00001-0000-7000-8000-000000000001';
  const TURN = '01a00002-0000-7000-8000-000000000002';
  const CELL = 'call_Cell001xxxxxxxxxxxxxxxxx';
  const TEST = 'exec-01a00003-0000-7000-8000-000000000003';
  const LINT = 'exec-01a00004-0000-7000-8000-000000000004';
  const sessionId = makeSessionId('codex', THREAD);
  const lines = readFileSync(
    new URL('./testing/fixtures/codex-0.158-code-mode-commands.jsonl', import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter(Boolean);
  /** The same rollout as a build that recorded no version, or before items, would be read. */
  const unversioned = lines.map((l) => {
    const o = JSON.parse(l);
    if (o.type === 'session_meta') delete o.payload.cli_version;
    return JSON.stringify(o);
  });
  const rollout = parseAll(lines, sessionId, THREAD);

  const hook = (callId: string, command: string, output: string, receivedAt: string) => [
    ...parseCodexHookPayload(
      {
        session_id: THREAD,
        hook_event_name: 'PreToolUse',
        turn_id: TURN,
        tool_name: 'Bash',
        tool_use_id: callId,
        tool_input: { command, workdir: '/repo' },
        cwd: '/repo',
      },
      { receivedAt },
    ),
    ...parseCodexHookPayload(
      {
        session_id: THREAD,
        hook_event_name: 'PostToolUse',
        turn_id: TURN,
        tool_name: 'Bash',
        tool_use_id: callId,
        tool_input: { command, workdir: '/repo' },
        tool_response: output,
      },
      { receivedAt },
    ),
  ];
  const hooks = [
    ...hook(TEST, 'npm test', ' Tests  5 passed (5)', '2026-01-01T00:00:12.050Z'),
    ...hook(LINT, 'npm run lint', '✖ 1 problem (1 error, 0 warnings)', '2026-01-01T00:00:14.050Z'),
  ];

  /** The store keeps the first event with a given id; a later one with the same id is dropped. */
  const store = (...batches: CanonicalEvent[][]) => {
    const seen = new Set<string>();
    return batches.flat().filter((e) => !seen.has(e.id) && seen.add(e.id));
  };
  const reduce = (events: CanonicalEvent[]) => {
    const state = createInitialState({ sessionId, provider: 'codex', providerSessionId: THREAD });
    let seq = 0;
    for (const e of events) applyEvent(state, { ...e, seq: seq++ } as StoredEvent);
    return state;
  };
  /** What a reader sees: the activities, which are commands, their exits, and the checks. */
  const shape = (events: CanonicalEvent[]) => {
    const state = reduce(events);
    return {
      activities: Object.values(state.activities)
        .map((a) => ({ id: a.callId, kind: a.kind, status: a.status, exit: a.exit ?? null }))
        .sort((x, y) => x.id.localeCompare(y.id)),
      commands: state.counters.commands,
      toolCalls: state.counters.toolCalls,
      checks: state.verifications
        .map((v) => [v.callId, v.method, v.outcome, v.exit?.observation ?? null])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    };
  };

  it('reads processes as items from 0.149, prereleases included, and not without a version', () => {
    expect(writesCommandItems('0.158.0-alpha.2.1')).toBe(true);
    expect(writesCommandItems('0.149.0')).toBe(true);
    expect(writesCommandItems('1.0.0')).toBe(true);
    // 0.144 to 0.148 write file-change items but record no process as an item.
    expect(writesCommandItems('0.148.0')).toBe(false);
    expect(writesCommandItems('0.144.0')).toBe(false);
    for (const unreadable of [undefined, null, '', 'nightly', '0.158', 158])
      expect(writesCommandItems(unreadable)).toBe(false);
  });

  it('makes each process a command with its own exit, and the cell a step', () => {
    for (const e of rollout) expect(() => CanonicalEventSchema.parse(e)).not.toThrow();
    expect(shape(rollout)).toEqual({
      activities: [
        { id: CELL, kind: 'other', status: 'completed', exit: null },
        {
          id: TEST,
          kind: 'command',
          status: 'completed',
          exit: { code: 0, observation: 'explicit' },
        },
        { id: LINT, kind: 'command', status: 'failed', exit: { code: 1, observation: 'explicit' } },
      ].sort((x, y) => x.id.localeCompare(y.id)),
      commands: 2,
      toolCalls: 3,
      checks: [
        [TEST, 'test', 'pass', 'explicit'],
        [LINT, 'lint', 'fail', 'explicit'],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    });
    const calls = rollout.filter((e) => e.kind === 'tool.called');
    expect(calls.map((e) => e.kind === 'tool.called' && [e.callId, e.parentCallId])).toEqual([
      [CELL, undefined],
      [TEST, CELL],
      [LINT, CELL],
    ]);
  });

  it('converges whichever channel arrives first', () => {
    const transcriptOnly = shape(store(rollout));
    expect(shape(store(hooks, rollout))).toEqual(transcriptOnly);
    expect(shape(store(rollout, hooks))).toEqual(transcriptOnly);
    // Live interleaving: each hook lands while the cell is open, before the process's item.
    const [meta, started, cellCall, testItem, lintItem, cellOutput, ended] = rollout.length
      ? groupByRecord(rollout)
      : [];
    const interleaved = store(
      meta ?? [],
      started ?? [],
      cellCall ?? [],
      hooks.slice(0, 2),
      testItem ?? [],
      hooks.slice(2),
      lintItem ?? [],
      cellOutput ?? [],
      ended ?? [],
    );
    expect(shape(interleaved)).toEqual(transcriptOnly);
  });

  it('adds nothing beside a cell an older Salidium stored as the command, when re-read', () => {
    const legacy = parseAll(unversioned, sessionId, THREAD);
    const before = shape(store(legacy));
    expect(before.commands).toBe(1);
    expect(before.activities.map((a) => a.id)).toEqual([CELL]);
    // `salidium reingest`: the stored events stay, and only events with new ids are added.
    expect(shape(store(legacy, rollout))).toEqual(before);
  });

  it('documents the exception: an old store whose hooks already recorded the process keeps it', () => {
    // Retracting the checks, findings and history already derived from the hook's activity is not
    // something replay can do honestly, so the old duplicate stays; the item still gives it its exit.
    const legacyWithHooks = store(hooks, parseAll(unversioned, sessionId, THREAD));
    const before = shape(legacyWithHooks);
    expect(before.commands).toBe(3);
    const after = shape(store(legacyWithHooks, rollout));
    expect(after.commands).toBe(3);
    expect(after.activities.find((a) => a.id === LINT)?.exit).toEqual({
      code: 1,
      observation: 'explicit',
    });
  });

  it('documents the exception: an unversioned rollout with items and hooks shows the cell and the hook', () => {
    // No version means the behaviour for rollouts without process items: the cell is the command,
    // the items only lend it their codes, and the hook's nested commands stay beside it.
    const legacy = parseAll(unversioned, sessionId, THREAD);
    expect(legacy.some((e) => 'callId' in e && e.callId.startsWith('exec-'))).toBe(false);
    expect(shape(store(hooks, legacy)).commands).toBe(3);
  });

  it('dates an item by its record when its own times are impossible or later', () => {
    const odd = lines.map((l) => {
      const o = JSON.parse(l);
      if (o.payload?.item?.id === TEST) {
        o.payload.started_at_ms = 1e20;
        o.payload.completed_at_ms = Date.parse('2099-01-01T00:00:00.000Z');
      }
      return JSON.stringify(o);
    });
    const events = parseAll(odd, sessionId, THREAD);
    const call = events.find((e) => e.kind === 'tool.called' && e.callId === TEST);
    expect(call?.ts).toBe('2026-01-01T00:00:12.000Z');
    const result = events.find((e) => e.kind === 'tool.completed' && e.callId === TEST);
    expect(
      result?.kind === 'tool.completed' && result.result.kind === 'command' && result.result.exit,
    ).toEqual({
      code: 0,
      observation: 'explicit',
    });
  });

  /** Events grouped by the rollout record that produced them, in record order. */
  function groupByRecord(events: CanonicalEvent[]): CanonicalEvent[][] {
    const groups = new Map<number, CanonicalEvent[]>();
    for (const e of events) {
      const line = e.source.ref?.line ?? -1;
      groups.set(line, [...(groups.get(line) ?? []), e]);
    }
    return [...groups.values()];
  }
});
