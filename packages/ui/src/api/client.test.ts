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
