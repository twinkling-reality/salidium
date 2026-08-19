import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalEvent } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { SessionCoordinator } from './sessionCoordinator.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SessionCoordinator runtime validation', () => {
  it('stores one deterministic warning without partially reducing a malformed event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'salidium-validation-'));
    dirs.push(dir);
    const path = join(dir, 'db.sqlite');
    const sessionId = 'claude-code:malformed';
    const listener = { onEvents() {}, onSummary() {} };
    const malformed = {
      id: 'provider-record-1',
      sessionId,
      ts: '2026-08-16T10:30:00.000Z',
      tsSource: 'provider',
      source: { provider: 'claude-code', channel: 'transcript' },
      kind: 'git.snapshot',
      repoRoot: '/repo',
      dirty: null,
    } as unknown as CanonicalEvent;

    let store = new SqliteStore(path);
    let coordinator = SessionCoordinator.load({
      sessionId,
      provider: 'claude-code',
      providerSessionId: 'malformed',
      store,
      listener,
      options: { explain: false },
    });
    expect(coordinator.ingest([malformed])).toBe(1);
    expect(coordinator.state.counters.ingestWarnings).toBe(1);
    expect(coordinator.state.git.dirtyCount).toBeUndefined();
    coordinator.close();
    expect(store.eventsAfter(sessionId, -1)).toEqual([
      expect.objectContaining({ kind: 'ingest.warning', seq: 0 }),
    ]);
    expect(store.eventsAfter(sessionId, -1)[0]?.id).not.toBe(malformed.id);
    store.close();

    store = new SqliteStore(path);
    coordinator = SessionCoordinator.load({
      sessionId,
      provider: 'claude-code',
      providerSessionId: 'malformed',
      store,
      listener,
      options: { explain: false },
    });
    expect(coordinator.state.counters.ingestWarnings).toBe(1);
    expect(coordinator.ingest([malformed])).toBe(0);
    expect(coordinator.state.latestSeq).toBe(0);
    expect(store.countEvents(sessionId)).toBe(1);
    const corrected = { ...malformed, dirty: [] } as unknown as CanonicalEvent;
    expect(coordinator.ingest([corrected])).toBe(1);
    expect(coordinator.state.latestSeq).toBe(1);
    coordinator.flush();
    expect(store.countEvents(sessionId)).toBe(2);
    coordinator.close();
    store.close();
  });

  it('builds a valid deterministic warning envelope for an arbitrary object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'salidium-validation-'));
    dirs.push(dir);
    const store = new SqliteStore(join(dir, 'db.sqlite'));
    const sessionId = 'codex:arbitrary';
    const coordinator = SessionCoordinator.load({
      sessionId,
      provider: 'codex',
      providerSessionId: 'arbitrary',
      store,
      listener: { onEvents() {}, onSummary() {} },
      options: { explain: false },
    });
    const arbitrary = { unexpected: ['shape'], nested: { value: 42 } } as unknown as CanonicalEvent;

    expect(coordinator.ingest([arbitrary])).toBe(1);
    const warning = coordinator.state.counters.ingestWarnings;
    coordinator.flush();
    const stored = store.eventsAfter(sessionId, -1)[0];
    expect(stored).toMatchObject({
      sessionId,
      tsSource: 'ingest',
      source: { provider: 'codex', channel: 'salidium' },
      kind: 'ingest.warning',
      code: 'malformed-record',
    });
    expect(stored?.id).toMatch(/^codex:arbitrary#ingest:warning:runtime:[0-9a-f]{32}$/);
    expect(Number.isNaN(Date.parse(stored?.ts ?? ''))).toBe(false);
    expect(warning).toBe(1);
    expect(coordinator.ingest([arbitrary])).toBe(0);
    expect(store.countEvents(sessionId)).toBe(1);

    coordinator.close();
    store.close();
  });
});
