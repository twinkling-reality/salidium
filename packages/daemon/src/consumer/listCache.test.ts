import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SessionList, SessionListSchema } from '@salidium/consumer-contract';
import type { SessionSummary } from '@salidium/protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsumerCredentialVerifier, createConsumerCredential } from './credentials.ts';
import { toSessionEntry } from './report.ts';
import { createConsumerRoutes } from './routes.ts';

vi.mock('./report.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./report.ts')>();
  return { ...actual, toSessionEntry: vi.fn(actual.toSessionEntry) };
});

/**
 * A list builds and checks an entry for every stored session, so each one is remembered until its
 * summary changes. What is counted here is how many entries a list had to build.
 */
const built = vi.mocked(toSessionEntry);
const T0 = Date.parse('2026-09-20T16:00:00.000Z');
let clock = T0;
let summaries: SessionSummary[] = [];
let home: string;
let token: string;
let server: Server;
let routes: ReturnType<typeof createConsumerRoutes>;

function summary(n: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: `claude-code:s${n}`,
    provider: 'claude-code',
    providerSessionId: `s${n}`,
    cwd: '/repo',
    title: `Session ${n}`,
    titleSource: 'provider',
    status: 'ended',
    startedAt: new Date(T0 - 60_000).toISOString(),
    lastEventAt: new Date(T0 - 60_000).toISOString(),
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
    ...overrides,
  } as unknown as SessionSummary;
}

async function list(): Promise<SessionList> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/consumer/v1/sessions?limit=2000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return SessionListSchema.parse(await response.json());
}

/** How many entries one list built. */
async function rebuilt(): Promise<{ count: number; body: SessionList }> {
  const before = built.mock.calls.length;
  const body = await list();
  return { count: built.mock.calls.length - before, body };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'salidium-consumer-cache-'));
  token = createConsumerCredential(home, 'cache test').token;
  routes = createConsumerRoutes({
    registry: {
      listSessions: () => summaries,
      subscribeSummaries: () => () => {},
      subscribeRemovals: () => () => {},
    } as never,
    credentials: new ConsumerCredentialVerifier(home),
    discovery: () => ({}) as never,
    now: () => clock,
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  });
  server = createServer((req, res) =>
    routes.handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1')),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  routes.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  clock = T0;
  summaries = Array.from({ length: 50 }, (_, n) => summary(n));
  await list();
});

describe('the list entry cache', () => {
  it('does not rebuild an entry whose session has not changed', async () => {
    const { count, body } = await rebuilt();
    expect(count).toBe(0);
    expect(body.total).toBe(50);
  });

  it('rebuilds only the session with new evidence', async () => {
    summaries[7] = summary(7, { latestSeq: 2, counts: { ...summaries[7].counts, turns: 2 } });
    const { count, body } = await rebuilt();
    expect(count).toBe(1);
    expect(body.sessions.find((s) => s.id === 'claude-code:s7')?.evidenceSeq).toBe(2);
  });

  it('rebuilds a session whose explanation finished with no new evidence', async () => {
    summaries[3] = summary(3, { explanationStatus: 'generating' });
    expect((await rebuilt()).count).toBe(1);
    summaries[3] = summary(3, { explanationStatus: 'generated' });
    const { count, body } = await rebuilt();
    expect(count).toBe(1);
    expect(body.sessions.find((s) => s.id === 'claude-code:s3')?.explanation).toBe('generated');
  });

  it('rebuilds a working session that has gone quiet long enough to read as idle', async () => {
    summaries[5] = summary(5, { status: 'working', lastEventAt: new Date(T0).toISOString() });
    expect((await rebuilt()).count).toBe(1);
    expect((await rebuilt()).count).toBe(0);
    clock = T0 + 60 * 60_000;
    const { count, body } = await rebuilt();
    expect(count).toBe(1);
    expect(body.sessions.find((s) => s.id === 'claude-code:s5')?.status).toBe('idle');
  });

  it('remembers a session it cannot carry too, without listing it', async () => {
    summaries.push(summary(99, { cwd: `/${'d'.repeat(5000)}` }));
    const first = await rebuilt();
    expect(first.count).toBe(1);
    expect(first.body.total).toBe(50);
    expect((await rebuilt()).count).toBe(0);
  });

  it('forgets a session that is no longer stored', async () => {
    const removed = summaries.splice(9, 1);
    expect((await rebuilt()).count).toBe(0);
    summaries.push(...removed);
    expect((await rebuilt()).count).toBe(1);
  });
});
