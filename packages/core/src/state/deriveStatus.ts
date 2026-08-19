import type { SessionStatus } from '@salidium/protocol';
import type { RunState } from './runState.ts';

/** Session status derived purely from state: waiting > working > idle > ended. */
export function deriveStatus(state: RunState): SessionStatus {
  if (state.endedAt) return 'ended';
  if (state.waiting) return 'waiting';
  const last = state.turns[state.turns.length - 1];
  if (last && !last.endedAt) return 'working';
  if (state.running.length > 0) return 'working';
  if (last) return 'idle';
  return state.startedAt ? 'idle' : 'unknown';
}
