import { describe, expect, it } from 'vitest';
import { createInitialState } from '../state/createInitialState.ts';
import { applyEvent } from '../state/reducer.ts';
import { EventBuilder } from '../testing/eventBuilders.ts';
import { projectSession } from './projectSession.ts';

/**
 * The at-a-glance columns have room for a line per method, not a line per run, so they collapse.
 * Collapsing to the *latest* run prints a question mark over evidence the session already has
 * whenever the newest run's outcome could not be read. It collapses to the latest run that could
 * be read, and says when that is not the newest.
 */
function project(runs: Array<{ output: string; exit?: number; unreadable?: boolean }>) {
  const b = new EventBuilder('claude-code:s', '2026-08-18T09:00:00.000Z');
  const state = createInitialState({
    sessionId: 'claude-code:s',
    provider: 'claude-code',
    providerSessionId: 's',
  });
  let seq = 0;
  const push = (e: ReturnType<typeof b.message>) => applyEvent(state, { ...e, seq: seq++ });
  push(b.sessionStarted('/repo'));
  runs.forEach((r, i) => {
    // An unreadable run is what a code-mode Codex cell leaves behind: output that parses to no
    // summary and an exit status nothing reported.
    const opts = r.unreadable ? { observation: 'unknown' as const } : { exitCode: r.exit };
    for (const e of b.command(`c${i}`, 'pnpm vitest run', r.output, opts)) push(e as never);
  });
  return projectSession(state, Date.parse('2026-08-18T10:00:00.000Z'));
}

const PASS = ' Tests  3 passed (3)';
const FAIL = ' Tests  1 failed | 2 passed (3)';

describe('verified summary', () => {
  /**
   * The defect this replaced was not subtle and had nothing to do with unknowns: both renderers
   * reversed `runs` — which the projection already hands out newest-first — and then took the
   * first of each method, so the summary named the *oldest* run of every method. That can print a
   * green pass after the newest run failed or a failure the agent later fixed.
   */
  it('names the newest run of a method, not the first one the session happened to run', () => {
    const v = project([
      { output: PASS, exit: 0 },
      { output: PASS, exit: 0 },
      { output: FAIL, exit: 1 },
    ]);
    expect(v.verified.summary).toHaveLength(1);
    expect(v.verified.summary[0]?.outcome).toBe('fail');
    // And the other direction: a fix must not keep reading as a failure.
    const w = project([
      { output: FAIL, exit: 1 },
      { output: PASS, exit: 0 },
    ]);
    expect(w.verified.summary[0]?.outcome).toBe('pass');
  });

  it('keeps the last outcome it could read, and says it is not the newest run', () => {
    const v = project([
      { output: FAIL, exit: 1 },
      { output: '', unreadable: true },
    ]);
    expect(v.verified.summary).toHaveLength(1);
    expect(v.verified.summary[0]?.outcome).toBe('fail');
    expect(v.verified.summary[0]?.laterUnreadable).toBe(1);
    // Every run is still there underneath; only the collapse changed.
    expect(v.verified.runs).toHaveLength(2);
  });

  it('counts every later run it could not read', () => {
    const v = project([
      { output: PASS, exit: 0 },
      { output: '', unreadable: true },
      { output: '', unreadable: true },
    ]);
    expect(v.verified.summary[0]?.laterUnreadable).toBe(2);
  });

  it('says nothing when nothing was ever readable', () => {
    const v = project([{ output: '', unreadable: true }]);
    expect(v.verified.summary[0]?.outcome).toBe('unknown');
    expect(v.verified.summary[0]?.laterUnreadable).toBe(0);
  });

  it('prefers a newer readable run over an older one, with no caveat', () => {
    const v = project([
      { output: PASS, exit: 0 },
      { output: FAIL, exit: 1 },
    ]);
    expect(v.verified.summary[0]?.outcome).toBe('fail');
    expect(v.verified.summary[0]?.laterUnreadable).toBe(0);
  });

  it('resets the caveat when a later run is readable again', () => {
    const v = project([
      { output: FAIL, exit: 1 },
      { output: '', unreadable: true },
      { output: PASS, exit: 0 },
    ]);
    expect(v.verified.summary[0]?.outcome).toBe('pass');
    expect(v.verified.summary[0]?.laterUnreadable).toBe(0);
  });
});
