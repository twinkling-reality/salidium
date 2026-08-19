import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  DaemonInfo,
  SessionSnapshot,
  StoredEvent,
  StreamResnapshotRequired,
} from '@salidium/protocol';
import { StreamResnapshotRequiredSchema } from '@salidium/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookIngress } from '../ingest/hookIngress.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { createHttpServer, MAX_STREAM_REPLAY_EVENTS } from './httpServer.ts';

const TOKEN = 'testtoken';
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

function snapshot(latestSeq: number): SessionSnapshot {
  return {
    summary: {
      id: 'codex:s1',
      provider: 'codex',
      providerSessionId: 's1',
      cwd: '/repo',
      status: 'working',
      latestSeq,
      counts: {
        turns: 0,
        toolCalls: 0,
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        reviewOpen: 0,
        remaining: 0,
      },
    },
    state: { latestSeq },
    reducerVersion: 'test',
    seq: latestSeq,
    changes: [],
  };
}

async function fixture(registry: Partial<SessionRegistry>): Promise<string> {
  let server: Server;
  server = createHttpServer({
    registry: registry as SessionRegistry,
    hooks: { handle: () => 0 } as unknown as HookIngress,
    token: TOKEN,
    port: () => (server.address() as AddressInfo).port,
    info: () => ({}) as DaemonInfo,
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function streamRefusal(
  base: string,
  after: number,
): Promise<{ status: number; contentType: string | null; body: StreamResnapshotRequired }> {
  const response = await fetch(
    `${base}/api/sessions/${encodeURIComponent('codex:s1')}/stream?after=${after}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: StreamResnapshotRequiredSchema.parse(await response.json()),
  };
}

describe('session stream replay safety', () => {
  it('pushes sessionRemoved on the live summary stream', async () => {
    let remove: ((sessionId: string) => void) | undefined;
    const base = await fixture({
      listSessions: () => [],
      subscribeSummaries: () => () => {},
      subscribeRemovals: (subscriber) => {
        remove = subscriber;
        return () => {};
      },
    });
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const initial = await reader?.read();
    expect(initial?.value?.byteLength).toBeGreaterThanOrEqual(2048); // primes WebKit streaming
    remove?.('codex:expired');
    const chunk = await reader?.read();
    controller.abort();
    expect(new TextDecoder().decode(chunk?.value)).toContain(
      '"type":"sessionRemoved","id":"codex:expired"',
    );
  });

  it('returns a typed 409 before SSE when the backlog exceeds the replay window', async () => {
    const latestSeq = MAX_STREAM_REPLAY_EVENTS + 8;
    const events = Array.from(
      { length: MAX_STREAM_REPLAY_EVENTS + 1 },
      (_, seq) => ({ seq }) as StoredEvent,
    );
    const unsubscribe = vi.fn();
    const base = await fixture({
      snapshot: () => snapshot(latestSeq),
      subscribe: () => unsubscribe,
      eventsAfter: () => events,
    });

    const result = await streamRefusal(base, -1);
    expect(result.status).toBe(409);
    expect(result.contentType).toContain('application/json');
    expect(result.contentType).not.toContain('text/event-stream');
    expect(result.body).toEqual({
      error: 'resnapshot-required',
      reason: 'backlog-exceeded',
      sessionId: 'codex:s1',
      after: -1,
      latestSeq,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('refuses a missing persisted sequence and a cursor ahead of the store', async () => {
    const unsubscribe = vi.fn();
    const base = await fixture({
      snapshot: () => snapshot(12),
      subscribe: () => unsubscribe,
      eventsAfter: (_id, after) =>
        after === 10 ? ([{ seq: 12 }] as StoredEvent[]) : ([] as StoredEvent[]),
    });

    expect((await streamRefusal(base, 10)).body.reason).toBe('history-gap');
    expect((await streamRefusal(base, 99)).body.reason).toBe('cursor-ahead');
  });

  it('rejects noncanonical time scrubs before asking the registry to replay', async () => {
    const stateAtTime = vi.fn(() => ({ state: { latestSeq: 3 } }));
    const base = await fixture({ stateAtTime });
    for (const atTime of ['2026-08-19T12:34:56Z', '2026-08-19T08:34:56.000-04:00', 'not-a-time']) {
      const response = await fetch(
        `${base}/api/sessions/${encodeURIComponent('codex:s1')}/state?atTime=${encodeURIComponent(atTime)}`,
        { headers: { Authorization: `Bearer ${TOKEN}` } },
      );
      expect(response.status, atTime).toBe(400);
    }
    expect(stateAtTime).not.toHaveBeenCalled();

    const canonical = '2026-08-19T12:34:56.000Z';
    const response = await fetch(
      `${base}/api/sessions/${encodeURIComponent('codex:s1')}/state?atTime=${encodeURIComponent(canonical)}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(response.status).toBe(200);
    expect(stateAtTime).toHaveBeenCalledWith('codex:s1', canonical);
  });
});
