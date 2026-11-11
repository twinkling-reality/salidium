import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { StoreCursor } from '@salidium/adapter-kit';
import { makeSessionId } from '@salidium/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPENCODE_PROVIDER_ID } from './mapping.ts';
import {
  createOpenCodeStoreSource,
  OPENCODE_EXTRA_STORES_ENV,
  openCodeStorePaths,
} from './storeSource.ts';
import { SyntheticOpenCodeStore, T0, userData } from './testing/syntheticStore.ts';

/*
 * Extra OpenCode stores: a local tool that runs OpenCode with data folders of its own, one store
 * per task, names them in SALIDIUM_EXTRA_OPENCODE_STORES. Each is read exactly as the default.
 */

let root: string;
const open: SyntheticOpenCodeStore[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'salidium-opencode-stores-')));
});

afterEach(() => {
  for (const store of open.splice(0)) store.close();
  rmSync(root, { recursive: true, force: true });
});

function makeStore(path: string, prompt?: string): SyntheticOpenCodeStore {
  mkdirSync(dirname(path), { recursive: true });
  const store = new SyntheticOpenCodeStore(path);
  open.push(store);
  if (prompt) {
    const id = store.session({ directory: '/work/project', timeCreated: T0 });
    store.message(id, 'user', userData(prompt, T0 + 10));
  }
  return store;
}

const home = () => join(root, 'home');
const defaultStore = () => join(home(), '.local', 'share', 'opencode', 'opencode.db');
const sandbox = (name: string) => join(root, 'tool', name, 'data', 'opencode', 'opencode.db');
const sandboxPattern = () =>
  join(root, 'tool', 'opencode-sandbox-*', 'data', 'opencode', 'opencode.db');

describe('extra OpenCode stores', () => {
  it('reads only the default store when the setting is absent or empty', () => {
    expect(openCodeStorePaths(home(), {})).toEqual([]);
    makeStore(defaultStore());
    expect(openCodeStorePaths(home(), {})).toEqual([defaultStore()]);
    expect(openCodeStorePaths(home(), { [OPENCODE_EXTRA_STORES_ENV]: '' })).toEqual([
      defaultStore(),
    ]);
  });

  it('adds a second store after the default, each once', () => {
    makeStore(defaultStore());
    const second = sandbox('opencode-sandbox');
    makeStore(second);
    const env = { [OPENCODE_EXTRA_STORES_ENV]: `${second}:${second}:${defaultStore()}` };
    expect(openCodeStorePaths(home(), env)).toEqual([defaultStore(), second]);
    expect(createOpenCodeStoreSource().locateAll({ userHome: home(), env })).toEqual([
      defaultStore(),
      second,
    ]);
  });

  it('ignores a relative entry and one that does not exist yet', () => {
    const env = {
      [OPENCODE_EXTRA_STORES_ENV]: `relative/opencode.db:${sandbox('opencode-sandbox')}`,
    };
    expect(openCodeStorePaths(home(), env)).toEqual([]);
    makeStore(sandbox('opencode-sandbox'));
    expect(openCodeStorePaths(home(), env)).toEqual([sandbox('opencode-sandbox')]);
  });

  it('expands a pattern to every sandbox store, found as tasks make them', () => {
    const env = { [OPENCODE_EXTRA_STORES_ENV]: sandboxPattern() };
    expect(openCodeStorePaths(home(), env)).toEqual([]);
    makeStore(sandbox('opencode-sandbox-0123456789abcdef'));
    expect(openCodeStorePaths(home(), env)).toEqual([sandbox('opencode-sandbox-0123456789abcdef')]);
    makeStore(sandbox('opencode-sandbox-fedcba9876543210'));
    // `opencode-sandbox` itself is not `opencode-sandbox-` followed by a name.
    makeStore(sandbox('opencode-sandbox'));
    expect(openCodeStorePaths(home(), env)).toEqual([
      sandbox('opencode-sandbox-0123456789abcdef'),
      sandbox('opencode-sandbox-fedcba9876543210'),
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'never follows a link a pattern finds: not a folder, not a folder below it, not the store',
    () => {
      const elsewhere = join(root, 'elsewhere', 'data', 'opencode', 'opencode.db');
      makeStore(elsewhere);
      mkdirSync(join(root, 'tool'), { recursive: true });
      symlinkSync(join(root, 'elsewhere'), join(root, 'tool', 'opencode-sandbox-linked'));

      mkdirSync(join(root, 'tool', 'opencode-sandbox-datalink'));
      symlinkSync(
        join(root, 'elsewhere', 'data'),
        join(root, 'tool', 'opencode-sandbox-datalink', 'data'),
      );

      mkdirSync(dirname(sandbox('opencode-sandbox-filelink')), { recursive: true });
      symlinkSync(elsewhere, sandbox('opencode-sandbox-filelink'));

      const env = { [OPENCODE_EXTRA_STORES_ENV]: sandboxPattern() };
      expect(openCodeStorePaths(home(), env)).toEqual([]);
      // Named as it is, a link is read exactly as the default store is: followed.
      const named = { [OPENCODE_EXTRA_STORES_ENV]: sandbox('opencode-sandbox-filelink') };
      expect(openCodeStorePaths(home(), named)).toEqual([sandbox('opencode-sandbox-filelink')]);
    },
  );

  it.skipIf(process.platform === 'win32')('does not locate a FIFO named as an extra store', () => {
    const fifo = sandbox('opencode-sandbox');
    mkdirSync(dirname(fifo), { recursive: true });
    execFileSync('mkfifo', [fifo]);
    expect(openCodeStorePaths(home(), { [OPENCODE_EXTRA_STORES_ENV]: fifo })).toEqual([]);
  });

  it('reads each store under its own cursors, and opens a record only from its own store', () => {
    const first = makeStore(sandbox('opencode-sandbox-0123456789abcdef'), 'first prompt');
    const second = makeStore(sandbox('opencode-sandbox-fedcba9876543210'), 'second prompt');
    const source = createOpenCodeStoreSource();
    const env = { [OPENCODE_EXTRA_STORES_ENV]: sandboxPattern() };
    const paths = source.locateAll({ userHome: home(), env });
    expect(paths).toEqual([first.path, second.path]);

    const results = paths.map((path) => {
      const cursors = new Map<string, StoreCursor>();
      const result = source.poll({
        path,
        activeSinceMs: 0,
        cursors,
        observedAt: '2026-10-02T13:00:00.000Z',
        maxRecordBytes: 8 * 1024 * 1024,
        rowBudget: 500,
      });
      return { path, batches: result.batches };
    });
    const [a, b] = results;
    if (!a || !b) throw new Error('expected two stores');
    expect(a.batches).toHaveLength(1);
    expect(b.batches).toHaveLength(1);
    const ca = a.batches[0]?.cursor;
    const cb = b.batches[0]?.cursor;
    expect(ca?.key.startsWith(`${first.path}#`)).toBe(true);
    expect(cb?.key.startsWith(`${second.path}#`)).toBe(true);
    // Resolution stays by OpenCode's own session id.
    expect(ca?.sessionId).toBe(makeSessionId(OPENCODE_PROVIDER_ID, ca?.providerSessionId ?? ''));
    expect(ca?.sessionId).not.toBe(cb?.sessionId);

    const prompts = results.map(({ batches }) =>
      batches
        .flatMap((batch) => batch.events)
        .flatMap((event) => (event.kind === 'turn.started' ? [event.prompt] : [])),
    );
    expect(prompts).toEqual([['first prompt'], ['second prompt']]);

    const turn = b.batches[0]?.events.find((event) => event.kind === 'turn.started');
    const ref = turn?.source.ref;
    if (!ref) throw new Error('expected a source reference');
    expect(ref.path).toBe(second.path);
    // The record's own store opens it; any other store refuses it.
    expect(source.readRawRecord(second.path, ref).raw).toEqual(expect.any(String));
    expect(source.readRawRecord(first.path, ref)).toEqual({
      raw: undefined,
      reason: 'the OpenCode store has moved since this was recorded',
    });
  });
});
