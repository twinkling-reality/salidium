import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REDUCER_VERSION } from '@salidium/core';
import type { SemanticChange, SessionSummary } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionCoordinator } from '../sessions/sessionCoordinator.ts';
import { SqliteStore } from './sqliteStore.ts';

/**
 * The change log is derived from the event log, exactly as the state is, so a change in derivation
 * invalidates it. Bumping `REDUCER_VERSION` re-derived the state and left the log alone, which
 * meant a classification rule fixed today reached only sessions recorded after today: every
 * session already in the store kept rendering entries the old rules had produced, in the History
 * rail, at every depth. This is the half of the fix that reaches the sessions a user already has.
 */
const SESSION = 'claude-code:derive-test';

function events(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${SESSION}#msg:${i}`,
    sessionId: SESSION,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    tsSource: 'provider' as const,
    kind: 'agent.message' as const,
    text: "I'll wire the Codex adapter next.",
    phase: 'commentary' as const,
    source: { provider: 'claude-code' as const, channel: 'transcript' as const },
  }));
}

const listener = {
  onEvents: () => {},
  onSummary: (_s: SessionSummary) => {},
};

function open(store: SqliteStore) {
  return SessionCoordinator.load({
    sessionId: SESSION,
    provider: 'claude-code',
    providerSessionId: 'derive-test',
    store,
    listener,
    options: { explain: false, flushDelayMs: 0 },
  });
}

describe('the stored change log carries the reducer that wrote it', () => {
  let dir: string;
  let store: SqliteStore;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'salidium-derive-'));
    store = new SqliteStore(join(dir, 'test.db'));
    const c = open(store);
    c.ingest(events(3));
    c.flush();
    c.close();
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stamps every entry with the running reducer version', () => {
    expect(REDUCER_VERSION).toBe('1.12.0');
    expect(store.changeLogIsStale(SESSION, REDUCER_VERSION)).toBe(false);
    expect(store.changesRange(SESSION, -1, Number.MAX_SAFE_INTEGER).length).toBeGreaterThan(0);
  });

  it('calls a log written by another reducer stale, and one from before the column too', () => {
    expect(store.changeLogIsStale(SESSION, '9.9.9')).toBe(true);
  });

  it('rewrites the log from the event log on the first load after a bump', () => {
    const before = store.changesRange(SESSION, -1, Number.MAX_SAFE_INTEGER);
    // Stand in for what a version bump leaves behind: entries the old rules produced, and the
    // NULL version a store written before the column carries.
    store.transaction(() => {
      const fake: SemanticChange = {
        sessionId: SESSION,
        seq: 0,
        ordinal: 99,
        ts: '2026-01-01T00:00:00.000Z',
        facet: 'left',
        summary: 'Records is still 2,730px — over half the remaining page.',
        epistemic: 'reported',
        refs: [],
      };
      store.insertChanges([fake], 'stale-version');
    });
    expect(store.changeLogIsStale(SESSION, REDUCER_VERSION)).toBe(true);

    // A load with no checkpoint at this version is the replay a bump forces; it rewrites the log.
    store.deleteCheckpoints(SESSION);
    const c = open(store);
    c.flush();
    c.close();
    expect(store.latestCheckpoint(SESSION, REDUCER_VERSION)?.seq).toBe(2);

    const after = store.changesRange(SESSION, -1, Number.MAX_SAFE_INTEGER);
    expect(store.changeLogIsStale(SESSION, REDUCER_VERSION)).toBe(false);
    expect(after.some((x) => x.summary.includes('2,730px'))).toBe(false);
    expect(after.map((x) => x.summary)).toEqual(before.map((x) => x.summary));
  });
});

/**
 * Salidium's own explainer calls are sessions too, and there are more of them than there are of
 * yours: one per turn end. Excluding them after the row limit rather than inside the query is why
 * a store with 458 readable sessions listed 124 of them.
 */
describe('the session list counts sessions a person might read', () => {
  it('applies the limit to user sessions, not to Salidium’s own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'salidium-list-'));
    const store = new SqliteStore(join(dir, 'test.db'));
    try {
      const summary = (id: string, internal: boolean, at: string) =>
        ({
          id,
          provider: 'claude-code',
          providerSessionId: id,
          cwd: '/repo',
          status: 'ended',
          startedAt: at,
          lastEventAt: at,
          latestSeq: 1,
          internal,
          counts: {
            turns: 1,
            toolCalls: 0,
            filesChanged: 0,
            linesAdded: 0,
            linesRemoved: 0,
            reviewOpen: 0,
            remaining: 0,
          },
        }) as unknown as SessionSummary;
      // Nine of Salidium's own for every one of the user's, newest first, as real usage produces.
      for (let i = 0; i < 100; i++)
        store.upsertSession(
          summary(`s${i}`, i % 10 !== 0, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
        );

      const listed = store.listSessions(10);
      expect(listed).toHaveLength(10);
      expect(listed.every((s) => !(s as unknown as { internal: boolean }).internal)).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * An adapter that learns to read something new helps nobody who already has a store: a finished
 * session's file matches its cursor on every start and is skipped, so it keeps the thinner reading
 * the adapter of the day produced. Clearing cursors makes a new adapter re-read durable history.
 */
describe('re-reading session files', () => {
  it('forgets the cursors so the next start parses the files again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'salidium-reingest-'));
    const store = new SqliteStore(join(dir, 'test.db'));
    try {
      const cursor = (path: string, sessionId: string) => ({
        path,
        sessionId,
        provider: 'codex',
        byteOffset: 4096,
        lineNo: 40,
        inode: 1,
      });
      store.upsertSource(cursor('/a/one.jsonl', 'codex:one'));
      store.upsertSource(cursor('/a/two.jsonl', 'codex:two'));
      expect(store.allSources()).toHaveLength(2);

      // One session only: the other keeps its place, so a targeted re-read stays targeted.
      expect(store.clearSourceCursors('codex:one')).toBe(1);
      expect(store.allSources().map((s) => s.sessionId)).toEqual(['codex:two']);
      expect(store.getSource('/a/one.jsonl')).toBeUndefined();

      store.upsertSource(cursor('/a/one.jsonl', 'codex:one'));
      expect(store.clearSourceCursors()).toBe(2);
      expect(store.allSources()).toHaveLength(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
