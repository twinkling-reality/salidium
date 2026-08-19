import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionSummary } from '@salidium/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './sqliteStore.ts';

/**
 * Matching moved out of the browser and into SQL, so these tests keep the two implementations the
 * same shape and ensure a match outside the default page remains reachable.
 */
let dir: string;
let store: SqliteStore;

function summary(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    provider: 'claude-code',
    providerSessionId: over.id,
    cwd: '/repo',
    status: 'ended',
    startedAt: '2026-08-01T00:00:00.000Z',
    lastEventAt: '2026-08-01T00:00:00.000Z',
    latestSeq: 1,
    counts: {
      turns: 1,
      toolCalls: 0,
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      reviewOpen: 0,
      remaining: 0,
    },
    ...over,
  } as unknown as SessionSummary;
}

/** `n` user sessions, oldest first, so `old-0` is the one furthest outside any page. */
function fill(n: number, over: (i: number) => Partial<SessionSummary> = () => ({})): void {
  for (let i = 0; i < n; i++)
    store.upsertSession(
      summary({
        id: `s${i}`,
        lastEventAt: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
        ...over(i),
      }),
    );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'salidium-search-'));
  store = new SqliteStore(join(dir, 'test.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('searchSessions', () => {
  it('reaches a session far outside the page the list would have been served', () => {
    fill(50);
    store.upsertSession(
      summary({
        id: 'ancient',
        title: 'the codex adapter',
        lastEventAt: '2026-07-01T00:00:00.000Z',
      }),
    );

    // The page is the newest 10, and `ancient` is the oldest row in the store.
    expect(store.listSessions(10).some((s) => s.id === 'ancient')).toBe(false);
    const found = store.searchSessions(['codex'], 10);
    expect(found.sessions.map((s) => s.id)).toEqual(['ancient']);
    expect(found.matched).toBe(1);
    expect(found.total).toBe(51);
  });

  it('applies the limit to the matched set and says how many it left behind', () => {
    fill(40, (i) => ({ title: i % 2 === 0 ? 'build the daemon' : 'read the transcript' }));
    const r = store.searchSessions(['daemon'], 5);
    expect(r.sessions).toHaveLength(5);
    expect(r.matched).toBe(20);
    expect(r.total).toBe(40);
    // The newest of the matches, not the newest five rows filtered afterwards.
    expect(r.sessions.map((s) => s.id)).toEqual(['s38', 's36', 's34', 's32', 's30']);
  });

  it('counts what it searched even when it is asked for no rows at all', () => {
    fill(12, (i) => ({ title: i < 3 ? 'the daemon' : 'something else' }));
    const r = store.searchSessions(['daemon'], 0);
    expect(r.sessions).toEqual([]);
    expect(r.matched).toBe(3);
    expect(r.total).toBe(12);
  });

  it('excludes Salidium’s own runs by the flag and by the title, and counts neither', () => {
    store.upsertSession(summary({ id: 'mine', title: 'ship the search' }));
    store.upsertSession(summary({ id: 'flagged', title: 'ship the search', internal: true }));
    // A summary persisted before its first turn arrived carries the marker but not yet the flag.
    store.upsertSession(
      summary({ id: 'unflagged', title: '[salidium-explainer] ship the search' }),
    );

    const r = store.searchSessions(['ship'], 500);
    expect(r.sessions.map((s) => s.id)).toEqual(['mine']);
    expect(r.matched).toBe(1);
    expect(r.total).toBe(1);
    expect(store.searchSessions([], 500).total).toBe(1);
    expect(store.listSessions(500).map((s) => s.id)).toEqual(['mine']);
  });

  it('needs every word, so a second one narrows', () => {
    store.upsertSession(summary({ id: 'a', title: 'sample-app eval harness' }));
    store.upsertSession(summary({ id: 'b', title: 'sample-app ingest' }));
    expect(store.searchSessions(['sample-app'], 500).matched).toBe(2);
    expect(store.searchSessions(['sample-app', 'eval'], 500).matched).toBe(1);
    expect(store.searchSessions(['sample-app', 'missing'], 500).matched).toBe(0);
  });

  it('reads the name, the repo, the path and the provider session id', () => {
    store.upsertSession(
      summary({
        id: 'claude-code:c3eda8d6',
        providerSessionId: 'c3eda8d6',
        cwd: '/Users/x/dev/sample-app/api',
        repoRoot: '/Users/x/dev/sample-app',
        title: undefined,
      }),
    );
    for (const term of ['c3eda8d6', 'sample-app', '/api'])
      expect(store.searchSessions([term], 500).matched).toBe(1);
  });

  it('treats a term as literal text, not as a LIKE pattern', () => {
    store.upsertSession(summary({ id: 'a', title: 'ease the edge' }));
    store.upsertSession(summary({ id: 'b', title: 'e_e' }));
    // `_` and `%` are LIKE wildcards; `e_e` would match "ease the edge" under LIKE and does not
    // match it in the browser, where a match has always been String.includes.
    expect(store.searchSessions(['e_e'], 500).sessions.map((s) => s.id)).toEqual(['b']);
    expect(store.searchSessions(['%'], 500).matched).toBe(0);
  });

  it('matches without regard to case, on the term the caller lowercased', () => {
    store.upsertSession(summary({ id: 'a', title: 'The Codex Adapter' }));
    expect(store.searchSessions(['codex'], 500).matched).toBe(1);
    expect(store.searchSessions(['CODEX'.toLowerCase()], 500).matched).toBe(1);
  });

  it('orders by last activity and breaks ties, so the page boundary is stable', () => {
    // Several sessions can share one timestamp, so the secondary order is part of the contract.
    for (const id of ['d', 'c', 'b', 'a'])
      store.upsertSession(summary({ id, lastEventAt: '2026-08-10T00:00:00.000Z' }));
    store.upsertSession(summary({ id: 'newest', lastEventAt: '2026-08-11T00:00:00.000Z' }));
    const once = store.searchSessions([], 500).sessions.map((s) => s.id);
    expect(once).toEqual(['newest', 'd', 'c', 'b', 'a']);
    expect(store.searchSessions([], 500).sessions.map((s) => s.id)).toEqual(once);
    expect(store.searchSessions([], 2).sessions.map((s) => s.id)).toEqual(['newest', 'd']);
  });

  it('falls back to the start time for a session that never recorded an event', () => {
    store.upsertSession(
      summary({
        id: 'started-only',
        lastEventAt: undefined,
        startedAt: '2026-08-20T00:00:00.000Z',
      }),
    );
    store.upsertSession(summary({ id: 'older', lastEventAt: '2026-08-19T00:00:00.000Z' }));
    expect(store.searchSessions([], 500).sessions.map((s) => s.id)).toEqual([
      'started-only',
      'older',
    ]);
  });
});
