import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MaintenancePhase, MaintenanceState, QueueInspection } from '@salidium/protocol';
import { MaintenanceStateSchema } from '@salidium/protocol';
import {
  pauseCollection,
  readCollectionPause,
  resumeCollection,
} from '../ingest/collectionState.ts';
import {
  inspectStoreLayout,
  optimizeStoreLayout,
  type StoreLayoutInspection,
  type StoreOptimizationResult,
  storeOptimizationRequiredFreeBytes,
} from '../storage/optimizeStore.ts';
import { SCHEMA_VERSION, SqliteStore } from '../storage/sqliteStore.ts';
import { readJsonFile, writePrivateJsonAtomic } from './files.ts';
import { inspectQueue } from './health.ts';

const TRANSITIONS: Readonly<Record<MaintenancePhase, readonly MaintenancePhase[]>> = {
  idle: ['pause', 'drain'],
  pause: ['drain', 'failure'],
  drain: ['checkpoint', 'completed', 'failure'],
  checkpoint: ['optimize', 'failure'],
  optimize: ['verify', 'failure'],
  verify: ['resume', 'failure'],
  resume: ['completed', 'failure'],
  completed: [],
  failure: ['recovery'],
  recovery: [
    'pause',
    'drain',
    'checkpoint',
    'optimize',
    'verify',
    'resume',
    'completed',
    'failure',
  ],
};

function boundedFailure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

export function maintenancePaths(home: string) {
  return {
    state: join(home, 'maintenance.json'),
    previous: join(home, 'maintenance.previous.json'),
    lock: join(home, 'maintenance.lock'),
    owner: join(home, 'maintenance.lock', 'owner.json'),
  };
}

export function transitionMaintenance(
  current: MaintenanceState,
  phase: MaintenancePhase,
  options: {
    now?: Date;
    progress?: number | null;
    message: string;
    failure?: string;
  },
): MaintenanceState {
  if (!TRANSITIONS[current.phase].includes(phase))
    throw new Error(`invalid maintenance transition: ${current.phase} -> ${phase}`);
  return MaintenanceStateSchema.parse({
    ...current,
    phase,
    updatedAt: (options.now ?? new Date()).toISOString(),
    progress: options.progress ?? null,
    message: options.message,
    ...(options.failure ? { failure: options.failure } : {}),
  });
}

export function readMaintenanceState(home: string, now = new Date()): MaintenanceState | null {
  const path = maintenancePaths(home).state;
  if (!existsSync(path)) return null;
  try {
    return MaintenanceStateSchema.parse(readJsonFile(path));
  } catch {
    return {
      version: 1,
      operationId: 'unreadable-state',
      kind: 'storage-optimize',
      phase: 'recovery',
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      progress: null,
      message:
        'Maintenance state is unreadable; inspect the local state directory before retrying.',
      resumedFrom: 'failure',
      failure: 'maintenance.json did not satisfy the version 1 contract',
    };
  }
}

function writeState(home: string, state: MaintenanceState): void {
  const paths = maintenancePaths(home);
  writePrivateJsonAtomic(paths.state, state, { previousPath: paths.previous });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface LockOwner {
  version: 1;
  operationId: string;
  pid: number;
  acquiredAt: string;
}

export interface MaintenanceLock {
  owner: LockOwner;
  recovered?: MaintenanceState;
  release(): void;
}

/** Atomic directory creation is the cross-process lock; the owner file is recovery metadata. */
export function acquireMaintenanceLock(
  home: string,
  options: { now?: Date; isProcessAlive?: (pid: number) => boolean } = {},
): MaintenanceLock {
  const now = options.now ?? new Date();
  const paths = maintenancePaths(home);
  const isAlive = options.isProcessAlive ?? processAlive;
  let recovered: MaintenanceState | undefined;
  try {
    mkdirSync(paths.lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner: Partial<LockOwner> | undefined;
    try {
      owner = JSON.parse(readFileSync(paths.owner, 'utf8')) as Partial<LockOwner>;
    } catch {
      /* An ownerless lock is stale: mkdir completed but its metadata did not. */
    }
    if (typeof owner?.pid === 'number' && isAlive(owner.pid))
      throw new Error(`maintenance is already running in process ${owner.pid}`);

    const prior = readMaintenanceState(home, now);
    if (prior && prior.phase !== 'completed') {
      recovered = MaintenanceStateSchema.parse({
        ...prior,
        phase: 'recovery',
        updatedAt: now.toISOString(),
        progress: null,
        message: `Recovered a stale maintenance lock left during ${prior.phase}.`,
        resumedFrom: prior.phase,
      });
      writeState(home, recovered);
    }
    rmSync(paths.lock, { recursive: true, force: true });
    mkdirSync(paths.lock, { mode: 0o700 });
  }

  const owner: LockOwner = {
    version: 1,
    operationId: randomBytes(12).toString('hex'),
    pid: process.pid,
    acquiredAt: now.toISOString(),
  };
  writePrivateJsonAtomic(paths.owner, owner);
  let released = false;
  return {
    owner,
    ...(recovered ? { recovered } : {}),
    release() {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(readFileSync(paths.owner, 'utf8')) as Partial<LockOwner>;
        if (current.operationId !== owner.operationId)
          throw new Error('maintenance lock ownership changed before release');
      } catch (error) {
        if (!existsSync(paths.owner)) return;
        throw error;
      }
      rmSync(paths.lock, { recursive: true, force: true });
    },
  };
}

function beginState(
  kind: MaintenanceState['kind'],
  operationId: string,
  phase: Extract<MaintenancePhase, 'pause' | 'drain'>,
  now: Date,
  message: string,
): MaintenanceState {
  return MaintenanceStateSchema.parse({
    version: 1,
    operationId,
    kind,
    phase,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    progress: 0,
    message,
  });
}

export interface QueueDrainResult {
  state: MaintenanceState;
  before: QueueInspection;
  after: QueueInspection;
}

/** Records offline VACUUM under the same durable lock and recovery state as other maintenance. */
export function runRetentionCompactionMaintenance(
  home: string,
  compact: () => void,
  options: { now?: () => Date; onState?: (state: MaintenanceState) => void } = {},
): MaintenanceState {
  const clock = options.now ?? (() => new Date());
  const lock = acquireMaintenanceLock(home, { now: clock() });
  let state = beginState(
    'retention-compact',
    lock.owner.operationId,
    'drain',
    clock(),
    'Checking and compacting reusable SQLite pages in the offline store.',
  );
  const publish = () => {
    writeState(home, state);
    options.onState?.(state);
  };
  try {
    publish();
    compact();
    state = transitionMaintenance(state, 'completed', {
      now: clock(),
      progress: 1,
      message: 'Offline retention compaction completed and SQLite integrity passed.',
    });
    publish();
    return state;
  } catch (error) {
    state = transitionMaintenance(state, 'failure', {
      now: clock(),
      message: 'Retention compaction failed; SQLite preserved the pre-operation store.',
      failure: boundedFailure(error),
    });
    try {
      publish();
    } catch {
      /* Preserve the compaction failure and release the live-owner lock below. */
    }
    throw error;
  } finally {
    lock.release();
  }
}

/** One idempotent bounded drain pass; callers can repeat it while `after.totalFiles` is nonzero. */
export function runQueueDrainMaintenance(
  home: string,
  drain: () => void,
  options: { now?: () => Date; onState?: (state: MaintenanceState) => void } = {},
): QueueDrainResult {
  const clock = options.now ?? (() => new Date());
  const lock = acquireMaintenanceLock(home, { now: clock() });
  let state = beginState(
    'queue-drain',
    lock.owner.operationId,
    'drain',
    clock(),
    'Inspecting the durable queue before one bounded drain pass.',
  );
  const publish = () => {
    writeState(home, state);
    options.onState?.(state);
  };
  try {
    publish();
    const before = inspectQueue(home, { now: clock() });
    drain();
    const after = inspectQueue(home, { now: clock() });
    state = transitionMaintenance(state, 'completed', {
      now: clock(),
      progress: 1,
      message:
        after.totalFiles === 0
          ? 'The durable queue is empty.'
          : `One bounded pass completed; ${after.totalFiles ?? 'an unknown number of'} files remain.`,
    });
    publish();
    return { state, before, after };
  } catch (error) {
    state = transitionMaintenance(state, 'failure', {
      now: clock(),
      message: 'Queue draining stopped; unprocessed files remain durable.',
      failure: boundedFailure(error),
    });
    try {
      publish();
    } catch {
      /* Preserve the original failure and release the live-owner lock below. */
    }
    throw error;
  } finally {
    lock.release();
  }
}

export interface StorageOptimizationPreflight {
  dryRun: true;
  layout: StoreLayoutInspection;
  queue: QueueInspection;
  beforeBytes: number;
  availableBytes: number;
  requiredFreeBytes: number;
  canRun: boolean;
  blockers: string[];
}

export function storageOptimizationPreflight(home: string): StorageOptimizationPreflight {
  const path = join(home, 'salidium.db');
  const layout = inspectStoreLayout(path);
  const queue = inspectQueue(home);
  const beforeBytes = statBytes(path) + statBytes(`${path}-wal`);
  const filesystem = statfsSync(home);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const requiredFreeBytes = storeOptimizationRequiredFreeBytes(beforeBytes);
  const blockers: string[] = [];
  if (!layout.optimized) {
    if (layout.schemaVersion !== SCHEMA_VERSION) {
      blockers.push(
        `store schema ${layout.schemaVersion ?? 'unknown'} must be upgraded to ${SCHEMA_VERSION}`,
      );
    } else {
      const inspection = new SqliteStore(path, { readOnly: true });
      try {
        if (!inspection.usageBackfillProgress().complete)
          blockers.push('historical usage preparation must finish before optimization');
      } finally {
        inspection.close();
      }
    }
    if (!queue.exactTotals) blockers.push('queue totals are unavailable');
    else if ((queue.totalFiles ?? 0) > 0)
      blockers.push('the durable queue must be drained before the daemon stops');
    if (availableBytes < requiredFreeBytes)
      blockers.push(
        `storage needs ${requiredFreeBytes} free bytes; ${availableBytes} are available`,
      );
  }
  return {
    dryRun: true,
    layout,
    queue,
    beforeBytes,
    availableBytes,
    requiredFreeBytes,
    canRun: blockers.length === 0,
    blockers,
  };
}

function statBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function checkpointStore(path: string): void {
  const db = new DatabaseSync(path);
  try {
    const check = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
    if (String(check ? Object.values(check)[0] : '') !== 'ok')
      throw new Error('store failed integrity_check before optimization');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

export function runStorageOptimizationMaintenance(
  home: string,
  options: {
    now?: () => Date;
    onState?: (state: MaintenanceState) => void;
    onProgress?: (message: string) => void;
  } = {},
): StoreOptimizationResult {
  const clock = options.now ?? (() => new Date());
  const preflight = storageOptimizationPreflight(home);
  if (!preflight.canRun)
    throw new Error(`maintenance preflight blocked: ${preflight.blockers.join('; ')}`);
  const lock = acquireMaintenanceLock(home, { now: clock() });
  if (preflight.layout.optimized) {
    try {
      const result = optimizeStoreLayout(join(home, 'salidium.db'), { now: clock() });
      const completed = MaintenanceStateSchema.parse({
        version: 1,
        operationId: lock.owner.operationId,
        kind: 'storage-optimize',
        phase: 'completed',
        startedAt: clock().toISOString(),
        updatedAt: clock().toISOString(),
        progress: 1,
        message: 'Storage is already optimized; collection and the durable queue were unchanged.',
      });
      writeState(home, completed);
      options.onState?.(completed);
      return result;
    } finally {
      lock.release();
    }
  }
  const wasPaused = Boolean(readCollectionPause(home));
  let state = beginState(
    'storage-optimize',
    lock.owner.operationId,
    'pause',
    clock(),
    'Pausing collection before offline storage work.',
  );
  const publish = () => {
    writeState(home, state);
    options.onState?.(state);
  };
  try {
    publish();
    if (!wasPaused) pauseCollection(home, 'manual', clock());
    const queueAfterPause = inspectQueue(home, { now: clock() });
    if (!queueAfterPause.exactTotals || (queueAfterPause.totalFiles ?? 0) > 0)
      throw new Error(
        queueAfterPause.exactTotals
          ? 'queued input arrived after preflight; drain it before retrying optimization'
          : 'queue totals became unavailable after preflight; optimization was not started',
      );
    state = transitionMaintenance(state, 'drain', {
      now: clock(),
      progress: 0.15,
      message: 'The durable queue is empty; no queued input will be part of the store replacement.',
    });
    publish();
    state = transitionMaintenance(state, 'checkpoint', {
      now: clock(),
      progress: 0.25,
      message: 'Checking integrity and folding the SQLite recovery log into the store.',
    });
    publish();
    checkpointStore(join(home, 'salidium.db'));
    state = transitionMaintenance(state, 'optimize', {
      now: clock(),
      progress: 0.35,
      message: 'Copying the store into the optimized layout.',
    });
    publish();
    const result = optimizeStoreLayout(join(home, 'salidium.db'), {
      now: clock(),
      onProgress: (message) => {
        options.onProgress?.(message);
        state = { ...state, updatedAt: clock().toISOString(), message };
        publish();
      },
    });
    state = transitionMaintenance(state, 'verify', {
      now: clock(),
      progress: 0.85,
      message: 'Row counts, logical digests, layout, and SQLite integrity matched.',
    });
    publish();
    state = transitionMaintenance(state, 'resume', {
      now: clock(),
      progress: 0.95,
      message: wasPaused
        ? 'Leaving collection paused because it was paused before maintenance.'
        : 'Resuming collection after verified replacement.',
    });
    publish();
    if (!wasPaused) resumeCollection(home, clock());
    state = transitionMaintenance(state, 'completed', {
      now: clock(),
      progress: 1,
      message: result.alreadyOptimized
        ? 'Storage was already optimized; no replacement was needed.'
        : 'Storage optimization completed and the verified replacement reopened.',
    });
    publish();
    return result;
  } catch (error) {
    if (!wasPaused) resumeCollection(home, clock());
    if (state.phase !== 'failure' && state.phase !== 'completed') {
      state = transitionMaintenance(state, 'failure', {
        now: clock(),
        message: 'Maintenance failed; queued input and the pre-operation store were preserved.',
        failure: boundedFailure(error),
      });
      try {
        publish();
      } catch {
        /* Preserve the original failure and release the live-owner lock below. */
      }
    }
    throw error;
  } finally {
    lock.release();
  }
}
