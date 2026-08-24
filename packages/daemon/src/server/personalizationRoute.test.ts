import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonInfo, ExplainerSettings, PersonalizationSettings } from '@salidium/protocol';
import { PersonalizationSettingsSchema } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HookIngress } from '../ingest/hookIngress.ts';
import { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { createHttpServer } from './httpServer.ts';

const TOKEN = 'profile-token';
let directory: string;
let store: SqliteStore;
let registry: SessionRegistry;
let server: Server;
let base: string;
let profile: PersonalizationSettings;

const EMPTY: PersonalizationSettings = {
  version: 2,
  enabled: false,
  revision: 'none',
  profile: { guidance: '' },
};

const EXPLAINER: ExplainerSettings = {
  cadence: 'off',
  backend: 'auto',
  model: null,
  envOff: false,
  backendLocked: false,
  modelLocked: false,
  activeBackend: 'auto',
  activeModel: null,
  availableBackends: [],
  routes: {
    claudeCode: { backend: null, model: null },
    codex: { backend: null, model: null },
  },
};

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'salidium-personalization-route-'));
  store = new SqliteStore(join(directory, 'test.db'));
  registry = new SessionRegistry(store);
  profile = structuredClone(EMPTY);
  server = createHttpServer({
    registry,
    hooks: { handle: () => 0 } as unknown as HookIngress,
    token: TOKEN,
    port: () => (server.address() as AddressInfo).port,
    info: () => ({}) as DaemonInfo,
    settings: {
      explainer: () => EXPLAINER,
      setExplainerSettings: () => EXPLAINER,
      personalization: () => profile,
      setPersonalization: (request, expected) => {
        if (expected !== profile.revision) return 'conflict';
        profile = { version: 2, revision: 'revision-2', ...request };
        return profile;
      },
      deletePersonalization: (expected) => {
        if (expected !== profile.revision) return 'conflict';
        profile = structuredClone(EMPTY);
        return profile;
      },
      personalize: async () => ({ status: 'not-found' }),
    },
    log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  registry.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function call(method: string, body?: unknown, revision?: string): Promise<Response> {
  return fetch(`${base}/api/settings/personalization`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(revision ? { 'If-Match': revision } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('the personalization routes', () => {
  it('reads the local disabled default', async () => {
    const response = await call('GET');
    expect(response.status).toBe(200);
    expect(PersonalizationSettingsSchema.parse(await response.json())).toEqual(EMPTY);
  });

  it('requires the current revision and rejects stale tabs', async () => {
    const request = {
      enabled: true,
      profile: {
        guidance: 'I run payment operations. Use logistics examples. Call jobs workers.',
      },
    };
    expect((await call('PUT', request, 'stale')).status).toBe(409);
    const saved = await call('PUT', request, 'none');
    expect(saved.status).toBe(200);
    expect(PersonalizationSettingsSchema.parse(await saved.json()).enabled).toBe(true);
    expect((await call('PUT', request, 'none')).status).toBe(409);
  });

  it('deletes only against the current revision and needs authentication', async () => {
    expect((await call('DELETE', undefined, 'stale')).status).toBe(409);
    expect((await call('DELETE', undefined, 'revision-2')).status).toBe(200);
    expect(profile).toEqual(EMPTY);
    expect((await fetch(`${base}/api/settings/personalization`)).status).toBe(401);
  });

  it('maps a missing session to 404 on the explicit generation route', async () => {
    const response = await fetch(`${base}/api/sessions/missing/personalized-presentation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});
