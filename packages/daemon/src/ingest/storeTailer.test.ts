import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  idleData,
  SyntheticOpenCodeStore,
  stepData,
  T0,
  tools,
  userData,
} from '@salidium/adapter-opencode/testing';
import { SessionLookupSchema, SessionReportSchema } from '@salidium/consumer-contract';
import type { StoredEvent } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConsumerCredential } from '../consumer/credentials.ts';
import { type DaemonHandle, startDaemon } from '../daemon.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';

/*
 * The OpenCode provider end to end inside one daemon process: a synthetic OpenCode 2.0.18 store
 * under a scratch XDG_DATA_HOME, read through the restricted connection, persisted, reported, and
 * re-read for raw evidence. Explanations are off; nothing here starts OpenCode or a model.
 */

const tmp = mkdtempSync(join(tmpdir(), 'salidium-opencode-daemon-'));
const userHome = join(tmp, 'home');
const salidiumHome = join(tmp, 'salidium');
const xdg = join(tmp, 'xdg-data');
const storePath = join(xdg, 'opencode', 'opencode.db');
const PROJECT = join(userHome, 'project');
const previousXdg = process.env.XDG_DATA_HOME;
const previousExplainer = process.env.SALIDIUM_EXPLAINER;
let store: SyntheticOpenCodeStore;
let daemon: DaemonHandle | undefined;
let nativeId: string;
let sessionId: string;
let answerId: string;

function start(providers: string[]): Promise<DaemonHandle> {
  return startDaemon({
    home: salidiumHome,
    userHome,
    port: 0,
    providers: providers as never,
    gitEnrichment: false,
    historyDays: 36_500,
    logLevel: 'silent',
    alertSink: { publish: () => {} },
  });
}

async function api<T>(path: string, token = daemon?.token): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${daemon?.port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json()) as T;
}

async function events(): Promise<StoredEvent[]> {
  const body = await api<StoredEvent[] | { error: string }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/events?after=-1&limit=1000`,
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

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

beforeAll(async () => {
  process.env.XDG_DATA_HOME = xdg;
  process.env.SALIDIUM_EXPLAINER = 'off';
  mkdirSync(join(xdg, 'opencode'), { recursive: true });
  mkdirSync(PROJECT, { recursive: true });
  store = new SyntheticOpenCodeStore(storePath);
  nativeId = store.session({ directory: PROJECT, title: 'Fix add', timeCreated: T0 });
  sessionId = `salidium/opencode:${nativeId}`;
  store.message(nativeId, 'user', userData('Fix add and run the tests', T0 + 10));
  store.message(
    nativeId,
    'assistant',
    stepData(T0 + 20, [tools.edit('call_e1', T0 + 21, `${PROJECT}/math.js`, 'math.js')], {
      finish: 'tool-calls',
    }),
  );
  store.message(
    nativeId,
    'assistant',
    stepData(
      T0 + 30,
      [
        tools.shell(
          'call_s1',
          T0 + 31,
          'node --test math.test.js',
          0,
          'ℹ tests 2\nℹ pass 2\nℹ fail 0\n',
        ),
      ],
      { finish: 'tool-calls' },
    ),
  );
  answerId = store.message(
    nativeId,
    'assistant',
    stepData(T0 + 40, [{ type: 'text', text: 'Fixed add; tests pass.' }], { finish: 'stop' }),
  ).id;
  store.message(nativeId, 'idle', idleData('succeeded', T0 + 50));
});

afterAll(async () => {
  await daemon?.stop();
  store.close();
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  if (previousExplainer === undefined) delete process.env.SALIDIUM_EXPLAINER;
  else process.env.SALIDIUM_EXPLAINER = previousExplainer;
  rmSync(tmp, { recursive: true, force: true });
});

describe('OpenCode through the daemon', () => {
  it('reads the store into a report, live, and changes no OpenCode file', async () => {
    const before = digest(storePath);
    daemon = await start(['salidium/opencode']);
    const summary = await waitFor(async () => {
      const list = await api<Array<{ id: string; provider: string }>>('/api/sessions');
      return list.find((s) => s.id === sessionId);
    });
    expect(summary.provider).toBe('salidium/opencode');
    const stored = await waitFor(async () => {
      const all = await events();
      return all.some((e) => e.kind === 'turn.ended') ? all : undefined;
    });
    expect(stored.filter((e) => e.kind === 'tool.completed')).toHaveLength(2);

    // A new turn written while the daemon runs is read on the next poll.
    store.message(nativeId, 'user', userData('Now the failing file', T0 + 100));
    store.message(
      nativeId,
      'assistant',
      stepData(
        T0 + 110,
        [
          tools.shell(
            'call_s2',
            T0 + 111,
            'node --test failing.test.js',
            1,
            'ℹ tests 1\nℹ pass 0\nℹ fail 1\n',
          ),
        ],
        { finish: 'stop' },
      ),
    );
    store.message(nativeId, 'idle', idleData('succeeded', T0 + 120));
    await waitFor(async () => {
      const all = await events();
      return all.filter((e) => e.kind === 'turn.ended').length === 2 ? true : undefined;
    });

    const info = await api<{
      providers: Array<{
        id: string;
        displayName: string;
        sourcesWatched: number;
        hooksInstalled: boolean;
      }>;
    }>('/api/info');
    expect(info.providers).toEqual([
      expect.objectContaining({
        id: 'salidium/opencode',
        displayName: 'OpenCode',
        sourcesWatched: 1,
        hooksInstalled: false,
      }),
    ]);
    expect(digest(storePath)).toBe(before);
  });

  it('opens raw evidence through the restricted connection and fails closed on change', async () => {
    const all = await events();
    const edit = all.find((e) => e.kind === 'tool.completed' && e.toolName === 'edit');
    const raw = await api<{ raw: { content: Array<{ name: string }> } | null; reason?: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/raw/${encodeURIComponent(edit?.id ?? '')}`,
    );
    expect(raw.raw?.content[0]?.name).toBe('edit');

    const answer = all.find(
      (e) => e.kind === 'agent.message' && e.source.ref?.recordId?.includes(answerId),
    );
    store.update(
      nativeId,
      answerId,
      stepData(T0 + 40, [{ type: 'text', text: 'Rewritten.' }], { finish: 'stop' }),
    );
    const changed = await api<{ raw: unknown; reason?: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/raw/${encodeURIComponent(answer?.id ?? '')}`,
    );
    expect(changed).toMatchObject({ raw: null, reason: 'provider record changed since ingestion' });
  });

  it('suppresses a raw view whose part names a sensitive file, even when its event does not', async () => {
    const step = store.message(
      nativeId,
      'assistant',
      stepData(T0 + 60, [
        { type: 'text', text: 'Patching two files.' },
        {
          type: 'tool',
          id: 'call_pp',
          name: 'patch',
          executed: false,
          state: {
            status: 'completed',
            input: {
              patchText:
                '*** Begin Patch\n*** Update File: src/a.ts\n@@\n+x\n*** Update File: .env\n@@\n+SYNTHETIC_SECRET=not-real\n*** End Patch',
            },
            content: [{ type: 'text', text: 'Success.' }],
            metadata: {},
          },
          time: { created: T0 + 61, completed: T0 + 62 },
        },
      ]),
    );
    const all = await waitFor(async () => {
      const list = await events();
      return list.some((e) => e.kind === 'tool.called' && e.callId === `${step.id}/call_pp`)
        ? list
        : undefined;
    });
    const called = all.find((e) => e.kind === 'tool.called' && e.callId === `${step.id}/call_pp`);
    const raw = await api<{ raw: unknown; reason?: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/raw/${encodeURIComponent(called?.id ?? '')}`,
    );
    expect(raw).toMatchObject({
      raw: null,
      reason: 'suppressed: sensitive file contents or credential dump',
    });
    const text = all.find((e) => e.kind === 'agent.message' && e.source.ref?.line === step.seq);
    const shown = await api<{ raw: unknown }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/raw/${encodeURIComponent(text?.id ?? '')}`,
    );
    expect(JSON.stringify(shown.raw)).toContain('Patching two files.');
    expect(JSON.stringify(shown.raw)).not.toContain('SYNTHETIC_SECRET');
  });

  it('suppresses an MCP read of a sensitive file in the stored event and the raw view', async () => {
    const step = store.message(
      nativeId,
      'assistant',
      stepData(T0 + 70, [
        {
          type: 'tool',
          id: 'call_mcp',
          name: 'filesystem_read_file',
          executed: false,
          state: {
            status: 'completed',
            input: { file_path: `${PROJECT}/.env` },
            content: [{ type: 'text', text: 'SYNTHETIC_MCP_SECRET=not-real' }],
            metadata: {},
          },
          time: { created: T0 + 71, completed: T0 + 72 },
        },
      ]),
    );
    const callId = `${step.id}/call_mcp`;
    const all = await waitFor(async () => {
      const list = await events();
      return list.some((e) => e.kind === 'tool.completed' && e.callId === callId)
        ? list
        : undefined;
    });
    const completed = all.find((e) => e.kind === 'tool.completed' && e.callId === callId);
    expect(JSON.stringify(completed)).not.toContain('SYNTHETIC_MCP_SECRET');
    for (const event of all.filter((e) => 'callId' in e && e.callId === callId)) {
      const raw = await api<{ raw: unknown; reason?: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/raw/${encodeURIComponent(event.id)}`,
      );
      expect(raw.raw).toBeNull();
      expect(raw.reason).toMatch(/^suppressed/);
    }
  });

  it('answers a consumer v1 lookup by provider salidium/opencode and the OpenCode session id', async () => {
    const { token } = createConsumerCredential(salidiumHome, 'local-tool-test');
    const discovery = await (
      await fetch(`http://127.0.0.1:${daemon?.port}/consumer/v1/discovery`)
    ).json();
    expect(discovery.providers).toEqual([{ id: 'salidium/opencode' }]);
    const lookup = await api<unknown>(
      `/consumer/v1/sessions/lookup?provider=${encodeURIComponent('salidium/opencode')}&sessionId=${encodeURIComponent(nativeId)}`,
      token,
    );
    const parsed = SessionLookupSchema.parse(lookup);
    expect(parsed.session).toMatchObject({ id: sessionId });
    const report = SessionReportSchema.parse(
      await api<unknown>(`/consumer/v1/sessions/${encodeURIComponent(sessionId)}/report`, token),
    );
    expect(report.session).toMatchObject({
      id: sessionId,
      native: { provider: 'salidium/opencode', sessionId: nativeId },
    });
  });

  it('resumes from durable cursors after a restart without duplicating events', async () => {
    const count = (await events()).length;
    await daemon?.stop();
    const db = new SqliteStore(join(salidiumHome, 'salidium.db'));
    const cursors = db.allSources().filter((s) => s.provider === 'salidium/opencode');
    db.close();
    expect(cursors).toEqual([
      expect.objectContaining({
        path: `${storePath}#${nativeId}`,
        sessionId,
        inode: expect.any(Number),
      }),
    ]);
    daemon = await start(['salidium/opencode']);
    await sleep(1500);
    expect((await events()).length).toBe(count);
  });

  it('reads nothing, raw evidence included, once OpenCode is disabled', async () => {
    const opencodeEvent = (await events()).find((e) => e.kind === 'tool.completed');
    await daemon?.stop();
    daemon = await start([]);
    store.message(nativeId, 'user', userData('ignored while disabled', T0 + 500));
    await sleep(1500);
    expect(
      (await events()).some(
        (e) => e.kind === 'turn.started' && e.prompt === 'ignored while disabled',
      ),
    ).toBe(false);
    const raw = await api<{ raw: unknown; reason?: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/raw/${encodeURIComponent(opencodeEvent?.id ?? '')}`,
    );
    expect(raw).toMatchObject({
      raw: null,
      reason: 'this provider is not enabled in Salidium, so its store is not read',
    });
  });
});
