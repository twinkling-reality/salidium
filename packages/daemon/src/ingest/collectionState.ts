import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { CollectionGapEpisode, CollectionStatus } from '@salidium/protocol';
import type { RetentionDays } from '../storage/salidiumStore.ts';
import {
  COLLECTION_GAP_LEDGER_FILE,
  readCollectionGapLedger,
  recordCollectionGap,
} from './collectionGaps.ts';
import {
  HOOK_BREAKER_FILE,
  HOOK_PAUSE_FILE,
  HOOK_PAUSE_LEASE_MS,
  HOOK_SHED_FIRST_FILE,
  HOOK_SHED_RETAIN_FILE,
  HOOK_SHED_SECOND_FILE,
} from './limits.ts';

export interface CollectionPause {
  version: 1;
  pausedAt: string;
  expiresAt: string;
  reason: 'manual' | 'stop';
}

export function pauseCollection(
  home: string,
  reason: CollectionPause['reason'] = 'manual',
  now = new Date(),
): CollectionPause {
  const previous = readCollectionPause(home);
  if (!previous && existsSync(join(home, HOOK_PAUSE_FILE)))
    recordCollectionGap(
      join(home, COLLECTION_GAP_LEDGER_FILE),
      {
        reason: 'collection-pause-marker-invalid',
        provider: null,
        event: null,
        pressure: null,
        firstDroppedAt: null,
        exactCount: null,
      },
      now.toISOString(),
    );
  const pause: CollectionPause = {
    version: 1,
    pausedAt: previous?.pausedAt ?? now.toISOString(),
    expiresAt: new Date(now.getTime() + HOOK_PAUSE_LEASE_MS).toISOString(),
    reason: previous?.reason === 'stop' || reason === 'stop' ? 'stop' : 'manual',
  };
  writePrivateJson(join(home, HOOK_PAUSE_FILE), pause);
  return pause;
}

export function readCollectionPause(home: string): CollectionPause | undefined {
  const path = join(home, HOOK_PAUSE_FILE);
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<CollectionPause>;
    if (
      value.version !== 1 ||
      typeof value.pausedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.pausedAt)) ||
      typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      (value.reason !== 'manual' && value.reason !== 'stop')
    )
      return undefined;
    return value as CollectionPause;
  } catch {
    return undefined;
  }
}

export function resumeCollection(home: string, now = new Date()): boolean {
  const path = join(home, HOOK_PAUSE_FILE);
  if (!existsSync(path)) return false;
  const pause = readCollectionPause(home);
  recordCollectionGap(
    join(home, COLLECTION_GAP_LEDGER_FILE),
    {
      reason: pause
        ? pause.reason === 'stop'
          ? 'collection-stopped'
          : 'collection-paused'
        : 'collection-pause-marker-invalid',
      provider: null,
      event: null,
      pressure: null,
      firstDroppedAt: pause?.pausedAt ?? null,
      exactCount: null,
    },
    now.toISOString(),
  );
  unlinkSync(path);
  return true;
}

export function expireCollectionPause(home: string, now = new Date()): boolean {
  const pause = readCollectionPause(home);
  if (!pause || Date.parse(pause.expiresAt) > now.getTime()) return false;
  return resumeCollection(home, now);
}

export function observeCollectionStatus(args: {
  home: string;
  retention: RetentionDays | null;
  lastIngestAt?: string;
  daemonReachable: boolean;
  anyHooksConfigured: boolean;
  queue?: CollectionStatus['queue'];
  now?: Date;
}): CollectionStatus {
  const now = args.now ?? new Date();
  const pause = readCollectionPause(args.home);
  const pauseMarkerExists = existsSync(join(args.home, HOOK_PAUSE_FILE));
  const queue = args.queue ?? observeQueue(join(args.home, 'spool', 'pending'));
  const active = [
    HOOK_SHED_FIRST_FILE,
    HOOK_SHED_SECOND_FILE,
    HOOK_SHED_RETAIN_FILE,
    HOOK_BREAKER_FILE,
  ].flatMap((file) => readActiveGap(join(args.home, file)) ?? []);
  const ledger = readCollectionGapLedger(join(args.home, COLLECTION_GAP_LEDGER_FILE));
  const db = join(args.home, 'salidium.db');
  let storeBytes: number | null = null;
  try {
    storeBytes = statSync(db).size;
  } catch {
    /* Absence is reported as unavailable, not zero. */
  }
  const runaway = !args.daemonReachable && args.anyHooksConfigured && queue.files > 0;
  return {
    observedAt: now.toISOString(),
    state: pauseMarkerExists ? 'paused' : 'active',
    pause: pause
      ? { pausedAt: pause.pausedAt, expiresAt: pause.expiresAt, reason: pause.reason }
      : null,
    queue,
    store: {
      bytes: storeBytes,
      retention: args.retention,
      lastIngestAt: args.lastIngestAt ?? null,
    },
    health: runaway ? 'runaway' : active.length > 0 ? 'attention' : 'healthy',
    gaps: {
      active,
      recovered: ledger.episodes,
      omittedEpisodes: ledger.omittedEpisodes,
    },
  };
}

function observeQueue(path: string): CollectionStatus['queue'] {
  if (!existsSync(path)) return { files: 0, bytes: 0, oldestAt: null };
  let files = 0;
  let bytes = 0;
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const name of readdirSync(path)) {
    if (!name.endsWith('.json') && !name.endsWith('.json.processing')) continue;
    try {
      const stats = statSync(join(path, name));
      if (!stats.isFile()) continue;
      files++;
      bytes += stats.size;
      oldestMs = Math.min(oldestMs, stats.mtimeMs);
    } catch {
      /* A concurrently drained entry is absent from this observation. */
    }
  }
  return {
    files,
    bytes,
    oldestAt: Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null,
  };
}

function readActiveGap(path: string): CollectionGapEpisode | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return {
      reason: typeof value.reason === 'string' ? value.reason : 'pressure-marker-invalid',
      provider: typeof value.provider === 'string' ? value.provider : null,
      event: typeof value.event === 'string' ? value.event : null,
      pressure: typeof value.pressure === 'string' ? value.pressure : null,
      firstDroppedAt:
        typeof value.firstDroppedAt === 'string' &&
        Number.isFinite(Date.parse(value.firstDroppedAt))
          ? new Date(value.firstDroppedAt).toISOString()
          : null,
      recoveredAt: null,
      exactCount: null,
    };
  } catch {
    return {
      reason: 'pressure-marker-invalid',
      provider: null,
      event: null,
      pressure: null,
      firstDroppedAt: null,
      recoveredAt: null,
      exactCount: null,
    };
  }
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Keep the original write failure. */
    }
    throw error;
  }
}
