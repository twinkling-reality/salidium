import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEvent, createInitialState, REDUCER_VERSION, summarizeSession } from '@salidium/core';
import { EventBuilder } from '@salidium/core/testing';
import type { SemanticChange, StoredEvent } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../logging/logger.ts';
import type { SalidiumStore } from '../storage/salidiumStore.ts';
import { createSqliteStore } from '../storage/sqliteStore.ts';
import { HistoryWarmup } from './historyWarmup.ts';
import { SessionRegistry } from './sessionRegistry.ts';

const OLD = '1.0.0-old';
const quiet = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'salidium-warmup-'));
  roots.push(root);
  return join(root, 'salidium.db');
}

/**
 * A session as an older Salidium left it: its events, its summary, and a checkpoint and change log
 * from a reducer version that no longer exists, so its next load would replay everything.
 */
function seedOldSession(
  store: SalidiumStore,
  id: string,
  commands: number,
  startIso = '2026-09-01T10:00:00.000Z',
): StoredEvent[] {
  const b = new EventBuilder(`claude-code:${id}`, startIso);
  const events: StoredEvent[] = [b.sessionStarted(), b.turnStarted('Work')];
  for (let i = 0; i < commands; i++)
    events.push(...b.command(`c${i}`, 'pnpm vitest run', ' Tests  1 passed (1)', { exitCode: 0 }));
  events.push(b.turnEnded('Done.'));
  store.insertEvents(events);
  const state = createInitialState({
    sessionId: `claude-code:${id}`,
    provider: 'claude-code',
    providerSessionId: id,
    cwd: '/repo/app',
  });
  const changes: SemanticChange[] = [];
  for (const e of events) changes.push(...applyEvent(state, e));
  store.upsertSession(summarizeSession(state, Date.parse(startIso)));
  store.insertChanges(changes, OLD);
  store.saveCheckpoint(`claude-code:${id}`, state.latestSeq, OLD, state);
  return events;
}

function warmup(
  store: SalidiumStore,
  overrides: Partial<ConstructorParameters<typeof HistoryWarmup>[0]> = {},
) {
  return new HistoryWarmup({
    store,
    log: quiet,
    isLive: () => false,
    isPaused: () => false,
    pausePollMs: 5,
    ...overrides,
  });
}

describe('session history warm-up after a reducer upgrade', () => {
  it('re-derives every stale session as its first load would, and drops the old checkpoints', async () => {
    const store = createSqliteStore(storePath());
    const a = seedOldSession(store, 'a', 3);
    seedOldSession(store, 'b', 2);
    expect(store.countSessionsNeedingReplay?.(REDUCER_VERSION)).toBe(2);
    const w = warmup(store);
    w.start();
    await w.settled();
    expect(store.countSessionsNeedingReplay?.(REDUCER_VERSION)).toBe(0);
    const checkpoint = store.latestCheckpoint('claude-code:a', REDUCER_VERSION);
    expect(checkpoint?.seq).toBe(a.at(-1)?.seq);
    expect(checkpoint?.state.counters.commands).toBe(3);
    // No checkpoint of the old reducer is left to sit unreadable in the file.
    expect(store.latestCheckpoint('claude-code:a', OLD)).toBeUndefined();
    expect(store.changeLogIsStale('claude-code:a', REDUCER_VERSION)).toBe(false);
    expect(w.progress()).toBeNull();
    store.close();
  });

  it('newest activity first, and resumes across a restart with the same total', async () => {
    const path = storePath();
    let store = createSqliteStore(path);
    seedOldSession(store, 'older', 1, '2026-08-01T10:00:00.000Z');
    seedOldSession(store, 'newer', 1, '2026-09-20T10:00:00.000Z');
    seedOldSession(store, 'middle', 1, '2026-09-01T10:00:00.000Z');
    // Stop after the first session is stored, as a daemon stop would.
    const first = warmup(store, {
      isPaused: () => (store.countSessionsNeedingReplay?.(REDUCER_VERSION) ?? 0) < 3,
    });
    first.start();
    for (
      let i = 0;
      i < 200 && (store.countSessionsNeedingReplay?.(REDUCER_VERSION) ?? 0) === 3;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    await first.stop();
    expect(store.latestCheckpoint('claude-code:newer', REDUCER_VERSION)).toBeDefined();
    expect(store.latestCheckpoint('claude-code:older', REDUCER_VERSION)).toBeUndefined();
    store.close();

    store = createSqliteStore(path);
    const second = warmup(store, { isPaused: () => false });
    second.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(second.progress()).toMatchObject({ total: 3 });
    await second.settled();
    expect(store.countSessionsNeedingReplay?.(REDUCER_VERSION)).toBe(0);
    store.close();
  });

  it('leaves a session someone opened to that open, and writes nothing half-done for it', async () => {
    const store = createSqliteStore(storePath());
    seedOldSession(store, 'open', 2);
    seedOldSession(store, 'closed', 2);
    const w = warmup(store, { isLive: (id) => id === 'claude-code:open' });
    w.start();
    for (
      let i = 0;
      i < 200 && store.latestCheckpoint('claude-code:closed', REDUCER_VERSION) === undefined;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    await w.stop();
    expect(store.latestCheckpoint('claude-code:closed', REDUCER_VERSION)).toBeDefined();
    expect(store.latestCheckpoint('claude-code:open', REDUCER_VERSION)).toBeUndefined();
    store.close();
  });

  it('never holds the event loop for more than one slice of a large session', async () => {
    const store = createSqliteStore(storePath());
    seedOldSession(store, 'large', 3000); // over 6,000 events
    const counted = store as SalidiumStore & { eventsAfter: SalidiumStore['eventsAfter'] };
    const eventsAfter = counted.eventsAfter.bind(store);
    let sinceYield = 0;
    let largest = 0;
    let slices = 0;
    counted.eventsAfter = (...args) => {
      const page = eventsAfter(...args);
      sinceYield += page.length;
      largest = Math.max(largest, sinceYield);
      return page;
    };
    const w = warmup(store, {
      sliceEvents: 1000,
      sliceMs: 60_000,
      yieldToLoop: async () => {
        slices += 1;
        sinceYield = 0;
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    w.start();
    await w.settled();
    expect(largest).toBeLessThanOrEqual(1000);
    expect(slices).toBeGreaterThanOrEqual(6);
    expect(
      store.latestCheckpoint('claude-code:large', REDUCER_VERSION)?.state.counters.commands,
    ).toBe(3000);
    store.close();
  });

  it('waits out a pause, saying so, and continues', async () => {
    const store = createSqliteStore(storePath());
    seedOldSession(store, 'held', 1);
    let paused = true;
    const w = warmup(store, { isPaused: () => paused });
    w.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(w.progress()).toMatchObject({ state: 'paused', updated: 0, total: 1 });
    expect(store.latestCheckpoint('claude-code:held', REDUCER_VERSION)).toBeUndefined();
    paused = false;
    await w.settled();
    expect(store.latestCheckpoint('claude-code:held', REDUCER_VERSION)).toBeDefined();
    store.close();
  });

  it('neither loads a session for retention nor asks for an explanation', async () => {
    const store = createSqliteStore(storePath());
    seedOldSession(store, 'ancient', 1, '2024-01-01T10:00:00.000Z');
    let explanations = 0;
    const registry = new SessionRegistry(store, {
      explainerCadence: 'while-it-works',
      explainSession: async () => {
        explanations += 1;
        return { status: 'failed' } as never;
      },
    });
    const w = warmup(store, { isLive: (id) => registry.peek(id) !== undefined });
    w.start();
    await w.settled();
    expect(registry.peek('claude-code:ancient')).toBeUndefined();
    expect(explanations).toBe(0);
    // Retention still sees it as an inactive session and removes it.
    store.setRetentionPolicy(30);
    const removed = registry.applyRetention(new Date('2026-10-02T00:00:00.000Z'));
    expect(removed.sessions.map((s) => s.id)).toContain('claude-code:ancient');
    registry.close();
    store.close();
  });

  it('drops a session’s older-reducer checkpoints whenever a current one is written', () => {
    const store = createSqliteStore(storePath());
    const events = seedOldSession(store, 'loaded', 1);
    const state = store.latestCheckpoint('claude-code:loaded', OLD)?.state;
    if (!state) throw new Error('seeded checkpoint missing');
    store.saveCheckpoint('claude-code:loaded', events.at(-1)?.seq ?? 0, REDUCER_VERSION, state);
    expect(store.latestCheckpoint('claude-code:loaded', OLD)).toBeUndefined();
    expect(store.latestCheckpoint('claude-code:loaded', REDUCER_VERSION)).toBeDefined();
    store.close();
  });
});

describe('session history warm-up and live sessions', () => {
  it('yields between small sessions and stops once only open sessions remain', async () => {
    const store = createSqliteStore(storePath());
    for (const id of ['s1', 's2', 's3', 's4', 'open']) seedOldSession(store, id, 1);
    let yields = 0;
    const w = warmup(store, {
      isLive: (id) => id === 'claude-code:open',
      yieldToLoop: async () => {
        yields += 1;
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    w.start();
    await w.settled();
    expect(yields).toBeGreaterThanOrEqual(4);
    // The open session is its coordinator's to checkpoint; the work ends rather than waiting on it.
    expect(store.countSessionsNeedingReplay?.(REDUCER_VERSION)).toBe(1);
    expect(w.progress()).toBeNull();
    store.close();
  });
});
