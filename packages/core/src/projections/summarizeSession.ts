import type { SessionSummary } from '@salidium/protocol';
import type { RunState } from '../state/runState.ts';

/** A session silent for this long is not credibly "working" (transcript-only sessions never signal their end). */
export const WORKING_STALE_MS = 15 * 60_000;

export function effectiveStatus(state: RunState, now: number): SessionSummary['status'] {
  if (state.status === 'working' && state.lastEventAt) {
    const age = now - Date.parse(state.lastEventAt);
    if (Number.isFinite(age) && age > WORKING_STALE_MS) return 'idle';
  }
  return state.status;
}

/** Compact list-row summary derived from state. `now` only affects the staleness rule above. */
export function summarizeSession(state: RunState, now: number = Date.now()): SessionSummary {
  const lastVerification = state.verifications[state.verifications.length - 1];
  return {
    id: state.sessionId,
    provider: state.provider,
    providerSessionId: state.providerSessionId,
    cwd: state.cwd,
    repoRoot: state.repoRoot,
    title: state.title ?? firstPromptTitle(state),
    model: state.model,
    entrypoint: state.entrypoint,
    internal: state.internal,
    status: effectiveStatus(state, now),
    startedAt: state.startedAt,
    lastEventAt: state.lastEventAt,
    endedAt: state.endedAt,
    latestSeq: state.latestSeq,
    counts: {
      turns: state.turns.length,
      toolCalls: state.counters.toolCalls,
      filesChanged: state.counters.filesChanged,
      linesAdded: state.counters.linesAdded,
      linesRemoved: state.counters.linesRemoved,
      reviewOpen: state.review.filter((r) => r.resolvedSeq === undefined && r.severity !== 'info')
        .length,
      remaining: state.plan.items.filter(
        (i) => i.status === 'pending' || i.status === 'in_progress',
      ).length,
    },
    ...(lastVerification
      ? {
          lastVerification: {
            outcome: lastVerification.outcome,
            at: lastVerification.at,
            epistemic: lastVerification.outcomeEpistemic,
          },
        }
      : {}),
  };
}

function firstPromptTitle(state: RunState): string | undefined {
  const p = state.turns.find((t) => t.prompt)?.prompt;
  if (!p) return undefined;
  const line =
    p
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
