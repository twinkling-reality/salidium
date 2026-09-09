import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonInfo, StorageComposition } from '@salidium/protocol';
import { OPERATIONS_CONTRACT_VERSION, StorageCompositionSchema } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HookIngress } from '../ingest/hookIngress.ts';
import { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { createHttpServer } from './httpServer.ts';

/*
 * The measurement takes about ten seconds on a real store, so the route cannot answer with it: it
 * has to hand back what it already knows and let the caller ask for a new one. This pins that
 * shape, which is the whole contract the panel polls against.
 */
const TOKEN = 'testtoken';
let dir: string;
let store: SqliteStore;
let registry: SessionRegistry;
let server: Server;
let base: string;
let composition: StorageComposition;
let analyzeCalls = 0;

const absent = (): StorageComposition => ({
  contractVersion: OPERATIONS_CONTRACT_VERSION,
  state: 'absent',
  computedAt: null,
  elapsedMs: null,
  fileBytes: null,
  sessions: null,
  parts: [],
  projects: [],
  projectsOmitted: 0,
  failure: null,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'salidium-composition-route-'));
  store = new SqliteStore(join(dir, 'test.db'));
  registry = new SessionRegistry(store, {});
  composition = absent();
  const unused = () => {
    throw new Error('not part of this route');
  };
  server = createHttpServer({
    registry,
    hooks: { handle: () => 0 } as unknown as HookIngress,
    token: TOKEN,
    port: () => (server.address() as AddressInfo).port,
    info: () => ({}) as DaemonInfo,
    operations: {
      overview: unused as never,
      setConfig: unused as never,
      resetConfig: unused as never,
      inspectQueue: unused as never,
      drainQueue: unused as never,
      acknowledgeAlert: unused as never,
      storageComposition: () => composition,
      analyzeStorage: () => {
        analyzeCalls += 1;
        composition = { ...composition, state: 'running' };
        return composition;
      },
    },
    log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(method: string, token = TOKEN): Promise<Response> {
  return fetch(`${base}/api/operations/storage`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('the storage composition route', () => {
  it('says it has never measured rather than reporting a store of no size', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    const body = StorageCompositionSchema.parse(await res.json());
    expect(body.state).toBe('absent');
    // Null, not zero. A store that has not been measured is not a store that is empty.
    expect(body.fileBytes).toBeNull();
    expect(body.parts).toEqual([]);
  });

  it('starts the measurement and answers immediately, so the caller can poll', async () => {
    const res = await call('POST');
    expect(res.status).toBe(200);
    expect(StorageCompositionSchema.parse(await res.json()).state).toBe('running');
    expect(analyzeCalls).toBe(1);
    expect(StorageCompositionSchema.parse(await (await call('GET')).json()).state).toBe('running');
  });

  it('hands back a finished measurement whose parts add up to the file', async () => {
    composition = {
      ...absent(),
      state: 'ready',
      computedAt: '2026-09-09T16:00:00.000Z',
      elapsedMs: 9945,
      fileBytes: 1000,
      sessions: 2,
      parts: [
        { key: 'sessions', bytes: 500 },
        { key: 'checkpoints', bytes: 200 },
        { key: 'provenance', bytes: 100 },
        { key: 'structure', bytes: 200 },
        { key: 'reusable', bytes: 0 },
      ],
      projects: [{ path: '/repo/alpha', sessions: 2, bytes: 700 }],
      projectsOmitted: 4,
    };
    const body = StorageCompositionSchema.parse(await (await call('GET')).json());
    expect(body.state).toBe('ready');
    expect(body.parts.reduce((total, part) => total + part.bytes, 0)).toBe(body.fileBytes);
    expect(body.projectsOmitted).toBe(4);
  });

  it('refuses a method it does not implement, and a caller without the token', async () => {
    expect((await call('DELETE')).status).toBe(405);
    expect((await call('GET', 'wrong')).status).toBe(401);
  });
});
