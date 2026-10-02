import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonInfo } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HookIngress } from '../ingest/hookIngress.ts';
import { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { createHttpServer } from './httpServer.ts';

/**
 * A path segment that is not valid percent-encoding is the caller's mistake. Every owner route that
 * decodes one answers 400 in the plain `{ error }` shape, and reaches nothing behind the decode.
 */
const TOKEN = 'testtoken';
const MALFORMED = ['%E0%A4%A', '%', 'claude-code%3A%ZZ'];
let dir: string;
let store: SqliteStore;
let registry: SessionRegistry;
let server: Server;
let base: string;
const acknowledgeAlert = vi.fn();
const disconnect = vi.fn();
const warn = vi.fn();

async function send(method: string, path: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'salidium-encoding-'));
  const ui = join(dir, 'ui');
  mkdirSync(ui);
  writeFileSync(join(ui, 'index.html'), '<!doctype html>');
  store = new SqliteStore(join(dir, 'test.db'));
  registry = new SessionRegistry(store);
  server = createHttpServer({
    registry,
    hooks: { handle: () => 0 } as unknown as HookIngress,
    token: TOKEN,
    port: () => (server.address() as AddressInfo).port,
    uiDist: ui,
    info: () => ({}) as unknown as DaemonInfo,
    collection: { status: vi.fn(), set: vi.fn(), disconnect } as never,
    operations: { acknowledgeAlert } as never,
    log: { info: () => {}, warn, debug: () => {} },
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

describe('malformed percent-encoding in an owner path', () => {
  const routes: [string, (segment: string) => string][] = [
    ['GET', (s) => `/api/sessions/${s}/snapshot`],
    ['GET', (s) => `/api/sessions/${s}/state`],
    ['GET', (s) => `/api/sessions/${s}/stream`],
    ['DELETE', (s) => `/api/sessions/${s}`],
    ['POST', (s) => `/api/sessions/${s}/personalized-presentation`],
    ['GET', (s) => `/api/sessions/claude-code%3Aknown/raw/${s}`],
    ['POST', (s) => `/api/operations/alerts/${s}/acknowledge`],
    ['DELETE', (s) => `/api/collection/hooks/${s}`],
    ['GET', (s) => `/assets/${s}.js`],
  ];

  for (const [method, path] of routes)
    it(`answers 400 for ${method} ${path(':segment')}`, async () => {
      for (const segment of MALFORMED) {
        const { status, body } = await send(method, path(segment));
        expect(status, segment).toBe(400);
        expect(body).toEqual({ error: 'invalid percent-encoding in path' });
      }
    });

  it('reaches no handler and logs no failure', () => {
    expect(acknowledgeAlert).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('still decodes a well-formed segment', async () => {
    disconnect.mockReturnValueOnce(undefined);
    expect((await send('DELETE', '/api/collection/hooks/claude%2Dcode')).status).toBe(404);
    expect(disconnect).toHaveBeenCalledWith('claude-code');
    disconnect.mockClear();
    expect((await send('GET', '/api/sessions/claude-code%3Anone/snapshot')).status).toBe(404);
  });
});
