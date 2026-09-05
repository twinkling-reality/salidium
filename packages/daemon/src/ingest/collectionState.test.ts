import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COLLECTION_GAP_LEDGER_FILE, readCollectionGapLedger } from './collectionGaps.ts';
import {
  expireCollectionPause,
  observeCollectionStatus,
  pauseCollection,
  readCollectionPause,
} from './collectionState.ts';
import { HOOK_PAUSE_FILE, HOOK_SHED_FIRST_FILE } from './limits.ts';

const homes: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-collection-state-'));
  homes.push(path);
  return path;
}

afterEach(async () => {
  for (const path of homes.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('collection state', () => {
  it('writes a private 24 hour lease and expires it only after its deadline', () => {
    const dir = home();
    const now = new Date('2026-09-04T12:00:00.000Z');
    const pause = pauseCollection(dir, 'manual', now);
    expect(pause).toEqual({
      version: 1,
      pausedAt: '2026-09-04T12:00:00.000Z',
      expiresAt: '2026-09-05T12:00:00.000Z',
      reason: 'manual',
    });
    expect(statSync(join(dir, HOOK_PAUSE_FILE)).mode & 0o777).toBe(0o600);
    expect(expireCollectionPause(dir, new Date('2026-09-05T11:59:59.999Z'))).toBe(false);
    expect(readCollectionPause(dir)).toEqual(pause);
    expect(expireCollectionPause(dir, new Date('2026-09-05T12:00:00.000Z'))).toBe(true);
    expect(readCollectionPause(dir)).toBeUndefined();
    expect(readCollectionGapLedger(join(dir, COLLECTION_GAP_LEDGER_FILE)).episodes).toEqual([
      {
        reason: 'collection-paused',
        provider: null,
        event: null,
        pressure: null,
        firstDroppedAt: '2026-09-04T12:00:00.000Z',
        recoveredAt: '2026-09-05T12:00:00.000Z',
        exactCount: null,
      },
    ]);
  });

  it('reports exact current file cost and a runaway condition without guessing drop counts', () => {
    const dir = home();
    const pending = join(dir, 'spool', 'pending');
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, 'one.ready.json'), '1234');
    writeFileSync(join(pending, 'two.ready.json.processing'), '12');
    writeFileSync(join(pending, 'ignored.txt'), 'not an envelope');
    writeFileSync(
      join(dir, HOOK_SHED_FIRST_FILE),
      `${JSON.stringify({
        reason: 'pressure',
        provider: 'claude-code',
        event: 'PreToolUse',
        pressure: 'shed-first',
        firstDroppedAt: '2026-09-04T11:00:00.000Z',
        exactCount: null,
      })}\n`,
    );
    const status = observeCollectionStatus({
      home: dir,
      retention: null,
      daemonReachable: false,
      anyHooksConfigured: true,
      now: new Date('2026-09-04T12:00:00.000Z'),
    });
    expect(status.queue).toMatchObject({ files: 2, bytes: 6 });
    expect(status.health).toBe('runaway');
    expect(status.store.retention).toBeNull();
    expect(status.gaps.active).toEqual([
      expect.objectContaining({ event: 'PreToolUse', exactCount: null, recoveredAt: null }),
    ]);
  });

  it('treats an unreadable marker as paused instead of silently collecting', () => {
    const dir = home();
    writeFileSync(join(dir, HOOK_PAUSE_FILE), '{not json');
    const status = observeCollectionStatus({
      home: dir,
      retention: 'forever',
      daemonReachable: true,
      anyHooksConfigured: false,
    });
    expect(status.state).toBe('paused');
    expect(status.pause).toBeNull();
    expect(readFileSync(join(dir, HOOK_PAUSE_FILE), 'utf8')).toBe('{not json');

    const replaced = pauseCollection(dir, 'manual', new Date('2026-09-04T13:00:00.000Z'));
    expect(replaced.pausedAt).toBe('2026-09-04T13:00:00.000Z');
    expect(readCollectionGapLedger(join(dir, COLLECTION_GAP_LEDGER_FILE)).episodes).toEqual([
      expect.objectContaining({
        reason: 'collection-pause-marker-invalid',
        firstDroppedAt: null,
        recoveredAt: '2026-09-04T13:00:00.000Z',
      }),
    ]);
  });
});
