import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonInfo } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HookIngress } from '../ingest/hookIngress.ts';
import { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { createHttpServer } from './httpServer.ts';

/**
 * A link on another site may open the interface shell, and nothing else. A browser marks that one
 * request as a cross-site top-level document navigation; every other cross-site request, and the
 * shell reached any other way across sites, is still refused before routing.
 */
const TOKEN = 'testtoken';
const SHELL = '<!doctype html><title>shell</title>';
const NAVIGATION = {
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
} as const;
let dir: string;
let store: SqliteStore;
let registry: SessionRegistry;
let server: Server;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'salidium-cross-site-'));
  const ui = join(dir, 'ui');
  mkdirSync(join(ui, 'assets'), { recursive: true });
  writeFileSync(join(ui, 'index.html'), SHELL);
  writeFileSync(join(ui, 'assets', 'app.js'), 'export {};');
  store = new SqliteStore(join(dir, 'test.db'));
  registry = new SessionRegistry(store);
  server = createHttpServer({
    registry,
    hooks: { handle: () => 0 } as unknown as HookIngress,
    token: TOKEN,
    port: () => (server.address() as AddressInfo).port,
    uiDist: ui,
    info: () => ({}) as unknown as DaemonInfo,
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  registry.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Raw node:http, because fetch writes its own Sec-Fetch-Mode and Host: a browser navigation can
 * only be described byte for byte.
 */
function send(path: string, headers: Record<string, string>, method = 'GET') {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('cross-site navigation to the interface shell', () => {
  it('serves the shell to a top-level document navigation from another site', async () => {
    const res = await send('/', NAVIGATION);
    expect(res.status).toBe(200);
    expect(res.body).toBe(SHELL);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    // The page that linked here keeps no handle on the window it opened.
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('still refuses every other cross-site request before routing', async () => {
    const refused: Array<[string, Record<string, string>, string?]> = [
      // The shell reached any other way: framed, fetched, or with a query.
      ['/', { ...NAVIGATION, 'Sec-Fetch-Dest': 'iframe' }],
      ['/', { ...NAVIGATION, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }],
      ['/', { ...NAVIGATION, 'Sec-Fetch-Mode': 'no-cors' }],
      ['/', { 'Sec-Fetch-Site': 'cross-site' }],
      ['/?view=session', NAVIGATION],
      ['/', NAVIGATION, 'HEAD'],
      // Another document path that would fall back to the shell, and an asset.
      ['/s/claude-code%3Aabc', NAVIGATION],
      ['/index.html', NAVIGATION],
      ['/assets/app.js', NAVIGATION],
      [
        '/assets/app.js',
        { ...NAVIGATION, 'Sec-Fetch-Dest': 'script', 'Sec-Fetch-Mode': 'no-cors' },
      ],
      // Every data route, even dressed as a navigation.
      ['/api/info', { ...NAVIGATION, Authorization: `Bearer ${TOKEN}` }],
      ['/api/sessions', NAVIGATION],
      ['/consumer/v1/discovery', NAVIGATION],
      ['/project-map/v0/discovery', NAVIGATION],
    ];
    for (const [path, headers, method] of refused) {
      const res = await send(path, headers, method);
      expect(res.status, `${method ?? 'GET'} ${path} ${JSON.stringify(headers)}`).toBe(403);
      expect(res.body).not.toContain('shell');
    }
    const hook = await send(
      '/hooks/claude-code',
      { ...NAVIGATION, Authorization: `Bearer ${TOKEN}` },
      'POST',
    );
    expect(hook.status).toBe(403);
  });

  it('keeps the Host and Origin rules in front of the navigation', async () => {
    const foreignOrigin = await send('/', { ...NAVIGATION, Origin: 'https://example.com' });
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.body).not.toContain('shell');
    const rebound = await send('/', { ...NAVIGATION, Host: `evil.example:${port}` });
    expect(rebound.status).toBe(421);
  });

  it('serves the shell to a same-origin or typed navigation exactly as before', async () => {
    for (const site of ['same-origin', 'none']) {
      const res = await send('/', { ...NAVIGATION, 'Sec-Fetch-Site': site });
      expect(res.status).toBe(200);
      expect(res.body).toBe(SHELL);
    }
    expect((await send('/s/claude-code%3Aabc', { 'Sec-Fetch-Site': 'same-origin' })).body).toBe(
      SHELL,
    );
  });
});
