import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonInfo, ExplainerSettings } from '@salidium/protocol';
import { ExplainerSettingsSchema } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSettings, writeSettings } from '../daemon.ts';
import type { HookIngress } from '../ingest/hookIngress.ts';
import { effectiveCadence } from '../sessions/sessionCoordinator.ts';
import { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { createHttpServer } from './httpServer.ts';

/**
 * Where the stop stops being a preference and becomes something the daemon schedules from: the
 * route, the file it is written to, and the registry it is pushed into. Wired the same way
 * `startDaemon` wires it, so a change that breaks the daemon breaks this.
 */
const TOKEN = 'testtoken';
let dir: string;
let store: SqliteStore;
let registry: SessionRegistry;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'salidium-settings-route-'));
  store = new SqliteStore(join(dir, 'test.db'));
  const stored = readSettings(dir);
  registry = new SessionRegistry(store, {
    explainerCadence: effectiveCadence(stored.explainerCadence, {}),
  });
  const answer = (): ExplainerSettings => {
    const usage = registry.explainerUsage();
    return {
      cadence: stored.explainerCadence,
      backend: stored.explainerBackend,
      model: stored.explainerModel,
      envOff: false,
      backendLocked: false,
      modelLocked: false,
      activeBackend: stored.explainerBackend,
      activeModel: stored.explainerModel,
      availableBackends: [],
      routes: {
        claudeCode: { backend: null, model: null },
        codex: { backend: null, model: null },
      },
      ...(usage ? { usage } : {}),
    };
  };
  server = createHttpServer({
    registry,
    hooks: { handle: () => 0 } as unknown as HookIngress,
    token: TOKEN,
    port: () => (server.address() as AddressInfo).port,
    info: () => ({}) as DaemonInfo,
    settings: {
      explainer: answer,
      setExplainerSettings: (change) => {
        if (change.cadence !== undefined) stored.explainerCadence = change.cadence;
        if (change.backend !== undefined) stored.explainerBackend = change.backend;
        if (change.model !== undefined) stored.explainerModel = change.model;
        writeSettings(dir, stored);
        registry.setExplainerCadence(effectiveCadence(stored.explainerCadence, {}));
        return answer();
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

function call(method: string, body?: unknown): Promise<Response> {
  return fetch(`${base}/api/settings/explainer`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('the explainer settings route', () => {
  it('starts at the stop that shipped, and says nothing about usage it has not observed', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    const settings = ExplainerSettingsSchema.parse(await res.json());
    expect(settings.cadence).toBe('turn');
    expect(settings.backend).toBe('auto');
    expect(settings.routes.codex.model).toBeNull();
    expect(settings.envOff).toBe(false);
    // Omitted, not zeroed: an empty section is left out rather than printed as a row of noughts.
    expect(settings.usage).toBeUndefined();
  });

  it('takes a stop, answers with what it now holds, and writes it 0600', async () => {
    const res = await call('PUT', { cadence: 'session' });
    expect(res.status).toBe(200);
    expect(ExplainerSettingsSchema.parse(await res.json()).cadence).toBe('session');
    const path = join(dir, 'settings.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      explainerCadence: 'session',
      explainerBackend: 'auto',
      explainerModel: null,
    });
    // The file sits beside the token; it is written with the same permissions as everything else
    // under the home directory.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('survives a restart, which is the whole reason it is a file', () => {
    expect(readSettings(dir).explainerCadence).toBe('session');
  });

  it('updates the helper and model without restarting the daemon', async () => {
    const res = await call('PUT', { backend: 'codex', model: 'gpt-5.6-luna' });
    expect(res.status).toBe(200);
    const settings = ExplainerSettingsSchema.parse(await res.json());
    expect(settings.backend).toBe('codex');
    expect(settings.model).toBe('gpt-5.6-luna');
    expect(readSettings(dir)).toMatchObject({
      explainerBackend: 'codex',
      explainerModel: 'gpt-5.6-luna',
    });
  });

  it('refuses a stop it does not know rather than storing it', async () => {
    const res = await call('PUT', { cadence: 'occasionally' });
    expect(res.status).toBe(400);
    expect(readSettings(dir).explainerCadence).toBe('session');
  });

  it('refuses a body that is not JSON', async () => {
    const res = await fetch(`${base}/api/settings/explainer`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('needs the token like every other API route', async () => {
    const res = await fetch(`${base}/api/settings/explainer`);
    expect(res.status).toBe(401);
  });

  it('uses the shipped stop when settings are missing and fails closed when they are invalid', () => {
    const empty = mkdtempSync(join(tmpdir(), 'salidium-settings-missing-'));
    expect(readSettings(empty).explainerCadence).toBe('turn');
    writeSettings(empty, {
      explainerCadence: 'off',
      explainerBackend: 'auto',
      explainerModel: null,
    });
    expect(readSettings(empty).explainerCadence).toBe('off');
    expect(readdirSync(empty).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    writeFileSync(join(empty, 'settings.json'), '{not-json');
    const warnings: string[] = [];
    expect(readSettings(empty, (reason) => warnings.push(reason)).explainerCadence).toBe('off');
    expect(warnings).toHaveLength(1);
    rmSync(empty, { recursive: true, force: true });
  });
});
