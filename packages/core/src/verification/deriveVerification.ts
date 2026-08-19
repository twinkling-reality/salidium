import type { ExitStatus } from '@salidium/protocol';
import type { Activity, Verification, VerificationOutcome } from '../state/runState.ts';
import { classifyCommand } from './classifyCommand.ts';
import { parseRunnerOutput, RUNNER_METHOD } from './parseRunnerOutput.ts';

/**
 * Turns a completed command activity into a Verification when the command is a recognized
 * check (tests, typecheck, lint, build). Pure. Honest about how the outcome was established:
 * an explicit exit code is observed; a parsed summary is inferred; an inferred exit code is
 * inferred; nothing recognizable → 'unknown'.
 */
export function deriveVerification(activity: Activity, seq: number): Verification | undefined {
  if (activity.input.kind !== 'command') return undefined;
  const cls = classifyCommand(activity.input.command);
  if (!cls || cls.watch) return undefined;
  // A backgrounded run has not produced a result yet; its stub output must not read as a pass.
  if (activity.input.background) return undefined;
  const result = activity.result?.kind === 'command' ? activity.result : undefined;
  const exit: ExitStatus = activity.exit ?? result?.exit ?? { observation: 'unknown' };
  const output = result?.outputExcerpt ?? activity.errorExcerpt ?? '';
  const summary = parseRunnerOutput(cls.runner, output, cls.method);
  // What the output says it was outranks what the command looked like. A compound command is
  // classified by its first recognisable segment, so `pnpm build && pnpm lint` is typed "build";
  // when the summary that actually parsed belongs to another method, that reading wins, and the
  // scope caveat is kept because we still only recorded one run for the whole pipeline.
  const parsedMethod = summary ? RUNNER_METHOD[summary.runner] : undefined;
  const method = (parsedMethod ?? cls.method) as typeof cls.method;
  const caveats: string[] = [];
  if (result?.truncated) caveats.push('output-truncated');
  if (cls.scope === 'partial') caveats.push('scope-partial');
  if (!summary) caveats.push('no-summary-parsed');

  let outcome: VerificationOutcome = 'unknown';
  let outcomeEpistemic: Verification['outcomeEpistemic'] = 'inferred';

  const exitSaysFail =
    exit.observation === 'inferred-failure' ||
    (exit.observation === 'explicit' && (exit.code ?? 0) !== 0);
  const exitSaysPass =
    exit.observation === 'inferred-success' || (exit.observation === 'explicit' && exit.code === 0);

  if (summary && summary.outcome !== 'unknown') {
    outcome = summary.outcome;
    if (summary.outcome === 'pass' && exitSaysFail) {
      outcome = 'partial';
      caveats.push('exit-summary-mismatch');
    } else if (summary.outcome === 'fail' && exitSaysPass) {
      caveats.push('exit-masked');
    }
    outcomeEpistemic = exit.observation === 'explicit' ? 'observed' : 'inferred';
  } else if (exitSaysFail) {
    outcome = 'fail';
    outcomeEpistemic = exit.observation === 'explicit' ? 'observed' : 'inferred';
  } else if (exitSaysPass) {
    outcome = 'pass';
    outcomeEpistemic = exit.observation === 'explicit' ? 'observed' : 'inferred';
    if (exit.observation !== 'explicit') caveats.push('exit-inferred');
  } else {
    outcome = 'unknown';
  }
  if (activity.status === 'running') outcome = 'unknown';
  if (result?.interrupted || result?.timedOut) {
    outcome = 'unknown';
    caveats.push(result.interrupted ? 'interrupted' : 'timed-out');
  }

  const failureExcerpt =
    outcome === 'fail' || outcome === 'partial' ? tail(output, 800) : undefined;

  return {
    id: activity.callId,
    callId: activity.callId,
    turnId: activity.turnId,
    at: activity.endedAt ?? activity.startedAt,
    seq,
    command: activity.input.command,
    runner: summary?.runner ?? cls.runner,
    method,
    outcome,
    counts: summary?.counts,
    scope: cls.scope,
    exit,
    outcomeEpistemic,
    caveats,
    failureExcerpt,
    stale: false,
  };
}

function tail(text: string, n: number): string {
  return text.length <= n ? text : text.slice(text.length - n);
}
