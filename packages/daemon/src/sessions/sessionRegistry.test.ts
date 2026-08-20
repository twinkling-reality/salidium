import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredEvent } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { SessionRegistry } from './sessionRegistry.ts';

describe('SessionRegistry sequence replay', () => {
  it('reconstructs a requested sequence beyond the store read limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'salidium-registry-'));
    const store = new SqliteStore(join(dir, 'db.sqlite'));
    const registry = new SessionRegistry(store);
    const sessionId = 'claude-code:large-replay';
    const events = Array.from(
      { length: 100_005 },
      (_, seq) =>
        ({
          id: `event-${seq}`,
          sessionId,
          seq,
          ts: '2026-08-16T10:30:00.000Z',
          tsSource: 'provider',
          source: { provider: 'claude-code', channel: 'transcript' },
          kind: 'agent.thinking',
          chars: 1,
        }) as StoredEvent,
    );
    store.transaction(() => store.insertEvents(events));
    registry.get(sessionId);

    expect(registry.stateAt(sessionId, 100_001)?.state.latestSeq).toBe(100_001);

    registry.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});

/*
 * A seeded fixture has to be able to say when it is.
 *
 * `effectiveStatus` calls a session with an open turn idle once it has been silent for fifteen
 * minutes, and the coordinator read the wall clock for it directly, which is the one place in this
 * file's path that a caller could not reach. `summarizeSession` has always taken `now` as an
 * argument; this test is that the registry can hand one down. Without it the screenshot fixture in
 * `scripts/demo-daemon.mjs` cannot be pinned to a fixed instant without its three Working sessions
 * being quietly demoted into Recent, and the session list is photographed a group short.
 */
describe('SessionRegistry clock', () => {
  const started = '2026-08-20T16:00:00.000Z';

  function working(registry: SessionRegistry, sessionId: string): void {
    registry.ingest(sessionId, [
      {
        id: `${sessionId}#start`,
        sessionId,
        seq: 0,
        ts: started,
        tsSource: 'provider',
        source: { provider: 'claude-code', channel: 'transcript' },
        kind: 'session.started',
        cwd: '/repo/app',
        reason: 'startup',
      } as StoredEvent,
      {
        id: `${sessionId}#turn`,
        sessionId,
        seq: 1,
        ts: started,
        tsSource: 'provider',
        source: { provider: 'claude-code', channel: 'transcript' },
        kind: 'turn.started',
        prompt: 'Cache the product list',
      } as StoredEvent,
    ]);
  }

  function statusWith(now: (() => number) | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), 'salidium-clock-'));
    const store = new SqliteStore(join(dir, 'db.sqlite'));
    const registry = new SessionRegistry(store, now ? { now } : {});
    const sessionId = 'claude-code:clock';
    working(registry, sessionId);
    const status = registry.get(sessionId).summary.status;
    registry.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    return status;
  }

  it('reads an open turn as working when the clock says the turn is recent', () => {
    expect(statusWith(() => Date.parse('2026-08-20T16:05:00.000Z'))).toBe('working');
  });

  it('reads the same open turn as idle once that clock has moved past the stale window', () => {
    expect(statusWith(() => Date.parse('2026-08-20T16:20:00.000Z'))).toBe('idle');
  });

  it('falls back to the wall clock, under which a turn started in the past is stale', () => {
    expect(statusWith(undefined)).toBe('idle');
  });
});
