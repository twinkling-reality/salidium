import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const COLLECTION_GAP_LEDGER_FILE = 'collection-gaps.json';
const MAX_RETAINED_EPISODES = 100;

export interface CollectionGapEpisode {
  reason: string;
  provider: string | null;
  event: string | null;
  pressure: string | null;
  firstDroppedAt: string | null;
  recoveredAt: string;
  /** Null means loss was observed but concurrent drops were intentionally not guessed. */
  exactCount: null;
}

export interface CollectionGapLedger {
  version: 1;
  omittedEpisodes: number;
  episodes: CollectionGapEpisode[];
}

const EMPTY_LEDGER: CollectionGapLedger = { version: 1, omittedEpisodes: 0, episodes: [] };

export function readCollectionGapLedger(path: string): CollectionGapLedger {
  if (!existsSync(path)) return { ...EMPTY_LEDGER, episodes: [] };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<CollectionGapLedger>;
    if (value.version !== 1 || !Array.isArray(value.episodes))
      return { ...EMPTY_LEDGER, episodes: [] };
    const normalized = value.episodes.flatMap((episode) => normalizeEpisode(episode) ?? []);
    const episodes = normalized.slice(-MAX_RETAINED_EPISODES);
    const omitted =
      Number.isInteger(value.omittedEpisodes) && Number(value.omittedEpisodes) >= 0
        ? Number(value.omittedEpisodes)
        : 0;
    return {
      version: 1,
      omittedEpisodes: omitted + Math.max(0, normalized.length - episodes.length),
      episodes,
    };
  } catch {
    return { ...EMPTY_LEDGER, episodes: [] };
  }
}

/** Archives one pressure marker before removing it, so observed loss survives recovery. */
export function archiveCollectionGap(
  markerPath: string,
  ledgerPath: string,
  recoveredAt = new Date().toISOString(),
): void {
  const marker = readMarker(markerPath);
  recordCollectionGap(ledgerPath, marker, recoveredAt);
  unlinkSync(markerPath);
}

/** Records a completed interval whose exact missing-event count cannot be observed. */
export function recordCollectionGap(
  ledgerPath: string,
  gap: Omit<CollectionGapEpisode, 'recoveredAt'>,
  recoveredAt = new Date().toISOString(),
): void {
  const ledger = readCollectionGapLedger(ledgerPath);
  const next = [...ledger.episodes, { ...gap, recoveredAt }];
  const omitted = Math.max(0, next.length - MAX_RETAINED_EPISODES);
  const value: CollectionGapLedger = {
    version: 1,
    omittedEpisodes: ledger.omittedEpisodes + omitted,
    episodes: next.slice(-MAX_RETAINED_EPISODES),
  };
  writeLedger(ledgerPath, value);
}

function readMarker(path: string): Omit<CollectionGapEpisode, 'recoveredAt'> {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return {
      reason: typeof value.reason === 'string' ? value.reason : 'pressure-marker-invalid',
      provider: typeof value.provider === 'string' ? value.provider : null,
      event: typeof value.event === 'string' ? value.event : null,
      pressure: typeof value.pressure === 'string' ? value.pressure : null,
      firstDroppedAt: typeof value.firstDroppedAt === 'string' ? value.firstDroppedAt : null,
      exactCount: null,
    };
  } catch {
    return {
      reason: 'pressure-marker-invalid',
      provider: null,
      event: null,
      pressure: null,
      firstDroppedAt: null,
      exactCount: null,
    };
  }
}

function normalizeEpisode(value: unknown): CollectionGapEpisode | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const episode = value as Record<string, unknown>;
  if (
    typeof episode.reason !== 'string' ||
    typeof episode.recoveredAt !== 'string' ||
    !Number.isFinite(Date.parse(episode.recoveredAt)) ||
    episode.exactCount !== null ||
    !nullableString(episode.provider) ||
    !nullableString(episode.event) ||
    !nullableString(episode.pressure) ||
    !nullableTimestamp(episode.firstDroppedAt)
  )
    return undefined;
  return {
    reason: episode.reason,
    provider: episode.provider,
    event: episode.event,
    pressure: episode.pressure,
    firstDroppedAt:
      episode.firstDroppedAt === null ? null : new Date(episode.firstDroppedAt).toISOString(),
    recoveredAt: new Date(episode.recoveredAt).toISOString(),
    exactCount: null,
  };
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function writeLedger(path: string, value: CollectionGapLedger): void {
  const temporary = join(dirname(path), `.collection-gaps-${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Keep the error that prevented the durable ledger write. */
    }
    throw error;
  }
}
