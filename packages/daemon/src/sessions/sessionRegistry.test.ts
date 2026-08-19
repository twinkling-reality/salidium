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
