import type { TurnRow } from '@salidium/core';
import type { SemanticChange } from '@salidium/protocol';

export type TimelineStop = { ts: string; seq: number };

/** A replay is timestamp-based; all rows at one instant must share a stop. */
export function timelineStops(changes: SemanticChange[]): TimelineStop[] {
  const stops: TimelineStop[] = [];
  let maxSeq = -1;
  for (const change of changes) {
    maxSeq = Math.max(maxSeq, change.seq);
    const previous = stops[stops.length - 1];
    if (previous?.ts === change.ts) previous.seq = maxSeq;
    else stops.push({ ts: change.ts, seq: maxSeq });
  }
  return stops;
}

/** Last available stop at or before a timestamp, or -1 before the first stop. */
export function stopAt(stops: TimelineStop[], ts: string): number {
  let lo = 0;
  let hi = stops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const stop = stops[mid];
    if (stop !== undefined && stop.ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

type RecordedTurn = Pick<TurnRow, 'id' | 'index' | 'headline' | 'prompt' | 'startedAt'>;

/**
 * Chapters use recorded turn boundaries, never inferred phases. A turn whose changes have not
 * arrived yet stays visible but unavailable rather than jumping to an unrelated turn.
 */
export function timelineSegments(turns: RecordedTurn[], stops: TimelineStop[]) {
  const ordered = [...turns].sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.index - b.index,
  );
  return ordered.map((turn, index) => {
    const nextAt = ordered[index + 1]?.startedAt;
    const atOrBefore = stopAt(stops, turn.startedAt);
    const target = stops[atOrBefore]?.ts === turn.startedAt ? atOrBefore : atOrBefore + 1;
    const stop = stops[target];
    return {
      id: turn.id,
      index: turn.index,
      title: turn.headline?.trim() || turn.prompt.trim() || `Turn ${turn.index + 1}`,
      startedAt: turn.startedAt,
      nextAt,
      target: stop && (nextAt === undefined || stop.ts < nextAt) ? target : undefined,
    };
  });
}
