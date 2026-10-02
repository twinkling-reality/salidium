import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoreCursor, StoreSource } from '@salidium/adapter-kit';
import { applyEvent, createInitialState, projectSession } from '@salidium/core';
import {
  type CanonicalEvent,
  type CanonicalEventOf,
  CanonicalEventSchema,
  makeSessionId,
  type StoredEvent,
} from '@salidium/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPENCODE_PROVIDER_ID } from './mapping.ts';
import { createOpenCodeStoreSource, cursorKey, openCodeStorePath } from './storeSource.ts';
import {
  idleData,
  SyntheticOpenCodeStore,
  stepData,
  T0,
  tools,
  userData,
} from './testing/syntheticStore.ts';

let dir: string;
let path: string;
let store: SyntheticOpenCodeStore;
const PROJECT = '/work/project';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'salidium-opencode-source-'));
  path = join(dir, 'opencode.db');
  store = new SyntheticOpenCodeStore(path);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  source: StoreSource;
  cursors: Map<string, StoreCursor>;
  events: CanonicalEvent[];
  poll(options?: { rowBudget?: number; activeSinceMs?: number }): CanonicalEvent[];
}

function harness(): Harness {
  const source = createOpenCodeStoreSource();
  const cursors = new Map<string, StoreCursor>();
  const events: CanonicalEvent[] = [];
  const seen = new Set<string>();
  return {
    source,
    cursors,
    events,
    poll(options = {}) {
      const fresh: CanonicalEvent[] = [];
      for (let round = 0; round < 1000; round++) {
        const result = source.poll({
          path,
          activeSinceMs: options.activeSinceMs ?? 0,
          cursors,
          observedAt: '2026-10-02T13:00:00.000Z',
          maxRecordBytes: 8 * 1024 * 1024,
          rowBudget: options.rowBudget ?? 500,
        });
        for (const batch of result.batches) {
          for (const event of batch.events) {
            CanonicalEventSchema.parse(event);
            if (seen.has(event.id)) continue;
            seen.add(event.id);
            events.push(event);
            fresh.push(event);
          }
          cursors.set(batch.cursor.key, batch.cursor);
        }
        if (!result.more) break;
      }
      return fresh;
    },
  };
}

function of<K extends CanonicalEvent['kind']>(events: CanonicalEvent[], kind: K) {
  return events.filter((e): e is CanonicalEventOf<K> => e.kind === kind);
}

/** The edit, write, test pass and test fail session recorded in Phase 1, rebuilt synthetically. */
function workSession(): { id: string; ids: Record<string, string> } {
  const id = store.session({ directory: PROJECT, title: 'Fix add', timeCreated: T0 });
  const ids: Record<string, string> = {};
  ids.user = store.message(id, 'user', userData('Fix add and run the tests', T0 + 10)).id;
  ids.read = store.message(
    id,
    'assistant',
    stepData(
      T0 + 20,
      [
        { type: 'reasoning', text: 'Look first.' },
        { type: 'text', text: 'Reading the code.' },
        tools.read('call_r1', T0 + 21, `${PROJECT}/math.js`),
        tools.grep('call_g1', T0 + 22, 'TODO', PROJECT),
        tools.listDirectory('call_l1', T0 + 23, PROJECT),
      ],
      { finish: 'tool-calls', tokens: { input: 6000, output: 400, cacheRead: 0 } },
    ),
    { gap: 3 },
  ).id;
  ids.edit = store.message(
    id,
    'assistant',
    stepData(T0 + 30, [tools.edit('call_e1', T0 + 31, `${PROJECT}/math.js`, 'math.js')], {
      finish: 'tool-calls',
    }),
    { gap: 5 },
  ).id;
  ids.write = store.message(
    id,
    'assistant',
    stepData(
      T0 + 40,
      [
        tools.write(
          'call_w1',
          T0 + 41,
          `${PROJECT}/subtract.js`,
          'subtract.js',
          'export const a = 1;\nexport const b = 2;\n',
          true,
        ),
        tools.write(
          'call_w2',
          T0 + 42,
          `${PROJECT}/notes.txt`,
          'notes.txt',
          'first\nsecond\n',
          false,
        ),
      ],
      { finish: 'tool-calls' },
    ),
  ).id;
  ids.tests = store.message(
    id,
    'assistant',
    stepData(
      T0 + 50,
      [
        tools.shell(
          'call_s1',
          T0 + 51,
          'node --test math.test.js',
          0,
          '✔ add\nℹ tests 2\nℹ pass 2\nℹ fail 0\n',
        ),
        tools.shell(
          'call_s2',
          T0 + 52,
          'node --test failing.test.js',
          1,
          '✖ always fails\nℹ tests 1\nℹ pass 0\nℹ fail 1\n',
        ),
      ],
      { finish: 'tool-calls' },
    ),
  ).id;
  ids.answer = store.message(
    id,
    'assistant',
    stepData(T0 + 60, [{ type: 'text', text: 'Fixed add; one test file still fails by design.' }], {
      finish: 'stop',
    }),
  ).id;
  ids.idle = store.message(id, 'idle', idleData('succeeded', T0 + 70)).id;
  return { id, ids };
}

describe('OpenCode store source', () => {
  it('locates the store under XDG_DATA_HOME, else ~/.local/share, only when it exists', () => {
    expect(openCodeStorePath('/home/p', { XDG_DATA_HOME: '/xdg' })).toBe(
      '/xdg/opencode/opencode.db',
    );
    expect(openCodeStorePath('/home/p', {})).toBe('/home/p/.local/share/opencode/opencode.db');
    expect(openCodeStorePath('/home/p', { XDG_DATA_HOME: 'relative' })).toBe(
      '/home/p/.local/share/opencode/opencode.db',
    );
    const source = createOpenCodeStoreSource();
    expect(source.locate({ userHome: '/nowhere', env: { XDG_DATA_HOME: dir } })).toBeUndefined();
    expect(source.changeIndicators(path)).toEqual([path, `${path}-wal`]);
  });

  it('maps a session to canonical events under the namespaced provider id', () => {
    const { id, ids } = workSession();
    const h = harness();
    const events = h.poll();
    const sessionId = makeSessionId(OPENCODE_PROVIDER_ID, id);
    expect(sessionId).toBe(`salidium/opencode:${id}`);
    expect(events.every((e) => e.sessionId === sessionId)).toBe(true);
    expect(events.every((e) => e.source.provider === 'salidium/opencode')).toBe(true);

    const started = of(events, 'session.started')[0];
    expect(started).toMatchObject({
      cwd: PROJECT,
      model: 'ollama/qwen-synthetic',
      ts: new Date(T0).toISOString(),
    });
    expect(of(events, 'session.updated')[0]?.title).toBe('Fix add');

    const turn = of(events, 'turn.started')[0];
    expect(turn).toMatchObject({ turnId: ids.user, prompt: 'Fix add and run the tests' });
    const ended = of(events, 'turn.ended')[0];
    expect(ended).toMatchObject({
      turnId: ids.user,
      outcome: 'completed',
      lastMessage: 'Fixed add; one test file still fails by design.',
    });

    const called = of(events, 'tool.called');
    expect(called.map((e) => [e.toolName, e.input.kind])).toEqual([
      ['read', 'fileRead'],
      ['grep', 'search'],
      ['read', 'other'],
      ['edit', 'fileEdit'],
      ['write', 'fileWrite'],
      ['write', 'fileWrite'],
      ['shell', 'command'],
      ['shell', 'command'],
    ]);
    expect(called.every((e) => e.turnId === ids.user)).toBe(true);
    // Composite call ids: Ollama's short ids cannot collide across steps or lanes.
    expect(called[0]?.callId).toBe(`${ids.read}/call_r1`);

    const done = of(events, 'tool.completed');
    const edit = done.find((e) => e.callId === `${ids.edit}/call_e1`);
    expect(edit?.result).toMatchObject({
      kind: 'fileChanges',
      changes: [
        {
          path: `${PROJECT}/math.js`,
          change: 'update',
          linesAdded: 1,
          linesRemoved: 1,
          applied: true,
        },
      ],
    });
    const created = done.find((e) => e.callId === `${ids.write}/call_w1`);
    expect(created?.result).toMatchObject({
      kind: 'fileChanges',
      changes: [{ path: `${PROJECT}/subtract.js`, change: 'add', linesAdded: 2, linesRemoved: 0 }],
    });
    expect(
      created?.result.kind === 'fileChanges' && created.result.changes[0]?.linesRemovedUnknown,
    ).toBeUndefined();
    const overwritten = done.find((e) => e.callId === `${ids.write}/call_w2`);
    expect(overwritten?.result).toMatchObject({
      kind: 'fileChanges',
      changes: [
        {
          path: `${PROJECT}/notes.txt`,
          change: 'update',
          linesAdded: 2,
          linesRemoved: 0,
          linesRemovedUnknown: true,
        },
      ],
    });
    const pass = done.find((e) => e.callId === `${ids.tests}/call_s1`);
    const fail = done.find((e) => e.callId === `${ids.tests}/call_s2`);
    expect(pass?.result).toMatchObject({
      kind: 'command',
      exit: { code: 0, observation: 'explicit' },
    });
    expect(pass?.isError).toBe(false);
    expect(fail?.result).toMatchObject({
      kind: 'command',
      exit: { code: 1, observation: 'explicit' },
    });
    expect(fail?.isError).toBe(true);
    expect(done.find((e) => e.callId === `${ids.read}/call_r1`)?.result).toEqual({
      kind: 'fileRead',
      path: `${PROJECT}/math.js`,
    });

    const usage = of(events, 'agent.usage');
    expect(usage).toHaveLength(5);
    expect(usage[0]).toMatchObject({
      messageId: ids.read,
      inputTokens: 6000,
      outputTokens: 400,
      model: 'ollama/qwen-synthetic',
    });
    expect(of(events, 'agent.thinking')[0]?.chars).toBe('Look first.'.length);
    const messages = of(events, 'agent.message');
    expect(messages.map((m) => m.phase)).toEqual(['commentary', 'final']);

    // Every message event cites its row, re-readable and fingerprinted.
    const cited = events.filter((e) => e.source.ref?.recordId?.includes('/'));
    expect(cited.length).toBeGreaterThan(10);
    for (const e of cited) {
      expect(e.source.ref?.path).toBe(path);
      expect(e.source.ref?.recordHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(e.source.channel).toBe('transcript');
      expect(e.source.version).toBe('2.0.18');
    }
  });

  it('is deterministic and idempotent across restarts and full re-reads', () => {
    workSession();
    const first = harness().poll();
    const second = harness().poll();
    expect(second).toEqual(first);
    // Resuming from persisted cursors re-reads nothing new.
    const h = harness();
    h.poll();
    const resumed = createOpenCodeStoreSource();
    const again = resumed.poll({
      path,
      activeSinceMs: 0,
      cursors: h.cursors,
      observedAt: '2026-10-02T14:00:00.000Z',
      maxRecordBytes: 8 * 1024 * 1024,
      rowBudget: 500,
    });
    const messageEvents = again.batches
      .flatMap((b) => b.events)
      .filter((e) => e.source.ref?.line !== undefined);
    expect(messageEvents).toEqual([]);
  });

  it('reads incrementally within a small row budget and reaches the same events', () => {
    workSession();
    const whole = harness().poll();
    const small = harness();
    const pieces = small.poll({ rowBudget: 1 });
    expect(new Set(pieces.map((e) => e.id))).toEqual(new Set(whole.map((e) => e.id)));
  });

  it('emits a step only once it is final, and its tools once', () => {
    const id = store.session({ directory: PROJECT });
    store.message(id, 'user', userData('run it', T0 + 1));
    const running = store.message(
      id,
      'assistant',
      stepData(T0 + 2, [tools.running('call_x', T0 + 3, 'shell', { command: 'sleep 4' })], {
        running: true,
      }),
    );
    const h = harness();
    const before = h.poll();
    expect(of(before, 'turn.started')).toHaveLength(1);
    expect(of(before, 'tool.called')).toHaveLength(0);
    expect(h.cursors.get(cursorKey(path, id))?.position).toBe(1);

    // OpenCode updates the same row in place when the step completes.
    store.update(
      id,
      running.id,
      stepData(T0 + 2, [tools.shell('call_x', T0 + 3, 'sleep 4', 0, 'done')], {
        finish: 'tool-calls',
      }),
    );
    const after = h.poll();
    expect(of(after, 'tool.called')).toHaveLength(1);
    expect(of(after, 'tool.completed')).toHaveLength(1);
    expect(h.poll()).toEqual([]);
  });

  it('never spins on a step OpenCode did not finish', () => {
    // A step left running with more rows after it and no later turn: the session waits, and the
    // poll neither asks to be read again nor holds back a healthy session sorted after it.
    const stuck = store.session({ directory: PROJECT, timeCreated: T0 });
    store.message(stuck, 'user', userData('start', T0 + 1));
    store.message(
      stuck,
      'assistant',
      stepData(T0 + 2, [tools.running('call_r', T0 + 3, 'shell', { command: 'sleep 99' })], {
        running: true,
      }),
    );
    for (let i = 0; i < 30; i++)
      store.message(stuck, 'compaction', {
        time: { created: T0 + 4 + i },
        status: 'completed',
        reason: 'auto',
      });
    const healthy = store.session({ directory: PROJECT, timeCreated: T0 + 1000 });
    store.message(healthy, 'user', userData('healthy', T0 + 1001));
    const source = createOpenCodeStoreSource();
    const result = source.poll({
      path,
      activeSinceMs: 0,
      cursors: new Map(),
      observedAt: '2026-10-02T13:00:00.000Z',
      maxRecordBytes: 8 * 1024 * 1024,
      rowBudget: 20,
    });
    expect(result.more).toBe(false);
    const healthyEvents =
      result.batches.find((b) => b.cursor.providerSessionId === healthy)?.events ?? [];
    expect(of(healthyEvents, 'turn.started').map((e) => e.prompt)).toEqual(['healthy']);
    expect(result.batches.find((b) => b.cursor.providerSessionId === stuck)?.cursor.position).toBe(
      1,
    );
  });

  it('passes a step OpenCode abandoned once a later turn exists, and says so', () => {
    const id = store.session({ directory: PROJECT, timeCreated: T0 });
    store.message(id, 'user', userData('first', T0 + 1));
    store.message(
      id,
      'assistant',
      stepData(T0 + 2, [tools.running('call_r', T0 + 3, 'shell', { command: 'sleep 99' })], {
        running: true,
      }),
    );
    store.message(id, 'user', userData('second', T0 + 10));
    store.message(id, 'assistant', stepData(T0 + 11, [{ type: 'text', text: 'Done.' }]));
    store.message(id, 'idle', idleData('succeeded', T0 + 12));
    const events = harness().poll();
    expect(of(events, 'turn.started').map((e) => e.prompt)).toEqual(['first', 'second']);
    expect(of(events, 'ingest.warning')).toEqual([
      expect.objectContaining({
        code: 'source-gap',
        detail: expect.stringContaining('unfinished'),
      }),
    ]);
    expect(of(events, 'turn.ended')).toHaveLength(1);
  });

  it('records a declined permission as a rejected call and an interrupt as interrupted', () => {
    const id = store.session({ directory: PROJECT });
    store.message(id, 'user', userData('ls please', T0 + 1));
    store.message(
      id,
      'assistant',
      stepData(
        T0 + 2,
        [
          tools.failed(
            'call_d',
            T0 + 3,
            'shell',
            { command: 'ls -la' },
            { type: 'aborted', message: 'The user declined this tool call' },
          ),
        ],
        { finish: 'error', error: { type: 'aborted', message: 'Step interrupted' } },
      ),
    );
    store.message(id, 'user', userData('read it', T0 + 10));
    store.message(
      id,
      'assistant',
      stepData(
        T0 + 11,
        [
          tools.failed(
            'call_m',
            T0 + 12,
            'read',
            { path: `${PROJECT}/missing.js` },
            { type: 'tool.execution', message: 'File not found' },
          ),
        ],
        { finish: 'tool-calls' },
      ),
    );
    store.message(id, 'idle', idleData('interrupted', T0 + 20));
    const events = harness().poll();
    const failed = of(events, 'tool.failed');
    expect(failed.map((e) => [e.toolName, e.cause])).toEqual([
      ['shell', 'rejected'],
      ['read', 'error'],
    ]);
    // Asked and granted permissions are not in the store; nothing is inferred about them.
    expect(of(events, 'permission.requested')).toEqual([]);
    expect(of(events, 'turn.ended')).toEqual([expect.objectContaining({ outcome: 'interrupted' })]);
  });

  it('maps patch, subagent lanes and migrated to-do lists', () => {
    const id = store.session({ directory: PROJECT, timeCreated: T0 });
    store.message(id, 'user', userData('delegate', T0 + 1));
    const child = store.session({
      directory: PROJECT,
      parentId: id,
      agent: 'explore',
      title: 'Find synthetic files',
      timeCreated: T0 + 5,
    });
    store.message(child, 'user', userData('Find the files.', T0 + 5));
    store.message(
      child,
      'assistant',
      stepData(T0 + 6, [tools.glob('call_aaaa0001', T0 + 7, '**/*', PROJECT)], {
        finish: 'tool-calls',
      }),
    );
    store.message(child, 'assistant', stepData(T0 + 8, [{ type: 'text', text: 'a.js only.' }]));
    store.message(child, 'idle', idleData('succeeded', T0 + 9));
    const step = store.message(
      id,
      'assistant',
      stepData(
        T0 + 4,
        [
          tools.subagent('call_aaaa0001', T0 + 4, child, 'a.js only.'),
          tools.patch('call_p', T0 + 10),
          tools.todowrite('call_t', T0 + 11),
        ],
        { finish: 'tool-calls' },
      ),
    );
    const events = harness().poll();
    const sessionId = makeSessionId(OPENCODE_PROVIDER_ID, id);
    expect(events.every((e) => e.sessionId === sessionId)).toBe(true);
    expect(of(events, 'session.started')).toHaveLength(1);

    const lane = events.filter((e) => e.agentId === child);
    expect(of(lane, 'subagent.started')[0]).toMatchObject({
      subagentId: child,
      agentType: 'explore',
      description: 'Find synthetic files',
    });
    expect(of(lane, 'subagent.ended')[0]).toMatchObject({
      subagentId: child,
      lastMessage: 'a.js only.',
    });
    expect(of(lane, 'turn.started')).toEqual([]);
    expect(of(lane, 'tool.called')[0]?.turnId).toBeUndefined();
    // The same short provider call id in the parent and the lane stays two calls.
    const calls = of(events, 'tool.called').map((e) => e.callId);
    expect(new Set(calls).size).toBe(calls.length);

    const delegate = of(events, 'tool.completed').find(
      (e) => e.callId === `${step.id}/call_aaaa0001`,
    );
    expect(delegate?.result).toMatchObject({
      kind: 'subagent',
      agentId: child,
      status: 'completed',
      summaryExcerpt: 'a.js only.',
    });

    const patch = of(events, 'tool.completed').find((e) => e.callId === `${step.id}/call_p`);
    expect(patch?.result).toEqual({
      kind: 'fileChanges',
      changes: [
        expect.objectContaining({
          path: `${PROJECT}/README.md`,
          change: 'update',
          linesAdded: 1,
          linesRemoved: 0,
        }),
        expect.objectContaining({
          path: `${PROJECT}/notes.txt`,
          change: 'add',
          linesAdded: 1,
          linesRemoved: 0,
        }),
        expect.objectContaining({
          path: `${PROJECT}/old.js`,
          change: 'delete',
          linesAdded: 0,
          linesRemoved: 3,
        }),
      ],
    });
    expect(of(events, 'tool.called').find((e) => e.callId === `${step.id}/call_p`)?.title).toBe(
      'Patch README.md and 2 more',
    );
    expect(of(events, 'plan.updated')[0]).toMatchObject({
      mode: 'replace',
      items: [
        { id: '1', text: 'Fix add', status: 'completed' },
        { id: '2', text: 'Run tests', status: 'in_progress' },
      ],
    });
  });

  it('does not count a fork twice, and starts the fork as its own session', () => {
    const { id } = workSession();
    const fork = store.fork(id, { directory: PROJECT, timeCreated: T0 + 100 });
    store.message(fork, 'user', userData('continue in the fork', T0 + 110));
    store.message(fork, 'assistant', stepData(T0 + 111, [{ type: 'text', text: 'Continuing.' }]));
    store.message(fork, 'idle', idleData('succeeded', T0 + 112));
    const events = harness().poll();
    const forkEvents = events.filter(
      (e) => e.sessionId === makeSessionId(OPENCODE_PROVIDER_ID, fork),
    );
    expect(of(forkEvents, 'session.started')[0]?.reason).toBe('fork');
    expect(of(forkEvents, 'turn.started').map((e) => e.prompt)).toEqual(['continue in the fork']);
    expect(of(forkEvents, 'tool.called')).toEqual([]);
    expect(of(forkEvents, 'agent.usage')).toHaveLength(1);
  });

  it('keeps what a revert removed and says so once', () => {
    const { id, ids } = workSession();
    const h = harness();
    h.poll();
    const removedFrom = h.events.find((e) =>
      e.source.ref?.recordId?.startsWith(`${id}/${ids.tests}`),
    )?.source.ref?.line;
    expect(removedFrom).toBeDefined();
    store.revert(id, removedFrom as number);
    const after = h.poll();
    expect(after).toEqual([
      expect.objectContaining({
        kind: 'ingest.warning',
        code: 'source-gap',
        detail: expect.stringContaining('removed 3 recorded messages'),
      }),
    ]);
    expect(h.poll()).toEqual([]);
    // New work after the revert continues and is read.
    store.message(id, 'user', userData('again', T0 + 200));
    expect(of(h.poll(), 'turn.started')).toHaveLength(1);
  });

  it('skips sessions outside the history window unless they already have a cursor', () => {
    workSession();
    expect(harness().poll({ activeSinceMs: T0 + 10_000 })).toEqual([]);
  });

  it('warns about rows it will not parse instead of guessing', () => {
    const id = store.session({ directory: PROJECT });
    store.message(id, 'user', { time: { created: T0 }, text: 'x'.repeat(5000) });
    // 400 characters but 1600 bytes: the ceiling is in bytes.
    store.message(id, 'user', { time: { created: T0 + 1 }, text: '\u{1F600}'.repeat(400) });
    const source = createOpenCodeStoreSource();
    const result = source.poll({
      path,
      activeSinceMs: 0,
      cursors: new Map(),
      observedAt: '2026-10-02T13:00:00.000Z',
      maxRecordBytes: 1000,
      rowBudget: 10,
    });
    const events = result.batches.flatMap((b) => b.events);
    expect(of(events, 'ingest.warning')).toEqual([
      expect.objectContaining({ code: 'truncated-record', tsSource: 'ingest' }),
      expect.objectContaining({ code: 'truncated-record', tsSource: 'ingest' }),
    ]);
  });

  it('reduces to a coherent report', () => {
    const { id } = workSession();
    const events = harness().poll();
    const sessionId = makeSessionId(OPENCODE_PROVIDER_ID, id);
    const state = createInitialState({
      sessionId,
      provider: OPENCODE_PROVIDER_ID,
      providerSessionId: id,
    });
    events.forEach((e, seq) => {
      applyEvent(state, { ...e, seq } as StoredEvent);
    });
    expect(state.turns).toHaveLength(1);
    expect(state.counters.toolCalls).toBe(8);
    expect(state.counters.commands).toBe(2);
    expect(Object.keys(state.files).sort()).toEqual(
      [`${PROJECT}/math.js`, `${PROJECT}/notes.txt`, `${PROJECT}/subtract.js`].sort(),
    );
    const view = projectSession(state, T0 + 100_000);
    expect(view.verified.runs.length).toBe(2);
    expect(view.verified.runs.map((r) => r.outcome).sort()).toEqual(['fail', 'pass']);
  });
});

describe('OpenCode raw records', () => {
  it('re-reads a cited row through the restricted connection and verifies it', () => {
    const { id, ids } = workSession();
    const events = harness().poll();
    const source = createOpenCodeStoreSource();
    const edit = events.find(
      (e) => e.kind === 'tool.completed' && e.callId === `${ids.edit}/call_e1`,
    );
    const ref = edit?.source.ref;
    expect(ref?.recordId).toBe(`${id}/${ids.edit}#0`);
    const read = source.readRawRecord(path, ref ?? {});
    expect(read.raw).toBeDefined();
    expect(JSON.parse(read.raw ?? '{}').content.map((c: { name: string }) => c.name)).toEqual([
      'edit',
    ]);
    expect(read).toMatchObject({ paths: [`${PROJECT}/math.js`, 'math.js'], commands: [] });

    const session = of(events, 'session.started')[0];
    const stable = source.readRawRecord(path, session?.source.ref ?? {});
    expect(JSON.parse(stable.raw ?? '{}')).toMatchObject({ id, directory: PROJECT });
  });

  it('fails closed when the row changed, vanished, or the store moved', () => {
    const { id, ids } = workSession();
    const events = harness().poll();
    const source = createOpenCodeStoreSource();
    const ref =
      events.find((e) => e.source.ref?.recordId?.startsWith(`${id}/${ids.answer}`))?.source.ref ??
      {};

    expect(source.readRawRecord(join(dir, 'other.db'), ref)).toEqual({
      raw: undefined,
      reason: 'the OpenCode store has moved since this was recorded',
    });
    expect(source.readRawRecord(path, { ...ref, recordHash: undefined })).toMatchObject({
      raw: undefined,
    });

    store.update(id, ids.answer, stepData(T0 + 60, [{ type: 'text', text: 'Rewritten.' }]));
    expect(source.readRawRecord(path, ref)).toEqual({
      raw: undefined,
      reason: 'provider record changed since ingestion',
    });

    store.revert(id, 1);
    expect(source.readRawRecord(path, ref)).toEqual({
      raw: undefined,
      reason: 'record no longer in the OpenCode store (deleted or reverted)',
    });

    // A forged reference to a row of another session is refused, not read.
    const other = store.session({ directory: PROJECT });
    const row = store.message(other, 'user', userData('other', T0));
    expect(
      source.readRawRecord(path, { path, recordId: `${id}/${row.id}`, recordHash: ref.recordHash }),
    ).toMatchObject({ raw: undefined });
  });

  it('shows only the part an event stands for, and names its paths and commands', () => {
    const id = store.session({ directory: PROJECT });
    store.message(id, 'user', userData('look at the env', T0 + 1));
    const step = store.message(
      id,
      'assistant',
      stepData(T0 + 2, [
        { type: 'text', text: 'Reading the settings.' },
        tools.read('call_env', T0 + 3, `${PROJECT}/.env`, '1: SYNTHETIC_SECRET=not-real'),
        tools.shell('call_dump', T0 + 4, 'printenv', 0, 'SYNTHETIC_TOKEN=not-real'),
      ]),
    );
    const person = store.message(id, 'shell', {
      time: { created: T0 + 9, completed: T0 + 10 },
      shellID: 'sh_synthetic',
      command: 'cat .env',
      status: 'exited',
      exit: 0,
      output: { output: 'SYNTHETIC_SECRET=not-real', cursor: 0, size: 25, truncated: false },
    });
    const events = harness().poll();
    const source = createOpenCodeStoreSource();
    const cite = (match: (e: CanonicalEvent) => boolean) =>
      source.readRawRecord(path, events.find(match)?.source.ref ?? {});

    const message = cite((e) => e.kind === 'agent.message');
    expect(message.raw).toBeDefined();
    expect(message.raw).not.toContain('SYNTHETIC');
    expect(message).toMatchObject({ paths: [], commands: [] });

    const usage = cite((e) => e.kind === 'agent.usage');
    expect(usage.raw).not.toContain('SYNTHETIC');
    expect(JSON.parse(usage.raw ?? '{}').content).toBeUndefined();

    const read = cite((e) => e.kind === 'tool.completed' && e.callId === `${step.id}/call_env`);
    expect(read).toMatchObject({ paths: [`${PROJECT}/.env`], commands: [] });
    const dump = cite((e) => e.kind === 'tool.called' && e.callId === `${step.id}/call_dump`);
    expect(dump).toMatchObject({ paths: [], commands: ['printenv'] });

    const shell = cite((e) => e.source.ref?.recordId === `${id}/${person.id}`);
    expect(shell.raw).not.toContain('SYNTHETIC');
    expect(shell).toMatchObject({ commands: ['cat .env'] });

    // A prompt's attached file is named, not shown.
    const withFile = store.message(id, 'user', {
      time: { created: T0 + 20 },
      text: 'see attached',
      files: [
        {
          data: Buffer.from('SYNTHETIC_SECRET=not-real').toString('base64'),
          mime: 'text/plain',
          source: { type: 'uri', uri: `file://${PROJECT}/.env` },
          name: '.env',
        },
      ],
    });
    const prompt = source.readRawRecord(
      path,
      harness()
        .poll()
        .find((e) => e.source.ref?.recordId === `${id}/${withFile.id}`)?.source.ref ?? {},
    );
    expect(prompt.raw).toBeDefined();
    expect(prompt.raw).not.toContain(Buffer.from('SYNTHETIC_SECRET=not-real').toString('base64'));
    expect(prompt).toMatchObject({ paths: [`${PROJECT}/.env`, '.env'] });

    expect(
      source.readRawRecord(path, {
        ...(events.find((e) => e.kind === 'agent.message')?.source.ref ?? {}),
        recordId: `${id}/${step.id}#9`,
      }),
    ).toEqual({ raw: undefined, reason: 'record part not found' });
  });
});
