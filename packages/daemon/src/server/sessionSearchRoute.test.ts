import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonInfo, SessionList, SessionSummary } from '@salidium/protocol';
import { SessionListSchema } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HookIngress } from '../ingest/hookIngress.ts';
import { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { createHttpServer } from './httpServer.ts';

/**
 * The route is where the search stops being an internal call and becomes something a reader's
 * browser depends on, so this covers the two things that only exist at that boundary: the envelope
 * a stale response can be recognised by, and a `limit` that arrived as text.
 */
const TOKEN = 'testtoken';
let dir: string;
let store: SqliteStore;
let registry: SessionRegistry;
let server: Server;
let base: string;

function summary(id: string, title: string, minute: number): SessionSummary {
  return {
    id,
    provider: 'claude-code',
    providerSessionId: id,
    cwd: '/repo',
    title,
    status: 'ended',
    startedAt: new Date(Date.UTC(2026, 7, 1, 0, minute)).toISOString(),
    lastEventAt: new Date(Date.UTC(2026, 7, 1, 0, minute)).toISOString(),
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
  } as unknown as SessionSummary;
}

async function search(query: string): Promise<SessionList> {
  const res = await fetch(`${base}/api/sessions/search?${query}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  return SessionListSchema.parse(await res.json());
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'salidium-route-'));
  store = new SqliteStore(join(dir, 'test.db'));
  for (let i = 0; i < 30; i++) store.upsertSession(summary(`s${i}`, `run the daemon ${i}`, i));
  store.upsertSession(summary('ancient', 'the codex adapter', -600));
  registry = new SessionRegistry(store);
  server = createHttpServer({
    registry,
    hooks: { handle: () => 0 } as unknown as HookIngress,
    token: TOKEN,
    port: () => (server.address() as AddressInfo).port,
    info: () => ({}) as unknown as DaemonInfo,
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  registry.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/sessions/search', () => {
  it('finds a session the page it was serving would never have held', async () => {
    expect(store.listSessions(5).some((s) => s.id === 'ancient')).toBe(false);

    const r = await search('q=codex&limit=5');
    expect(r.sessions.map((s) => s.id)).toEqual(['ancient']);
    expect(r.matched).toBe(1);
    expect(r.total).toBe(31);
    // Echoed, so a response that arrives after newer typing can be recognised and dropped.
    expect(r.query).toBe('codex');
  });

  it('caps the rows without capping the count', async () => {
    const r = await search('q=daemon&limit=5');
    expect(r.sessions).toHaveLength(5);
    expect(r.matched).toBe(30);
    expect(r.total).toBe(31);
  });

  it('answers a request for the counts alone', async () => {
    const r = await search('limit=0');
    expect(r.sessions).toEqual([]);
    expect(r.matched).toBe(31);
    expect(r.total).toBe(31);
    expect(r.query).toBe('');
  });

  it('does not let a limit that is not a number reach the query', async () => {
    // `Math.min(Number('soon'), 20000)` is NaN, and NaN reaching a SQL LIMIT returns nothing.
    for (const limit of ['soon', '', 'Infinity', '-4'])
      expect((await search(`q=daemon&limit=${limit}`)).matched).toBe(30);
    expect((await search('q=daemon&limit=soon')).sessions.length).toBeGreaterThan(0);
    expect((await search('q=daemon&limit=-4')).sessions).toEqual([]);
  });

  it('is a route of its own, not a session called "search"', async () => {
    const res = await fetch(`${base}/api/sessions/search/snapshot`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('needs the token, like every other API route', async () => {
    expect((await fetch(`${base}/api/sessions/search?q=codex`)).status).toBe(401);
  });
});
