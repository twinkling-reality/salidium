import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { OPENCODE_EXTRA_STORES_ENV } from '@salidium/adapter-opencode';
import {
  SyntheticOpenCodeStore,
  stepData,
  T0,
  tools,
  userData,
} from '@salidium/adapter-opencode/testing';
import { SessionLookupSchema } from '@salidium/consumer-contract';
import type { StoredEvent } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConsumerCredential } from '../consumer/credentials.ts';
import { type DaemonHandle, startDaemon } from '../daemon.ts';

/*
 * Several OpenCode stores in one daemon: the person's own, plus the per-task sandbox stores a
 * local tool names in SALIDIUM_EXTRA_OPENCODE_STORES. Each is polled on its own; a session in any
 * of them answers a consumer v1 lookup by OpenCode's own session id.
 */

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'salidium-opencode-stores-daemon-')));
const userHome = join(tmp, 'home');
const salidiumHome = join(tmp, 'salidium');
const xdg = join(tmp, 'xdg-data');
const PROJECT = join(userHome, 'project');
const sandbox = (key: string) =>
  join(tmp, 'tool', `opencode-sandbox-${key}`, 'data', 'opencode', 'opencode.db');
const previous = {
  xdg: process.env.XDG_DATA_HOME,
  explainer: process.env.SALIDIUM_EXPLAINER,
  extra: process.env[OPENCODE_EXTRA_STORES_ENV],
};
const stores: SyntheticOpenCodeStore[] = [];
let daemon: DaemonHandle | undefined;

function makeStore(path: string, prompt: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const store = new SyntheticOpenCodeStore(path);
  stores.push(store);
  const id = store.session({ directory: PROJECT, timeCreated: T0 });
  store.message(id, 'user', userData(prompt, T0 + 10));
  store.message(
    id,
    'assistant',
    stepData(T0 + 20, [tools.edit('call_e1', T0 + 21, `${PROJECT}/math.js`, 'math.js')], {
      finish: 'stop',
    }),
  );
  return id;
}

async function api<T>(path: string, token = daemon?.token): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${daemon?.port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function events(nativeId: string): Promise<StoredEvent[]> {
  const { body } = await api<StoredEvent[] | { error: string }>(
    `/api/sessions/${encodeURIComponent(`salidium/opencode:${nativeId}`)}/events?after=-1&limit=1000`,
  );
  return Array.isArray(body) ? body : [];
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting');
    await sleep(50);
  }
}

const ids: Record<string, string> = {};

beforeAll(() => {
  process.env.XDG_DATA_HOME = xdg;
  process.env.SALIDIUM_EXPLAINER = 'off';
  mkdirSync(PROJECT, { recursive: true });
  ids.own = makeStore(join(xdg, 'opencode', 'opencode.db'), 'own store prompt');
  ids.shared = makeStore(
    join(tmp, 'tool', 'opencode-sandbox', 'data', 'opencode', 'opencode.db'),
    'shared sandbox prompt',
  );
  ids.first = makeStore(sandbox('0123456789abcdef'), 'first sandbox prompt');
  // A store this version cannot read backs off alone and holds back no other store.
  const broken = sandbox('00000000000000aa');
  mkdirSync(dirname(broken), { recursive: true });
  writeFileSync(broken, 'not a database');
  process.env[OPENCODE_EXTRA_STORES_ENV] = [
    join(tmp, 'tool', 'opencode-sandbox', 'data', 'opencode', 'opencode.db'),
    join(tmp, 'tool', 'opencode-sandbox-*', 'data', 'opencode', 'opencode.db'),
  ].join(':');
});

afterAll(async () => {
  await daemon?.stop();
  for (const store of stores) store.close();
  for (const [name, value] of [
    ['XDG_DATA_HOME', previous.xdg],
    ['SALIDIUM_EXPLAINER', previous.explainer],
    [OPENCODE_EXTRA_STORES_ENV, previous.extra],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('several OpenCode stores through the daemon', () => {
  it('reads the default store and every extra store, and one made while it runs', async () => {
    daemon = await startDaemon({
      home: salidiumHome,
      userHome,
      port: 0,
      providers: ['salidium/opencode'],
      gitEnrichment: false,
      historyDays: 36_500,
      logLevel: 'silent',
      alertSink: { publish: () => {} },
    });
    for (const [key, prompt] of [
      ['own', 'own store prompt'],
      ['shared', 'shared sandbox prompt'],
      ['first', 'first sandbox prompt'],
    ] as const) {
      const all = await waitFor(async () => {
        const found = await events(ids[key] ?? '');
        return found.length ? found : undefined;
      });
      expect(all.some((e) => e.kind === 'turn.started' && e.prompt === prompt)).toBe(true);
    }

    ids.second = makeStore(sandbox('fedcba9876543210'), 'second sandbox prompt');
    const later = await waitFor(async () => {
      const found = await events(ids.second ?? '');
      return found.length ? found : undefined;
    });
    expect(later.some((e) => e.kind === 'turn.started')).toBe(true);

    const { body: info } = await api<{
      providers: Array<{ id: string; sourcesWatched: number }>;
    }>('/api/info');
    expect(info.providers).toEqual([
      expect.objectContaining({ id: 'salidium/opencode', sourcesWatched: 4 }),
    ]);
  });

  it('opens raw evidence for a sandbox session from its own store', async () => {
    const edit = (await events(ids.first ?? '')).find((e) => e.kind === 'tool.completed');
    expect(edit?.source.ref?.path).toBe(sandbox('0123456789abcdef'));
    const { body } = await api<{ raw: { content: Array<{ name: string }> } | null }>(
      `/api/sessions/${encodeURIComponent(`salidium/opencode:${ids.first}`)}/raw/${encodeURIComponent(edit?.id ?? '')}`,
    );
    expect(body.raw?.content[0]?.name).toBe('edit');
  });

  it('answers a consumer v1 lookup for a sandbox session by its OpenCode session id', async () => {
    const { token } = createConsumerCredential(salidiumHome, 'local-tool-test');
    const { status, body } = await api<unknown>(
      `/consumer/v1/sessions/lookup?provider=${encodeURIComponent('salidium/opencode')}&sessionId=${encodeURIComponent(ids.second ?? '')}`,
      token,
    );
    expect(status).toBe(200);
    expect(SessionLookupSchema.parse(body).session).toMatchObject({
      id: `salidium/opencode:${ids.second}`,
    });
  });
});
