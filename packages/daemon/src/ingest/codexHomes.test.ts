import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CODEX_EXTRA_HOMES_ENV, codexAdapter, codexHomes } from '@salidium/adapter-codex';
import { makeSessionId } from '@salidium/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSyntheticRollout } from '../../../adapters/codex/src/testing/syntheticRollout.ts';
import { createLogger } from '../logging/logger.ts';
import { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { TranscriptTailer } from './transcriptTailer.ts';

/*
 * Extra Codex homes: a local tool that runs Codex in homes of its own (one open home, and one
 * confined home per execution folder under a directory of homes) names them in
 * SALIDIUM_EXTRA_CODEX_HOMES, and Salidium reads their rollouts beside the person's own.
 */

let tmp: string;
let home: string;
let store: SqliteStore;
let registry: SessionRegistry;
let tailer: TranscriptTailer | undefined;

const THREADS = {
  own: '01a00b4a-d527-75c2-bb45-000000000001',
  open: '01a00b4a-d527-75c2-bb45-000000000002',
  confinedA: '01a00b4a-d527-75c2-bb45-000000000003',
  confinedB: '01a00b4a-d527-75c2-bb45-000000000004',
  linked: '01a00b4a-d527-75c2-bb45-000000000005',
};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'salidium-codex-homes-')));
  home = join(tmp, 'home');
  mkdirSync(home);
  store = new SqliteStore(join(tmp, 'db.sqlite'));
  registry = new SessionRegistry(store);
});

afterEach(() => {
  tailer?.stop();
  tailer = undefined;
  delete process.env[CODEX_EXTRA_HOMES_ENV];
  registry.close();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Writes a rollout for `threadId` in `codexHome`, dated now so it is inside the history window. */
function writeRollout(codexHome: string, threadId: string): void {
  const now = new Date();
  const day = join(
    codexHome,
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  );
  mkdirSync(day, { recursive: true });
  const { lines } = buildSyntheticRollout({ threadId });
  writeFileSync(
    join(day, `rollout-2026-08-16T15-57-00-${threadId}.jsonl`),
    `${lines.join('\n')}\n`,
  );
}

function observed(threadId: string): boolean {
  return registry.eventsAfter(makeSessionId('codex', threadId), -1).length > 0;
}

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

describe('extra Codex homes', () => {
  it('reads only CODEX_HOME, else ~/.codex, when the setting is absent', () => {
    expect(codexHomes(home, {})).toEqual([join(home, '.codex')]);
    expect(codexHomes(home, { CODEX_HOME: '/elsewhere/codex' })).toEqual(['/elsewhere/codex']);
    expect(codexHomes(home, { [CODEX_EXTRA_HOMES_ENV]: '' })).toEqual([join(home, '.codex')]);
    expect(codexAdapter.sessionRoots(home)).toEqual([
      join(home, '.codex', 'sessions'),
      join(home, '.codex', 'archived_sessions'),
    ]);
  });

  it('keeps the default home first and adds each extra home once', () => {
    const open = join(tmp, 'tool', 'codex-home');
    const env = { [CODEX_EXTRA_HOMES_ENV]: `${open}:${open}:${join(home, '.codex')}` };
    expect(codexHomes(home, env)).toEqual([join(home, '.codex'), open]);
  });

  it.skipIf(process.platform === 'win32')(
    'expands a directory of homes to its real folders only',
    () => {
      const confined = join(tmp, 'tool', 'codex-confined');
      mkdirSync(join(confined, '0123456789abcdef'), { recursive: true });
      mkdirSync(join(confined, 'fedcba9876543210'));
      mkdirSync(join(tmp, 'outside'));
      symlinkSync(join(tmp, 'outside'), join(confined, '00000000000000aa'));
      expect(codexHomes(home, { [CODEX_EXTRA_HOMES_ENV]: join(confined, '*') })).toEqual([
        join(home, '.codex'),
        join(confined, '0123456789abcdef'),
        join(confined, 'fedcba9876543210'),
      ]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tails a second home and a directory of homes, including a home made after start',
    async () => {
      const open = join(tmp, 'tool', 'codex-home');
      const confined = join(tmp, 'tool', 'codex-confined');
      mkdirSync(confined, { recursive: true });
      writeRollout(join(home, '.codex'), THREADS.own);
      writeRollout(open, THREADS.open);
      writeRollout(join(confined, '0123456789abcdef'), THREADS.confinedA);
      // A rollout behind a link in the directory of homes is never read.
      writeRollout(join(tmp, 'outside'), THREADS.linked);
      symlinkSync(join(tmp, 'outside'), join(confined, '00000000000000aa'));
      process.env[CODEX_EXTRA_HOMES_ENV] = `${open}:${join(confined, '*')}`;

      tailer = new TranscriptTailer({
        adapters: [codexAdapter],
        registry,
        store,
        log: createLogger('silent'),
        rootDiscoveryIntervalMs: 20,
      });
      await tailer.start(home, 30);
      expect(observed(THREADS.own)).toBe(true);
      expect(observed(THREADS.open)).toBe(true);
      expect(observed(THREADS.confinedA)).toBe(true);

      // The tool makes a new confined home for a new execution folder while the daemon runs.
      writeRollout(join(confined, 'fedcba9876543210'), THREADS.confinedB);
      await until(() => observed(THREADS.confinedB));

      await sleep(100);
      expect(observed(THREADS.linked)).toBe(false);
    },
  );

  it('reads only the default Codex home when the setting is absent', async () => {
    writeRollout(join(home, '.codex'), THREADS.own);
    writeRollout(join(tmp, 'tool', 'codex-home'), THREADS.open);
    tailer = new TranscriptTailer({
      adapters: [codexAdapter],
      registry,
      store,
      log: createLogger('silent'),
      rootDiscoveryIntervalMs: 20,
    });
    await tailer.start(home, 30);
    expect(observed(THREADS.own)).toBe(true);
    expect(observed(THREADS.open)).toBe(false);
  });
});
