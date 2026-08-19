import type { ProviderId } from '@salidium/protocol';
import type { RunState } from './runState.ts';

/** Bump when the reducer's derivation changes in a way that invalidates checkpoints. */
export const REDUCER_VERSION = '1.12.0';

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
    activities: {},
    activityOrder: [],
    files: {},
    verifications: [],
    plan: { items: [] },
    claims: [],
    review: [],
    issues: [],
    subagents: {},
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
      lastByLane: {},
    },
    running: [],
  };
}
