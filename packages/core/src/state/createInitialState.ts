import type { ProviderId } from '@salidium/protocol';
import type { RunState } from './runState.ts';

/** Bump when the reducer's derivation changes in a way that invalidates checkpoints. */
export const REDUCER_VERSION = '1.14.0';

/**
 * Records keyed by provider data (call ids, paths, agent ids, lanes) as null-prototype objects.
 *
 * A provider names its calls and files, so a key can be `constructor`, `toString` or `__proto__`.
 * On an ordinary object those read inherited members or assign the prototype; on one without a
 * prototype they are keys like any other. JSON and structured cloning both produce ordinary
 * objects, so every state read back from a checkpoint, a clone or the wire passes through here.
 */
export function reviveState(state: RunState): RunState {
  state.activities = keyed(state.activities);
  state.absorbedCalls = keyed(state.absorbedCalls);
  state.files = keyed(state.files);
  state.fileLocations = keyed(state.fileLocations);
  state.subagents = keyed(state.subagents);
  state.usage.lastByLane = keyed(state.usage.lastByLane);
  return state;
}

function keyed<T>(record: Record<string, T> | undefined): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (record) for (const [key, value] of Object.entries(record)) out[key] = value;
  return out;
}

export function createInitialState(args: {
  sessionId: string;
  provider: ProviderId;
  providerSessionId: string;
  cwd?: string;
}): RunState {
  return {
    reducerVersion: REDUCER_VERSION,
    revision: 0,
    latestSeq: -1,
    sessionId: args.sessionId,
    provider: args.provider,
    providerSessionId: args.providerSessionId,
    cwd: args.cwd ?? '',
    status: 'unknown',
    turns: [],
    activities: keyed({}),
    activityOrder: [],
    absorbedCalls: keyed({}),
    files: keyed({}),
    fileLocations: keyed({}),
    verifications: [],
    plan: { items: [] },
    claims: [],
    review: [],
    issues: [],
    subagents: keyed({}),
    git: { commits: [], headMoves: [], pushes: [], operations: [] },
    counters: {
      turns: 0,
      toolCalls: 0,
      toolFailures: 0,
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      commands: 0,
      compactions: 0,
      ingestWarnings: 0,
      redactions: 0,
    },
    usage: {
      messages: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastByLane: keyed({}),
    },
    running: [],
  };
}
