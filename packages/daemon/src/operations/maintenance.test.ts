import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MaintenanceState } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_PAUSE_FILE } from '../ingest/limits.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import {
  acquireMaintenanceLock,
  maintenancePaths,
  readMaintenanceState,
  runQueueDrainMaintenance,
  runRetentionCompactionMaintenance,
  runStorageOptimizationMaintenance,
  storageOptimizationPreflight,
  transitionMaintenance,
} from './maintenance.ts';

const directories: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-maintenance-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function state(phase: MaintenanceState['phase']): MaintenanceState {
  return {
    version: 1,
    operationId: 'operation-1',
    kind: 'storage-optimize',
    phase,
    startedAt: '2026-09-04T10:00:00.000Z',
    updatedAt: '2026-09-04T10:00:00.000Z',
    progress: 0.5,
    message: phase,
  };
}

describe('maintenance state and coordination', () => {
  it('accepts declared transitions and rejects ambiguous jumps', () => {
    expect(
      transitionMaintenance(state('checkpoint'), 'optimize', {
        now: new Date('2026-09-04T10:01:00.000Z'),
        progress: 0.4,
        message: 'copying',
      }),
    ).toMatchObject({ phase: 'optimize', progress: 0.4, message: 'copying' });
    expect(() =>
      transitionMaintenance(state('checkpoint'), 'resume', { message: 'skip verification' }),
    ).toThrow(/invalid maintenance transition/);
  });

  it('rejects a live lock and converts a stale lock into explicit recovery state', () => {
    const dir = home();
    const first = acquireMaintenanceLock(dir);
    expect(() => acquireMaintenanceLock(dir)).toThrow(/already running/);
    writeFileSync(maintenancePaths(dir).state, `${JSON.stringify(state('optimize'))}\n`);

    const recovered = acquireMaintenanceLock(dir, {
      now: new Date('2026-09-04T11:00:00.000Z'),
      isProcessAlive: () => false,
    });
    expect(recovered.recovered).toMatchObject({ phase: 'recovery', resumedFrom: 'optimize' });
    expect(readMaintenanceState(dir)).toMatchObject({ phase: 'recovery' });
    recovered.release();
    expect(existsSync(maintenancePaths(dir).lock)).toBe(false);
    void first;
  });

  it('runs one bounded queue drain and reports before and after without reading payloads', () => {
    const dir = home();
    const pendingDir = join(dir, 'spool', 'pending');
    mkdirSync(pendingDir, { recursive: true });
    const pending = join(pendingDir, 'codex_1.ready.json');
    writeFileSync(pending, '{private payload}');

    const result = runQueueDrainMaintenance(dir, () => unlinkSync(pending));

    expect(result.before.totalFiles).toBe(1);
    expect(result.after.totalFiles).toBe(0);
    expect(result.state.phase).toBe('completed');
    expect(JSON.stringify(result)).not.toContain('private payload');
  });

  it('preserves queued input on failure and allows a later bounded retry', () => {
    const dir = home();
    const pendingDir = join(dir, 'spool', 'pending');
    mkdirSync(pendingDir, { recursive: true });
    const pending = join(pendingDir, 'codex_1.ready.json');
    writeFileSync(pending, '{private payload}');

    expect(() =>
      runQueueDrainMaintenance(dir, () => {
        throw new Error('temporary store failure');
      }),
    ).toThrow(/temporary store failure/);
    expect(existsSync(pending)).toBe(true);
    expect(readMaintenanceState(dir)).toMatchObject({
      kind: 'queue-drain',
      phase: 'failure',
      failure: 'temporary store failure',
    });
    expect(existsSync(maintenancePaths(dir).lock)).toBe(false);

    const retried = runQueueDrainMaintenance(dir, () => unlinkSync(pending));
    expect(retried.state.phase).toBe('completed');
    expect(retried.after.totalFiles).toBe(0);
  });

  it('bounds persisted failures and releases the lock even when state publication fails', () => {
    const dir = home();
    expect(() =>
      runQueueDrainMaintenance(dir, () => {
        throw new Error('x'.repeat(1_100));
      }),
    ).toThrow();
    expect(readMaintenanceState(dir)?.failure).toHaveLength(1_000);
    expect(existsSync(maintenancePaths(dir).lock)).toBe(false);

    const broken = home();
    mkdirSync(maintenancePaths(broken).state, { recursive: true });
    expect(() => runQueueDrainMaintenance(broken, () => {})).toThrow();
    expect(existsSync(maintenancePaths(broken).lock)).toBe(false);
  });

  it('records offline retention compaction through the shared maintenance contract', () => {
    const dir = home();
    let compacted = 0;
    const completed = runRetentionCompactionMaintenance(dir, () => {
      compacted += 1;
    });
    expect(compacted).toBe(1);
    expect(completed).toMatchObject({ kind: 'retention-compact', phase: 'completed', progress: 1 });

    expect(() =>
      runRetentionCompactionMaintenance(dir, () => {
        throw new Error('integrity failed');
      }),
    ).toThrow('integrity failed');
    expect(readMaintenanceState(dir)).toMatchObject({
      kind: 'retention-compact',
      phase: 'failure',
      failure: 'integrity failed',
    });
  });

  it('preflights queued work as a blocker and never pauses collection on refusal', () => {
    const dir = home();
    new SqliteStore(join(dir, 'salidium.db'), { pageSize: 4096 }).close();
    const pendingDir = join(dir, 'spool', 'pending');
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(join(pendingDir, 'codex_1.ready.json'), '{}');

    const preview = storageOptimizationPreflight(dir);
    expect(preview.canRun).toBe(false);
    expect(preview.blockers).toContain('the durable queue must be drained before the daemon stops');
    expect(() => runStorageOptimizationMaintenance(dir)).toThrow(/preflight blocked/);
    expect(existsSync(join(dir, HOOK_PAUSE_FILE))).toBe(false);
  });

  it('preflights an incomplete historical-usage migration before pausing collection', () => {
    const dir = home();
    const path = join(dir, 'salidium.db');
    new SqliteStore(path, { pageSize: 4096 }).close();
    const database = new DatabaseSync(path);
    try {
      database.exec('UPDATE usage_backfill_state SET complete = 0 WHERE singleton = 1');
    } finally {
      database.close();
    }

    const preview = storageOptimizationPreflight(dir);
    expect(preview.canRun).toBe(false);
    expect(preview.blockers).toContain(
      'historical usage preparation must finish before optimization',
    );
    expect(() => runStorageOptimizationMaintenance(dir)).toThrow(/historical usage preparation/);
    expect(existsSync(join(dir, HOOK_PAUSE_FILE))).toBe(false);
  });

  it('is idempotent for an already optimized store and records a completed workflow', () => {
    const dir = home();
    new SqliteStore(join(dir, 'salidium.db')).close();

    expect(runStorageOptimizationMaintenance(dir).alreadyOptimized).toBe(true);
    expect(readMaintenanceState(dir)).toMatchObject({
      kind: 'storage-optimize',
      phase: 'completed',
      progress: 1,
    });
    expect(existsSync(join(dir, HOOK_PAUSE_FILE))).toBe(false);
  });
});
