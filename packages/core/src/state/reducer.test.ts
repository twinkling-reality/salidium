import type { StoredEvent } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { CLAIM_THRESHOLD } from '../claims/classifyAgentMessage.ts';
import { cloneState, replayEvents } from '../history/replay.ts';
import { projectSession } from '../projections/projectSession.ts';
import { summarizeSession } from '../projections/summarizeSession.ts';
import { EventBuilder } from '../testing/eventBuilders.ts';
import { createInitialState } from './createInitialState.ts';
import { applyEvent } from './reducer.ts';
import type { RunState } from './runState.ts';

const VITEST_FAIL = `
 ❯ src/auth.test.ts (5 tests | 3 failed) 120ms
 Test Files  1 failed (1)
      Tests  3 failed | 42 passed (45)
   Duration  1.20s
`;
const VITEST_PASS = `
 ✓ src/auth.test.ts (45 tests) 110ms
 Test Files  1 passed (1)
      Tests  45 passed (45)
   Duration  1.10s
`;

function fresh(): RunState {
  return createInitialState({
    sessionId: 'claude-code:test-session',
    provider: 'claude-code',
    providerSessionId: 'test-session',
    cwd: '/repo/app',
  });
}

function run(events: StoredEvent[], state = fresh()) {
  const changes = events.flatMap((e) => applyEvent(state, e));
  return { state, changes };
}

describe('reducer: straightforward successful task', () => {
  it('derives files, verification, status and a semantic history', () => {
    const b = new EventBuilder();
    const events = [
      b.sessionStarted(),
      b.turnStarted('Fix login session handling so concurrent refreshes do not interfere'),
      b.message('Investigating the authentication flow to see how refresh is triggered.'),
      b.message(
        'Found duplicate refresh behavior: AuthMiddleware and SessionManager both rotate tokens.',
      ),
      b.message("I'll move refresh ownership into SessionManager and add a mutex."),
      ...b.edit('c1', '/repo/app/src/auth/SessionManager.ts', 12, 3),
      ...b.command('c2', 'pnpm vitest run', VITEST_FAIL, { exitCode: 1 }),
      ...b.edit('c3', '/repo/app/src/auth/__mocks__/session.ts', 4, 4),
      ...b.command('c4', 'pnpm vitest run', VITEST_PASS, { exitCode: 0 }),
      b.turnEnded(
        'Moved refresh ownership into SessionManager and added synchronization. All 45 tests pass.',
      ),
    ];
    const { state, changes } = run(events);

    expect(state.status).toBe('idle');
    expect(state.counters.filesChanged).toBe(2);
    expect(state.counters.linesAdded).toBe(16);
    expect(state.verifications).toHaveLength(2);
    expect(state.verifications[0]?.outcome).toBe('fail');
    expect(state.verifications[0]?.counts).toEqual({ failed: 3, passed: 42, total: 45 });
    expect(state.verifications[1]?.outcome).toBe('pass');
    expect(state.verifications[1]?.outcomeEpistemic).toBe('observed');
    expect(state.verifications[1]?.stale).toBe(false);
    expect(state.verifications[0]?.stale).toBe(true);
    // Failing check resolved by passing check
    expect(
      state.review.filter((r) => r.rule === 'verification-failed' && r.resolvedSeq === undefined),
    ).toHaveLength(0);
    // Claim about tests is backed by evidence → no claim-without-evidence item
    expect(state.review.some((r) => r.rule === 'claim-without-evidence')).toBe(false);

    const history = changes.map((c) => `${c.facet}: ${c.summary}`);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^status: Session started/),
        'why: Asked: Fix login session handling so concurrent refreshes do not interfere',
        'status: Investigating the authentication flow to see how refresh is triggered.',
        'why: Found duplicate refresh behavior: AuthMiddleware and SessionManager both rotate tokens.',
        "how: I'll move refresh ownership into SessionManager and add a mutex.",
        'what: Changed SessionManager.ts (+12 −3)',
        'verified: 3 of 45 tests failed (vitest)',
        'what: Changed session.ts (+4 −4)',
        'verified: 45/45 tests passed (vitest)',
      ]),
    );
    const view = projectSession(state);
    expect(view.strip.latestVerification?.outcome).toBe('pass');
    expect(view.verified.unverifiedFiles).toEqual([]);
    expect(view.changes.files.map((f) => f.path)).toContain('/repo/app/src/auth/SessionManager.ts');
    expect(view.report.whatNow?.epistemic).toBe('reported');
    // The finding reaches the reader through the change log, asserted above. Here we check that it
    // was classified with a reason and above the threshold, which is what let it be filed at all.
    const finding = state.claims.find((c) => c.text.startsWith('Found duplicate refresh'));
    expect(finding?.kind).toBe('discovery');
    expect(finding?.rule).toBe('finding-lead');
    expect(finding?.confidence).toBeGreaterThanOrEqual(CLAIM_THRESHOLD);
    const summary = summarizeSession(state);
    expect(summary.counts.filesChanged).toBe(2);
    expect(summary.lastVerification?.outcome).toBe('pass');
  });
});

describe('reducer: unverified claim and destructive commands', () => {
  it('flags a claim of passing tests when nothing ran, and destructive commands', () => {
    const b = new EventBuilder();
    const { state } = run([
      b.sessionStarted(),
      b.turnStarted('Clean up build artifacts'),
      ...b.command('c1', 'rm -rf dist build', ''),
      ...b.edit('c2', '/repo/app/src/index.ts', 1, 1),
      b.turnEnded('Removed old artifacts and fixed the import. Tests pass.'),
    ]);
    const rules = state.review.filter((r) => r.resolvedSeq === undefined).map((r) => r.rule);
    expect(rules).toContain('claim-without-evidence');
    expect(rules).toContain('destructive:rm-rf');
    // The quoted excerpt must show the segment that tripped the rule, not the head of the
    // command — `cd <long path> && rm -rf x` otherwise reads as "recursive force delete: cd …".
    const destructive = state.review.find((r) => r.rule === 'destructive:rm-rf');
    expect(destructive?.summary).toContain('rm -rf');
    expect(rules).toContain('changes-unverified');
    const view = projectSession(state);
    expect(view.review.items[0]?.severity).toBe('medium');
    expect(view.verified.glance).toBe('No checks observed');
  });
});

describe('reducer: what clears unverified changes', () => {
  /*
   * A passing lint is a passing check and is not evidence that the work runs. Every reader of
   * `lastPass` already excluded it, so when the review rule did not, one report answered the same
   * question twice: the verdict said "unverified" while the item a person was meant to act on had
   * been withdrawn from Needs you.
   */
  it('does not let a passing lint clear the unverified-changes item, but a passing test does', () => {
    const b = new EventBuilder();
    const open = (state: RunState) =>
      state.review.some((r) => r.rule === 'changes-unverified' && r.resolvedSeq === undefined);

    const { state } = run([
      b.sessionStarted(),
      b.turnStarted('Change a file and check nothing'),
      ...b.edit('c1', '/repo/app/src/index.ts', 8, 2),
      b.turnEnded('Edited the entry point.'),
    ]);
    expect(open(state)).toBe(true);

    run(
      [
        b.turnStarted('Lint it'),
        ...b.command('c2', 'eslint .', 'All files pass linting.', { exitCode: 0 }),
        b.turnEnded('Lint passes.'),
      ],
      state,
    );
    expect(state.verifications.at(-1)?.method).toBe('lint');
    expect(state.verifications.at(-1)?.outcome).toBe('pass');
    expect(state.verifications.at(-1)?.scope).toBe('full');
    expect(open(state)).toBe(true);

    run(
      [
        b.turnStarted('Now actually test it'),
        ...b.command('c3', 'pnpm vitest run', VITEST_PASS, { exitCode: 0 }),
        b.turnEnded('Tests pass.'),
      ],
      state,
    );
    expect(open(state)).toBe(false);
  });
});

describe('reducer: plan changes and remaining work', () => {
  it('tracks replace/merge plan semantics and remaining items', () => {
    const b = new EventBuilder();
    const { state, changes } = run([
      b.sessionStarted(),
      b.turnStarted('Implement feature X'),
      b.plan([
        { id: 'a', text: 'Investigate current behavior', status: 'in_progress' },
        { id: 'b', text: 'Implement change', status: 'pending' },
        { id: 'c', text: 'Add tests', status: 'pending' },
      ]),
      b.plan(
        [
          { id: 'a', text: 'Investigate current behavior', status: 'completed' },
          { id: 'b', text: 'Implement change', status: 'in_progress' },
        ],
        'merge',
      ),
      b.plan(
        [
          {
            id: 'b',
            text: 'Implement change (revised: use versioned writes)',
            status: 'in_progress',
          },
          { id: 'd', text: 'Handle conflicts', status: 'pending' },
          { id: 'c', text: 'Add tests', status: 'pending' },
        ],
        'replace',
        'Concurrent writes need versioning',
      ),
    ]);
    expect(state.plan.items.map((i) => i.id)).toEqual(['b', 'd', 'c']);
    expect(state.plan.explanation).toBe('Concurrent writes need versioning');
    const facets = changes.map((c) => `${c.facet}: ${c.summary}`);
    expect(facets).toContain('left: Done: Investigate current behavior');
    expect(facets).toContain('why: Plan changed: Concurrent writes need versioning');
    expect(facets.some((f) => f.startsWith('how: Plan: 3 steps'))).toBe(true);
    const view = projectSession(state);
    expect(view.left.items).toHaveLength(3);
    expect(view.left.glance).toBe('3 of 3 steps remaining');
    expect(view.report.plan[0]).toEqual({
      text: 'Implement change (revised: use versioned writes)',
      status: 'in_progress',
    });
  });
});

describe('reducer: waiting, interruption, failures', () => {
  it('reports waiting for permission and resolves it on the next tool activity', () => {
    const b = new EventBuilder();
    const state = fresh();
    run(
      [b.sessionStarted(), b.turnStarted('Deploy'), b.permission('Bash', 'git push origin main')],
      state,
    );
    expect(state.status).toBe('waiting');
    expect(
      state.review.some((r) => r.rule === 'waiting-permission' && r.resolvedSeq === undefined),
    ).toBe(true);
    run(b.command('c1', 'git push origin main', 'Everything up-to-date', { exitCode: 0 }), state);
    expect(state.status).toBe('working');
    expect(
      state.review.some((r) => r.rule === 'waiting-permission' && r.resolvedSeq === undefined),
    ).toBe(false);
  });

  it('marks running tools unknown when the turn is interrupted', () => {
    const b = new EventBuilder();
    const { state } = run([
      b.sessionStarted(),
      b.turnStarted('Long task'),
      b.toolCalled('c1', 'Bash', { kind: 'command', command: 'pnpm test' }),
      b.turnEnded(undefined, 'interrupted'),
    ]);
    expect(state.activities.c1?.status).toBe('unknown');
    expect(state.issues.some((i) => i.kind === 'interrupted')).toBe(true);
    expect(state.status).toBe('idle');
  });

  it('derives verification from a failed tool with explicit exit code', () => {
    const b = new EventBuilder();
    const { state } = run([
      b.sessionStarted(),
      b.turnStarted('Typecheck'),
      b.toolCalled('c1', 'Bash', { kind: 'command', command: 'pnpm tsc --noEmit' }),
      b.toolFailed(
        'c1',
        'Bash',
        'Exit code 2\nsrc/a.ts(3,1): error TS2322: Type ...\nFound 1 error in src/a.ts',
        2,
      ),
    ]);
    expect(state.verifications[0]?.method).toBe('typecheck');
    expect(state.verifications[0]?.outcome).toBe('fail');
    expect(state.verifications[0]?.counts?.failed).toBe(1);
    expect(state.review.some((r) => r.rule === 'verification-failed')).toBe(true);
  });
});

describe('reducer: records arriving out of order', () => {
  it('keeps an early turn end closed when its start record arrives later', () => {
    const state = fresh();
    const base = {
      sessionId: state.sessionId,
      tsSource: 'provider' as const,
      source: { provider: 'claude-code' as const, channel: 'hook' as const },
      turnId: 'p1',
    };
    const end = {
      ...base,
      id: 'end-first',
      seq: 0,
      ts: '2026-08-16T10:30:05.000Z',
      kind: 'turn.ended' as const,
      outcome: 'completed' as const,
      lastMessage: 'Done',
    };
    const start = {
      ...base,
      id: 'start-late',
      seq: 1,
      ts: '2026-08-16T10:30:00.000Z',
      kind: 'turn.started' as const,
      prompt: 'Run the checks',
    };
    const { changes } = run([end, start], state);

    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({
      id: 'p1',
      prompt: 'Run the checks',
      startedAt: start.ts,
      endedAt: end.ts,
      outcome: 'completed',
    });
    expect(state.status).toBe('idle');
    expect(changes.map((c) => c.summary)).toContain('Asked: Run the checks');
  });

  it('upgrades a command result placeholder when the call arrives later', () => {
    const b = new EventBuilder();
    const { state } = run([
      b.sessionStarted(),
      b.turnStarted('Run the checks'),
      b.toolCompleted('c1', 'Bash', {
        kind: 'command',
        exit: { code: 0, observation: 'explicit' },
        outputExcerpt: VITEST_PASS,
        outputChars: VITEST_PASS.length,
        truncated: false,
      }),
      b.toolCalled('c1', 'Bash', { kind: 'command', command: 'pnpm vitest run' }),
    ]);

    expect(state.activities.c1).toMatchObject({
      title: 'Run: pnpm vitest run',
      input: { kind: 'command', command: 'pnpm vitest run' },
      status: 'completed',
    });
    expect(state.counters.toolCalls).toBe(1);
    expect(state.counters.commands).toBe(1);
    expect(state.verifications).toHaveLength(1);
    expect(state.verifications[0]?.outcome).toBe('pass');
  });

  it('upgrades a command failure placeholder when the call arrives later', () => {
    const b = new EventBuilder();
    const { state } = run([
      b.sessionStarted(),
      b.turnStarted('Typecheck'),
      b.toolFailed(
        'c1',
        'Bash',
        'Exit code 2\nsrc/a.ts(3,1): error TS2322\nFound 1 error in src/a.ts',
        2,
      ),
      b.toolCalled('c1', 'Bash', { kind: 'command', command: 'pnpm tsc --noEmit' }),
    ]);

    expect(state.activities.c1?.input.kind).toBe('command');
    expect(state.counters.toolCalls).toBe(1);
    expect(state.verifications[0]?.outcome).toBe('fail');
    expect(state.review.some((r) => r.rule === 'verification-failed')).toBe(true);
    expect(state.issues.some((i) => i.callId === 'c1' && i.kind === 'toolError')).toBe(false);
  });

  it('makes contradictory terminal evidence inconclusive regardless of arrival order', () => {
    const scenario = (failureFirst: boolean) => {
      const b = new EventBuilder();
      const events = [
        b.sessionStarted(),
        b.turnStarted('Run the checks'),
        b.toolCalled('c1', 'Bash', { kind: 'command', command: 'pnpm vitest run' }),
      ];
      const pass = () =>
        b.toolCompleted('c1', 'Bash', {
          kind: 'command',
          exit: { code: 0, observation: 'explicit' },
          outputExcerpt: VITEST_PASS,
          outputChars: VITEST_PASS.length,
          truncated: false,
        });
      const fail = () => b.toolFailed('c1', 'Bash', 'provider reports exit code 1', 1);
      events.push(...(failureFirst ? [fail(), pass()] : [pass(), fail()]));
      return run(events).state;
    };

    const passThenFail = scenario(false);
    const failThenPass = scenario(true);
    for (const state of [passThenFail, failThenPass]) {
      expect(state.activities.c1).toMatchObject({
        status: 'unknown',
        sourceConflict: true,
        exit: { observation: 'unknown' },
      });
      expect(state.verifications).toHaveLength(1);
      expect(state.verifications[0]).toMatchObject({
        callId: 'c1',
        outcome: 'unknown',
        exit: { observation: 'unknown' },
      });
      expect(state.verifications[0]?.caveats).toContain('source-conflict');
      expect(
        state.review.filter((item) => item.rule === 'source-conflict' && !item.resolvedSeq),
      ).toHaveLength(1);
      expect(
        state.review.filter((item) => item.rule === 'verification-failed' && !item.resolvedSeq),
      ).toHaveLength(0);
      expect(state.issues.filter((issue) => issue.callId === 'c1')).toHaveLength(0);
      expect(state.counters.toolFailures).toBe(1);
    }
    expect(passThenFail.activities.c1?.eventIds).toEqual(failThenPass.activities.c1?.eventIds);
    expect(passThenFail.verifications[0]?.outcome).toBe(failThenPass.verifications[0]?.outcome);
  });
});

describe('reducer: idempotence, duplicates and checkpoint replay', () => {
  it('ignores events with a seq already applied and gives identical results from a checkpoint', () => {
    const b = new EventBuilder();
    const events = [
      b.sessionStarted(),
      b.turnStarted('Refactor'),
      ...b.edit('c1', '/repo/app/a.ts', 5, 2),
      ...b.command('c2', 'pnpm vitest run', VITEST_PASS),
      b.turnEnded('Done, tests pass'),
      b.turnStarted('Second ask'),
      ...b.edit('c3', '/repo/app/b.ts', 1, 0),
      b.turnEnded('ok'),
    ];
    const full = run(events).state;
    // Duplicate delivery of already-applied events changes nothing.
    const before = JSON.stringify(full);
    applyEvent(full, events[3] as StoredEvent);
    expect(JSON.stringify(full)).toBe(before);

    // Checkpoint after 5 events, replay the rest → identical.
    const cp = run(events.slice(0, 5)).state;
    const clone = cloneState(cp);
    const { state: resumed } = replayEvents(clone, events.slice(5));
    const strip = (s: RunState) => JSON.stringify({ ...s, revision: 0 });
    expect(strip(resumed)).toBe(strip(full));
    // Point-in-time: state at seq of the first turn end
    const untilSeq = events[5]?.seq ?? 0;
    const partial = replayEvents(fresh(), events, untilSeq).state;
    expect(partial.turns).toHaveLength(1);
    expect(partial.counters.filesChanged).toBe(1);
  });

  it('inferred-success exit yields pass with an explicit caveat', () => {
    const b = new EventBuilder();
    const { state } = run([
      b.sessionStarted(),
      b.turnStarted('t'),
      ...b.command('c1', 'npm test', 'no summary here', { observation: 'inferred-success' }),
    ]);
    const v = state.verifications[0];
    expect(v?.outcome).toBe('pass');
    expect(v?.outcomeEpistemic).toBe('inferred');
    expect(v?.caveats).toContain('exit-inferred');
    expect(v?.caveats).toContain('no-summary-parsed');
  });
});

describe('reducer: revision anchors and file locations', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);
  const D = 'd'.repeat(40);

  function snapshot(
    b: EventBuilder,
    id: string,
    head: string,
    trigger?: 'session.started' | 'turn.ended' | 'commit',
    branch = 'main',
  ): StoredEvent {
    return b.raw({ id, kind: 'git.snapshot', repoRoot: '/repo', head, branch, dirty: [], trigger });
  }

  function session() {
    const b = new EventBuilder();
    return [
      b.sessionStarted(),
      snapshot(b, 'git:start', A, 'session.started'),
      b.turnStarted('First'),
      snapshot(b, 'git:commit', B, 'commit'),
      b.turnEnded('Done.'),
      snapshot(b, 'git:end1', B, 'turn.ended'),
      // A resume starts the session again; the anchor at start stays the first one.
      b.sessionStarted(),
      snapshot(b, 'git:resume', C, 'session.started', 'feature'),
      b.turnStarted('Second'),
      b.turnEnded('Done again.'),
      snapshot(b, 'git:end2', D, 'turn.ended', 'feature'),
      b.raw({
        id: 'located:1',
        kind: 'file.located',
        files: [
          {
            path: '/work/tree/src/a.ts',
            repository: { root: '/work/tree', path: 'src/a.ts', mainRoot: '/repo' },
          },
          { path: '/tmp/scratch.txt', repository: null },
        ],
      }),
      b.raw({
        id: 'located:2',
        kind: 'file.located',
        files: [
          {
            path: '/work/tree/src/a.ts',
            repository: { root: '/repo', path: 'work/tree/src/a.ts' },
          },
        ],
      }),
    ];
  }

  it('anchors the first session start and the latest turn end, and nothing else', () => {
    const { state } = run(session());
    expect(state.git.atStart).toMatchObject({ head: A, branch: 'main' });
    expect(state.git.atTurnEnd).toMatchObject({ head: D, branch: 'feature' });
    expect(state.git.head).toBe(D);
  });

  it('does not guess a boundary for a snapshot written before snapshots named their trigger', () => {
    const b = new EventBuilder();
    const { state } = run([b.sessionStarted(), snapshot(b, 'git:old', A), b.turnEnded('Done.')]);
    expect(state.git.head).toBe(A);
    expect(state.git.atStart).toBeUndefined();
    expect(state.git.atTurnEnd).toBeUndefined();
  });

  it('keeps the latest location of each path, including that none was found', () => {
    const { state } = run(session());
    expect(state.fileLocations).toEqual({
      '/work/tree/src/a.ts': { root: '/repo', path: 'work/tree/src/a.ts' },
      '/tmp/scratch.txt': null,
    });
  });

  it('replays to the same anchors and locations from a checkpoint as from the start', () => {
    const events = session();
    const whole = run(events).state;
    const split = events.findIndex((e) => e.id === 'git:resume');
    const checkpoint = cloneState(replayEvents(fresh(), events.slice(0, split)).state);
    const resumed = replayEvents(JSON.parse(JSON.stringify(checkpoint)), events.slice(split)).state;
    expect(resumed.git.atStart).toEqual(whole.git.atStart);
    expect(resumed.git.atTurnEnd).toEqual(whole.git.atTurnEnd);
    expect(resumed.fileLocations).toEqual(whole.fileLocations);
  });
});

describe('reducer: a better record of a command that already finished', () => {
  it('derives its check once, however many records of the call arrive', () => {
    const b = new EventBuilder('codex:t');
    const input = { kind: 'command' as const, command: 'pnpm vitest run' };
    const result = (exit: { code?: number; observation: 'explicit' | 'unknown' }) => ({
      kind: 'command' as const,
      exit,
      outputExcerpt: VITEST_PASS,
      outputChars: VITEST_PASS.length,
      truncated: false,
    });
    const { state } = run([
      b.sessionStarted(),
      b.turnStarted('Run the tests'),
      // A hook reports the call and its result first, without an exit code.
      ...[
        b.raw({
          id: 'tool:x:call',
          kind: 'tool.called',
          callId: 'x',
          toolName: 'Bash',
          input,
          title: 'Run',
        }),
        b.raw({
          id: 'tool:x:result:hook',
          kind: 'tool.completed',
          callId: 'x',
          toolName: 'Bash',
          result: result({ observation: 'unknown' }),
          isError: false,
        }),
      ].map((e) => ({ ...e, source: { provider: 'codex', channel: 'hook' } }) as StoredEvent),
      // Then the provider's own records of the same call, under their own ids.
      b.raw({
        id: 'tool:x:call:item',
        kind: 'tool.called',
        callId: 'x',
        toolName: 'exec_command',
        input,
        title: 'Run: pnpm vitest run',
      }),
      b.raw({
        id: 'tool:x:result',
        kind: 'tool.completed',
        callId: 'x',
        toolName: 'exec_command',
        result: result({ code: 0, observation: 'explicit' }),
        isError: false,
      }),
    ]);
    expect(state.verifications.map((v) => [v.callId, v.outcome, v.exit?.observation])).toEqual([
      ['x', 'pass', 'explicit'],
    ]);
    expect(state.counters.commands).toBe(1);
  });
});

describe('reducer: a removed line count that is unknown', () => {
  it('marks the file and the session for good, and never treats the count as exact again', () => {
    const b = new EventBuilder();
    const overwrite = (callId: string) => [
      b.toolCalled(callId, 'write', { kind: 'fileWrite', path: '/repo/a.ts' }),
      b.toolCompleted(callId, 'write', {
        kind: 'fileChanges',
        changes: [
          {
            path: '/repo/a.ts',
            change: 'update',
            linesAdded: 12,
            linesRemoved: 0,
            linesRemovedUnknown: true,
            applied: true,
          },
        ],
      }),
    ];
    const { state } = run([
      b.sessionStarted(),
      b.turnStarted('Rewrite a'),
      ...b.edit('e1', '/repo/b.ts', 2, 1),
      ...overwrite('w1'),
      // An exact change afterwards does not make the earlier unknown count known.
      ...b.edit('e2', '/repo/a.ts', 1, 1),
    ]);
    expect(state.files['/repo/a.ts']?.linesRemovedUnknown).toBe(true);
    expect(state.files['/repo/b.ts']?.linesRemovedUnknown).toBeUndefined();
    expect(state.counters.linesRemovedUnknown).toBe(true);
    expect(state.counters.linesRemoved).toBe(2);
    expect(summarizeSession(state, Date.parse('2026-08-16T11:00:00.000Z')).counts).toMatchObject({
      linesRemoved: 2,
      linesRemovedExact: false,
    });
  });

  it('calls a session with only known counts exact', () => {
    const b = new EventBuilder();
    const { state } = run([b.sessionStarted(), ...b.edit('e1', '/repo/b.ts', 2, 1)]);
    expect(summarizeSession(state, Date.parse('2026-08-16T11:00:00.000Z')).counts).toMatchObject({
      linesRemovedExact: true,
    });
  });
});
