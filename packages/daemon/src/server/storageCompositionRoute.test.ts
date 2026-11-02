import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectionStatus, DaemonInfo, StorageComposition } from '@salidium/protocol';
import {
  OPERATIONS_CONTRACT_VERSION,
  StorageCompactResultSchema,
  StorageCompositionSchema,
  StorageDeletionPreviewSchema,
  StorageDeletionResultSchema,
} from '@salidium/protocol';
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
let connectedProvider: string | undefined;
let allowedRepository: string | undefined;

const sampleCollectionStatus = (): CollectionStatus => ({
  observedAt: '2026-10-01T00:00:00.000Z',
  state: 'active',
  pause: null,
  queue: { files: 0, bytes: 0, oldestAt: null },
  store: { bytes: 1000, retention: 'forever', lastIngestAt: null },
  health: 'healthy',
  gaps: { active: [], recovered: [], omittedEpisodes: 0 },
});

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
      previewStorageDeletion: (scope) => registry.previewDeletion(scope),
      deleteStorage: (scope, expectedSessions) => registry.deleteSessions(scope, expectedSessions),
      compactStorage: async () => {
        const compacted = store.compact();
        return {
          contractVersion: OPERATIONS_CONTRACT_VERSION,
          beforeBytes: compacted.beforeBytes,
          afterBytes: compacted.afterBytes,
        };
      },
    },
    collection: {
      status: () => sampleCollectionStatus(),
      set: () => sampleCollectionStatus(),
      disconnect: () => sampleCollectionStatus(),
      connect: (provider) => {
        connectedProvider = provider;
        return sampleCollectionStatus();
      },
    },
    projectMapRepositories: {
      allow: async (root) => {
        allowedRepository = root;
        return { root, allowedAt: '2026-10-01T00:00:00.000Z', added: true };
      },
      revoke: async () => true,
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

  it('previews and deletes storage scopes, returning 409 when expectedSessions changes', async () => {
    store.upsertSession({
      id: 'codex:s1',
      provider: 'codex',
      providerSessionId: 's1',
      cwd: '/repo/alpha',
      title: 'codex:s1',
      status: 'ended',
      startedAt: '2026-09-01T00:00:00.000Z',
      lastEventAt: '2026-09-01T00:05:00.000Z',
      endedAt: '2026-09-01T00:05:00.000Z',
      latestSeq: 0,
      counts: {
        turns: 1,
        toolCalls: 0,
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        reviewOpen: 0,
        remaining: 0,
      },
    });
    const previewRes = await fetch(`${base}/api/operations/storage/preview`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: { kind: 'project', project: '/repo/alpha' } }),
    });
    expect(previewRes.status).toBe(200);
    const preview = StorageDeletionPreviewSchema.parse(await previewRes.json());
    expect(preview.sessions).toBe(1);

    const conflictRes = await fetch(`${base}/api/operations/storage/delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: { kind: 'project', project: '/repo/alpha' },
        expectedSessions: 5,
      }),
    });
    expect(conflictRes.status).toBe(409);

    const deleteRes = await fetch(`${base}/api/operations/storage/delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: { kind: 'project', project: '/repo/alpha' },
        expectedSessions: 1,
      }),
    });
    expect(deleteRes.status).toBe(200);
    const deleted = StorageDeletionResultSchema.parse(await deleteRes.json());
    expect(deleted.removedSessions).toBe(1);

    const compactRes = await fetch(`${base}/api/operations/storage/compact`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(compactRes.status).toBe(200);
    const compacted = StorageCompactResultSchema.parse(await compactRes.json());
    expect(compacted.beforeBytes).toBeGreaterThan(0);
    expect(compacted.afterBytes).toBeGreaterThan(0);
  });

  it('connects provider hooks and allows project-map repositories via owner routes', async () => {
    const hookRes = await fetch(`${base}/api/collection/hooks/claude-code`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(hookRes.status).toBe(200);
    expect(connectedProvider).toBe('claude-code');

    const mapRes = await fetch(`${base}/api/project-map/repositories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: '/repo/alpha' }),
    });
    expect(mapRes.status).toBe(200);
    expect(allowedRepository).toBe('/repo/alpha');
  });
});
