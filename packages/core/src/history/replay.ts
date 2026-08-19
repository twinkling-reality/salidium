import type { SemanticChange, StoredEvent } from '@salidium/protocol';
import { applyEvent } from '../state/reducer.ts';
import type { RunState } from '../state/runState.ts';

/**
 * Point-in-time reconstruction. Given a base state (fresh or a checkpoint clone) and the events
 * after it, replays up to and including `untilSeq` (or everything). Because the reducer is
 * deterministic and idempotent on seq, replay from a checkpoint equals replay from zero.
 */
export function replayEvents(
  base: RunState,
  events: Iterable<StoredEvent>,
  untilSeq?: number,
): { state: RunState; changes: SemanticChange[] } {
  const changes: SemanticChange[] = [];
  for (const e of events) {
    if (untilSeq !== undefined && e.seq > untilSeq) break;
    const c = applyEvent(base, e);
    if (c.length) changes.push(...c);
  }
  return { state: base, changes };
}

/** Deep-clones a state so a checkpoint can be replayed forward without mutating the original. */
export function cloneState(state: RunState): RunState {
  return structuredClone(state);
}
