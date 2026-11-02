import type { RunState } from '@salidium/core';
import type {
  CollectionStatus,
  Facet,
  OperationsOverview,
  SemanticChange,
  SessionSummary,
} from '@salidium/protocol';

/** Every kind of change the log records, in the order the rail and the table list them. */
export const ALL_FACETS: Facet[] = ['status', 'what', 'why', 'how', 'verified', 'left', 'review'];

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type OperationsAction =
  | 'collection'
  | 'policy'
  | 'reset'
  | 'drain'
  | 'alert'
  | 'disconnect'
  | 'connect'
  | 'storage-delete'
  | 'storage-compact';

/** Why a session's snapshot could not be loaded; rendered in place of the session. */
export interface LiveError {
  kind: 'not-found' | 'unreachable' | 'failed';
  message: string;
}

export interface LiveSession {
  state: RunState;
  /** Bumped whenever `state` was mutated by the reducer; components key memoization on it. */
  revision: number;
  changes: SemanticChange[];
  connection: ConnectionStatus;
  error?: string;
  /** History scrubbing: state as of a past moment (undefined = live). */
  scrub?: { ts: string; seq: number; state: RunState; loading: boolean };
  /** Sequence number when the user last looked at this session (for "since you looked"). */
  lastSeenSeq: number;
}

export interface SessionSearch {
  /** Trimmed, as it was sent. */
  query: string;
  /** Matched ids in the daemon's order, or undefined for the default view, which is not a search. */
  ids: string[] | undefined;
  /** How many user sessions matched over the whole store. `ids` is the newest page of them. */
  matched: number;
  /** How many user sessions the store holds. Independent of the query. */
  total: number;
}

/** History is displayed in wall-clock order; seq breaks ties (multi-source ingest can be out of order). */
export function byTime(a: SemanticChange, b: SemanticChange): number {
  return a.ts.localeCompare(b.ts) || a.seq - b.seq || a.ordinal - b.ordinal;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Salidium's own enrichment runs are agent sessions too. The daemon filters them, but a session's
 * opening summary has no title yet, so one can arrive before it is knowable.
 */
export function merged(
  current: Record<string, SessionSummary>,
  list: SessionSummary[],
): Record<string, SessionSummary> {
  const sessions = { ...current };
  for (const item of list) {
    if (item.internal || item.title?.includes('[salidium-explainer]')) {
      delete sessions[item.id];
      continue;
    }
    sessions[item.id] = item;
  }
  return sessions;
}

export function sortIds(sessions: Record<string, SessionSummary>): string[] {
  return Object.values(sessions)
    .sort((a, b) =>
      (b.lastEventAt ?? b.startedAt ?? '').localeCompare(a.lastEventAt ?? a.startedAt ?? ''),
    )
    .map((s) => s.id);
}

/** Compatibility view for the few existing collection controls; health itself is not recomputed. */
export function collectionFromOperations(operations: OperationsOverview): CollectionStatus {
  const health = operations.health;
  return {
    observedAt: health.observedAt,
    state: health.collection.state,
    pause:
      health.collection.pausedAt &&
      health.collection.pauseExpiresAt &&
      health.collection.pauseReason
        ? {
            pausedAt: health.collection.pausedAt,
            expiresAt: health.collection.pauseExpiresAt,
            reason: health.collection.pauseReason,
          }
        : null,
    queue: {
      files: health.queue.files ?? 0,
      bytes: health.queue.bytes ?? 0,
      oldestAt: health.queue.oldestAt,
    },
    store: {
      bytes: health.store.totalBytes,
      retention: health.store.retention,
      lastIngestAt: health.store.lastIngestAt,
    },
    health:
      health.overall === 'critical'
        ? 'runaway'
        : health.overall === 'attention'
          ? 'attention'
          : 'healthy',
    gaps: {
      active: health.gaps.activeEpisodes,
      recovered: health.gaps.recoveredEpisodes,
      omittedEpisodes: health.gaps.omitted,
    },
  };
}
