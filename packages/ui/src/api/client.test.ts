import type { StreamResnapshotRequired } from '@salidium/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ApiClient.stream', () => {
  it('recognizes the typed pre-SSE refusal and asks its owner for a fresh snapshot', async () => {
    const refusal: StreamResnapshotRequired = {
      error: 'resnapshot-required',
      reason: 'backlog-exceeded',
      sessionId: 'codex:s1',
      after: 4,
      latestSeq: 50_005,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(refusal), { status: 409 })),
    );
    const client = new ApiClient('token');
    const states: string[] = [];
    await new Promise<void>((resolve) => {
      client.stream(
        '/api/sessions/codex%3As1/stream?after=4',
        () => undefined,
        (status) => states.push(status),
        resolve,
      );
    });

    expect(states).toEqual(['connecting', 'closed']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('resolves the stream URL again with the newest received cursor on reconnect', async () => {
    vi.useFakeTimers();
    const paths: string[] = [];
    let resolveFirstMessage = () => undefined;
    const firstMessage = new Promise<void>((resolve) => {
      resolveFirstMessage = resolve;
    });
    let resolveSecondFetch = () => undefined;
    const secondFetch = new Promise<void>((resolve) => {
      resolveSecondFetch = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
        paths.push(String(path));
        if (paths.length === 1) {
          const event = {
            type: 'event',
            event: {
              id: 'codex:s1#notice',
              sessionId: 'codex:s1',
              seq: 5,
              ts: '2026-08-19T12:34:56.000Z',
              tsSource: 'ingest',
              source: { provider: 'codex', channel: 'salidium' },
              kind: 'notification',
              message: 'hello',
            },
          };
          return new Response(`data: ${JSON.stringify(event)}\n\n`, { status: 200 });
        }
        resolveSecondFetch();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted')));
        });
      }),
    );
    const client = new ApiClient('token');
    let after = 4;
    const stop = client.stream(
      () => `/api/sessions/codex%3As1/stream?after=${after}`,
      (message) => {
        if (message.type === 'event') after = message.event.seq;
        resolveFirstMessage();
      },
      () => undefined,
    );

    await firstMessage;
    await vi.advanceTimersByTimeAsync(1000);
    await secondFetch;
    expect(paths).toEqual([
      '/api/sessions/codex%3As1/stream?after=4',
      '/api/sessions/codex%3As1/stream?after=5',
    ]);
    stop();
  });
});

describe('ApiClient.sessionLinks', () => {
  const links = {
    format: 'salidium.execution-links',
    version: 0,
    experimental: true,
    generatedAt: '2026-10-02T12:00:00.000Z',
    sessionId: 'codex:s1',
    anchors: { repository: null, atStart: null, atLatestTurnEnd: null },
    repositories: [],
    files: [],
    filesTotal: 0,
    filesOmitted: 0,
    modules: [],
    modulesTruncated: false,
  };

  it('reads the owner route with the owner token and an encoded session id', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
        calls.push([String(path), init]);
        return new Response(JSON.stringify(links), { status: 200 });
      }),
    );
    expect(await new ApiClient('token').sessionLinks('codex:s1')).toEqual(links);
    expect(calls[0]?.[0]).toBe('/api/sessions/codex%3As1/links');
    expect(calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('refuses a document of another shape rather than half-reading it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...links, version: 1 }), { status: 200 })),
    );
    await expect(new ApiClient('token').sessionLinks('codex:s1')).rejects.toThrow();
  });
});
