import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalEvent, ExplainerCadence } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { effectiveCadence, SessionCoordinator } from './sessionCoordinator.ts';

/**
 * The three stops, exercised where they actually decide anything: the coordinator's ingest path.
 *
 * Frequency is the meaningful control, so each setting is asserted by counting the calls a real
 * run of events produces, not by reading a flag back.
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function at(n: number): string {
  return new Date(Date.UTC(2026, 7, 18, 0, n)).toISOString();
}

function turnStarted(sessionId: string, n: number): CanonicalEvent {
  return {
    kind: 'turn.started',
    id: `${sessionId}#turn:${n}:start`,
    sessionId,
    provider: 'claude-code',
    ts: at(n * 2),
    tsSource: 'provider',
    source: { provider: 'claude-code', channel: 'transcript' },
    turnId: `t${n}`,
    prompt: `Fix thing ${n}`,
  };
}

function turnEnded(sessionId: string, n: number): CanonicalEvent {
  return {
    kind: 'turn.ended',
    id: `${sessionId}#turn:${n}:end`,
    sessionId,
    provider: 'claude-code',
    ts: at(n * 2 + 1),
    tsSource: 'provider',
    source: { provider: 'claude-code', channel: 'transcript' },
    turnId: `t${n}`,
    outcome: 'completed',
  };
}

function sessionEnded(sessionId: string): CanonicalEvent {
  return {
    kind: 'session.ended',
    id: `${sessionId}#session:end`,
    sessionId,
    provider: 'claude-code',
    ts: at(99),
    tsSource: 'provider',
    source: { provider: 'claude-code', channel: 'transcript' },
  };
}

/** A coordinator that records every explainer call instead of making one. */
function coordinatorAt(cadence: ExplainerCadence, opts: { idleEndMs?: number } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'salidium-cadence-'));
  temporaryDirectories.push(path);
  const store = new SqliteStore(join(path, 'test.db'));
  const sessionId = `claude-code:${cadence}-${Math.random().toString(16).slice(2)}`;
  const calls: number[] = [];
  const coordinator = SessionCoordinator.load({
    sessionId,
    provider: 'claude-code',
    providerSessionId: sessionId,
    store,
    listener: { onEvents: () => {}, onSummary: () => {} },
    options: {
      cadence,
      flushDelayMs: 10_000,
      idleEndMs: opts.idleEndMs ?? 30 * 60_000,
      // Resolves to a failure, so nothing is ingested and the guards see exactly the sequence the
      // events produced. What is under test is how often it is asked, not what comes back.
      explainSession: async (state) => {
        calls.push(state.latestSeq);
        return { status: 'failed' };
      },
    },
  });
  return { coordinator, calls, sessionId };
}

/** Lets the explainer promise and its `.finally` settle before the next assertion. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('when the explainer runs', () => {
  it('never calls at the off stop, however many turns end', async () => {
    const { coordinator, calls, sessionId } = coordinatorAt('off');
    for (let n = 1; n <= 3; n++) {
      coordinator.ingest([turnStarted(sessionId, n), turnEnded(sessionId, n)]);
      await settle();
    }
    coordinator.ingest([sessionEnded(sessionId)]);
    await settle();
    expect(calls).toEqual([]);
    expect(coordinator.summary.explanationStatus).toBe('disabled');
  });

  it('calls at every turn end at the while-it-works stop', async () => {
    const { coordinator, calls, sessionId } = coordinatorAt('turn');
    for (let n = 1; n <= 3; n++) {
      coordinator.ingest([turnStarted(sessionId, n), turnEnded(sessionId, n)]);
      // Awaited between turns because a call already in flight is skipped by design; without this
      // the test would be measuring the concurrency guard rather than the stop.
      await settle();
    }
    expect(calls).toHaveLength(3);
  });

  it('does not call at a turn end at the session stop, and calls once when the session ends', async () => {
    const { coordinator, calls, sessionId } = coordinatorAt('session');
    for (let n = 1; n <= 3; n++) {
      coordinator.ingest([turnStarted(sessionId, n), turnEnded(sessionId, n)]);
      await settle();
    }
    expect(calls).toEqual([]);
    coordinator.ingest([sessionEnded(sessionId)]);
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('treats silence after a turn as the end when the provider never says so', async () => {
    // 1 ms rather than the shipped thirty minutes: what is under test is that the timer exists and
    // fires exactly once for a run of turns, not the length of the window.
    const { coordinator, calls, sessionId } = coordinatorAt('session', { idleEndMs: 1 });
    coordinator.ingest([turnStarted(sessionId, 1), turnEnded(sessionId, 1)]);
    coordinator.ingest([turnStarted(sessionId, 2), turnEnded(sessionId, 2)]);
    expect(calls).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('re-arms the silence, so a session still working is not declared over', async () => {
    const { coordinator, calls, sessionId } = coordinatorAt('session', { idleEndMs: 60_000 });
    coordinator.ingest([turnStarted(sessionId, 1), turnEnded(sessionId, 1)]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    coordinator.ingest([turnStarted(sessionId, 2), turnEnded(sessionId, 2)]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
  });

  it('adopts a stop chosen while the session is already live', async () => {
    const { coordinator, calls, sessionId } = coordinatorAt('turn');
    coordinator.ingest([turnStarted(sessionId, 1), turnEnded(sessionId, 1)]);
    await settle();
    expect(calls).toHaveLength(1);
    coordinator.setCadence('off');
    expect(coordinator.summary.explanationStatus).toBe('disabled');
    coordinator.ingest([turnStarted(sessionId, 2), turnEnded(sessionId, 2)]);
    await settle();
    expect(calls).toHaveLength(1);
    coordinator.setCadence('turn');
    coordinator.ingest([turnStarted(sessionId, 3), turnEnded(sessionId, 3)]);
    await settle();
    expect(calls).toHaveLength(2);
  });

  it('keeps `explain: false` meaning never, whatever stop is passed beside it', async () => {
    const path = mkdtempSync(join(tmpdir(), 'salidium-cadence-legacy-'));
    temporaryDirectories.push(path);
    const store = new SqliteStore(join(path, 'test.db'));
    const sessionId = 'claude-code:legacy';
    const calls: number[] = [];
    const coordinator = SessionCoordinator.load({
      sessionId,
      provider: 'claude-code',
      providerSessionId: 'legacy',
      store,
      listener: { onEvents: () => {}, onSummary: () => {} },
      options: {
        explain: false,
        cadence: 'turn',
        flushDelayMs: 10_000,
        explainSession: async () => {
          calls.push(0);
          return { status: 'failed' };
        },
      },
    });
    coordinator.ingest([turnStarted(sessionId, 1), turnEnded(sessionId, 1)]);
    await settle();
    expect(calls).toEqual([]);
  });
});

describe('the environment against the stored stop', () => {
  it('holds the explainer off whatever was chosen', () => {
    expect(effectiveCadence('turn', { SALIDIUM_EXPLAINER: 'off' })).toBe('off');
    expect(effectiveCadence('session', { SALIDIUM_EXPLAIN: '0' })).toBe('off');
  });

  it('never forces it on: naming a backend says which, not how often', () => {
    expect(effectiveCadence('off', { SALIDIUM_EXPLAINER: 'claude' })).toBe('off');
    expect(effectiveCadence('session', { SALIDIUM_EXPLAINER: 'auto' })).toBe('session');
    expect(effectiveCadence('turn', {})).toBe('turn');
  });
});
