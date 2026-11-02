import type { StoredEvent, StoredEventOf } from '@salidium/protocol';
import { detectGitCommand } from '../verification/classifyCommand.ts';
import { deriveVerification } from '../verification/deriveVerification.ts';
import { type ChangeLog, clip, shortSha } from './changeLog.ts';
import { msBetween } from './fidelity.ts';
import type { Activity, RunState, Turn, Verification } from './runState.ts';

const READ_ONLY_COMMAND =
  /^\s*(ls|cat|head|tail|grep|rg|find|fd|pwd|which|echo|wc|tree|stat|file|du|df|env|printenv|git\s+(status|log|diff|show|blame|branch|remote|rev-parse|ls-files)|sed\s+-n|awk|jq|less|more|type|node\s+-e|python3?\s+-c|open|curl\s+-s)\b/;

export function onCommandCompleted(
  state: RunState,
  a: Activity,
  e: StoredEventOf<'tool.completed'>,
  log: ChangeLog,
  turn: Turn | undefined,
) {
  if (a.input.kind !== 'command' || e.result.kind !== 'command') return;
  const command = a.input.command;
  const result = e.result;

  if (result.gitOperation) {
    state.git.operations.push({ op: result.gitOperation, at: e.ts, callId: a.callId });
    if (result.gitOperation.commit) {
      state.git.commits.push({
        sha: result.gitOperation.commit.sha,
        at: e.ts,
        callId: a.callId,
        kind: result.gitOperation.commit.kind,
      });
      state.git.head = result.gitOperation.commit.sha;
      log.add('what', `Committed ${shortSha(result.gitOperation.commit.sha)}`, 'observed', {
        sha: result.gitOperation.commit.sha,
      });
    }
    if (result.gitOperation.push) {
      state.git.pushes.push({
        branch: result.gitOperation.push.branch,
        at: e.ts,
        callId: a.callId,
      });
    }
  } else {
    const git = detectGitCommand(command);
    if (git === 'commit' && !e.isError) {
      const sha = /\[[^\]]*\s([0-9a-f]{7,40})\]/.exec(result.outputExcerpt)?.[1];
      state.git.commits.push({ sha: sha ?? '', at: e.ts, callId: a.callId });
      if (sha) state.git.head = sha;
      log.add(
        'what',
        sha ? `Committed ${shortSha(sha)}` : 'Committed',
        sha ? 'observed' : 'inferred',
        { sha },
      );
    } else if (git === 'push' && !e.isError) {
      state.git.pushes.push({ at: e.ts, callId: a.callId });
    }
  }

  const verification = deriveVerification(a, e.seq);
  if (verification) {
    recordVerification(state, a, verification, e, log, turn);
    return;
  }

  if (e.isError) {
    state.issues.push({
      id: `command:${e.id}`,
      kind: 'commandFailed',
      summary: `Command failed: ${clip(command, 100)}`,
      seq: e.seq,
      ts: e.ts,
      callId: a.callId,
    });
    log.add('what', `Command failed: ${clip(command, 100)}`, 'observed', { exit: result.exit });
    return;
  }
  if (!READ_ONLY_COMMAND.test(command) && (a.durationMs ?? 0) >= 30_000) {
    log.add(
      'what',
      `Ran ${clip(command, 110)} (${Math.round((a.durationMs ?? 0) / 1000)}s)`,
      'observed',
    );
  }
}

/** Records a derived verification: state, turn linkage, issue tracking, and one history line. */
export function recordVerification(
  state: RunState,
  a: Activity,
  verification: Verification,
  e: StoredEvent,
  log: ChangeLog,
  turn: Turn | undefined,
  logChange = true,
) {
  state.verifications.push(verification);
  turn?.verificationIds.push(verification.id);
  if (logChange) {
    log.add('verified', describeVerification(verification), verification.outcomeEpistemic, {
      outcome: verification.outcome,
      runner: verification.runner,
      method: verification.method,
      counts: verification.counts,
      caveats: verification.caveats,
    });
  }
  if (verification.outcome === 'fail') {
    state.issues.push({
      id: `verification:${verification.id}`,
      kind: 'commandFailed',
      summary: describeVerification(verification),
      seq: e.seq,
      ts: e.ts,
      callId: a.callId,
    });
  } else if (verification.outcome === 'pass' && verification.scope !== 'partial') {
    for (const issue of state.issues) {
      if (
        issue.kind === 'commandFailed' &&
        issue.resolvedSeq === undefined &&
        issue.id.startsWith('verification:')
      )
        issue.resolvedSeq = e.seq;
    }
  }
}

export function describeVerification(v: {
  method: string;
  runner?: string;
  outcome: string;
  counts?: { passed?: number; failed?: number; skipped?: number; total?: number };
  scope?: string;
  caveats?: string[];
}): string {
  const runner = v.runner ? ` (${v.runner})` : '';
  const c = v.counts;
  const partial = v.scope === 'partial' ? ' [subset]' : '';
  if (v.method === 'test') {
    if (v.outcome === 'pass') {
      if (c?.total !== undefined && c.total > 0) {
        const skipped = c.skipped ? `, ${c.skipped} skipped` : '';
        return `${c.passed ?? 0}/${c.total} tests passed${skipped}${runner}${partial}`;
      }
      return `Tests passed${runner}${partial}${v.caveats?.includes('exit-inferred') ? ' (exit inferred)' : ''}`;
    }
    if (v.outcome === 'fail') {
      if (c?.failed !== undefined && c.failed > 0)
        return `${c.failed} of ${c.total ?? '?'} tests failed${runner}${partial}`;
      return `Tests failed${runner}${partial}`;
    }
    if (v.outcome === 'partial') return `Tests passed but command failed${runner}`;
    return `Test run result unknown${runner}`;
  }
  const label =
    v.method === 'typecheck'
      ? 'Typecheck'
      : v.method === 'lint'
        ? 'Lint'
        : v.method === 'build'
          ? 'Build'
          : 'Check';
  if (v.outcome === 'pass') return `${label} passed${runner}`;
  if (v.outcome === 'fail')
    return `${label} failed${runner}${c?.failed ? ` (${c.failed} error${c.failed === 1 ? '' : 's'})` : ''}`;
  if (v.outcome === 'partial') return `${label} partially passed${runner}`;
  return `${label} result unknown${runner}`;
}

/**
 * Two explicit terminal records disagree about one call. Preserve both as evidence, but do not
 * let arrival order select a winner.
 */
export function markSourceConflict(
  state: RunState,
  a: Activity,
  e: StoredEventOf<'tool.completed'> | StoredEventOf<'tool.failed'>,
  log: ChangeLog,
): void {
  const evidenceIds = [...new Set([...a.eventIds, e.id])].sort();
  const incomingIsFailure = e.kind === 'tool.failed' || e.isError;
  const priorFailureCounted = a.status === 'failed' || a.isError;
  if (incomingIsFailure && !priorFailureCounted) state.counters.toolFailures += 1;

  const turn = a.turnId ? state.turns.find((candidate) => candidate.id === a.turnId) : undefined;
  const previous = state.verifications.find((v) => v.callId === a.callId);
  state.verifications = state.verifications.filter((v) => v.callId !== a.callId);
  if (turn) turn.verificationIds = turn.verificationIds.filter((id) => id !== a.callId);
  state.issues = state.issues.filter((issue) => issue.callId !== a.callId);
  state.review = state.review.filter(
    (item) =>
      !(item.rule === 'verification-failed' && item.refs.some((ref) => evidenceIds.includes(ref))),
  );

  const endedAt = a.endedAt && a.endedAt > e.ts ? a.endedAt : e.ts;
  const incomingDuration = e.durationMs ?? msBetween(a.startedAt, e.ts) ?? 0;
  a.endedAt = endedAt;
  a.durationMs = Math.max(a.durationMs ?? 0, incomingDuration);
  a.seqCompleted = e.seq;
  a.eventIds = evidenceIds;
  a.status = 'unknown';
  a.sourceConflict = true;
  a.isError = false;
  a.errorExcerpt = undefined;
  a.failureCause = undefined;
  a.exit = { observation: 'unknown' };
  a.result = {
    kind: 'command',
    exit: { observation: 'unknown' },
    outputExcerpt: '',
    outputChars: 0,
    truncated: false,
  };
  state.running = state.running.filter((id) => id !== a.callId);

  const derived = deriveVerification(a, e.seq);
  if (derived) {
    const conflict: Verification = {
      ...derived,
      outcome: 'unknown',
      counts: undefined,
      exit: { observation: 'unknown' },
      outcomeEpistemic: 'observed',
      caveats: [...new Set([...derived.caveats, 'source-conflict'])],
      failureExcerpt: undefined,
    };
    recordVerification(state, a, conflict, e, log, turn);
  } else if (previous && a.input.kind === 'command') {
    const conflict: Verification = {
      ...previous,
      at: endedAt,
      seq: e.seq,
      outcome: 'unknown',
      counts: undefined,
      exit: { observation: 'unknown' },
      outcomeEpistemic: 'observed',
      caveats: [...new Set([...previous.caveats, 'source-conflict'])],
      failureExcerpt: undefined,
    };
    recordVerification(state, a, conflict, e, log, turn);
  }

  const reviewId = `source-conflict:${a.callId}`;
  if (!state.review.some((item) => item.id === reviewId && item.resolvedSeq === undefined)) {
    const label = 'Conflicting tool results';
    const instance = clip(a.input.kind === 'command' ? a.input.command : a.title, 120);
    state.review.push({
      id: reviewId,
      rule: 'source-conflict',
      severity: 'high',
      label,
      instance,
      summary: `${label}: ${instance}`,
      detail: 'The provider records disagree about whether this call succeeded.',
      refs: evidenceIds,
      createdSeq: e.seq,
      createdAt: endedAt,
      epistemic: 'observed',
    });
    log.add('review', `${label}: ${instance}`, 'observed', {
      rule: 'source-conflict',
      severity: 'high',
    });
  }
}

export function recordToolFailure(
  state: RunState,
  a: Activity,
  e: StoredEventOf<'tool.failed'>,
  log: ChangeLog,
) {
  if (a.kind === 'command' && a.input.kind === 'command') {
    const inconclusive = e.cause === 'timeout' || e.cause === 'interrupted';
    if (!a.result) {
      a.result = {
        kind: 'command',
        exit: inconclusive
          ? { observation: 'unknown' }
          : (e.exit ?? { observation: 'inferred-failure' }),
        outputExcerpt: e.errorExcerpt,
        outputChars: e.errorExcerpt.length,
        truncated: false,
        interrupted: e.interrupted || e.cause === 'interrupted' || undefined,
        timedOut: e.cause === 'timeout' || undefined,
      };
    }
    if (inconclusive) a.exit = { observation: 'unknown' };
    const turn = a.turnId ? state.turns.find((t) => t.id === a.turnId) : undefined;
    const verification = deriveVerification(a, e.seq);
    if (verification) {
      recordVerification(state, a, verification, e, log, turn);
      return;
    }
    if (e.interrupted) {
      log.add('what', `Interrupted: ${clip(a.input.command, 100)}`, 'observed');
      return;
    }
    state.issues.push({
      id: `command:${e.id}`,
      kind: 'commandFailed',
      summary: `Command failed: ${clip(a.input.command, 100)}`,
      seq: e.seq,
      ts: e.ts,
      callId: a.callId,
    });
    log.add('what', `Command failed: ${clip(a.input.command, 100)}`, 'observed', { exit: e.exit });
    return;
  }
  state.issues.push({
    id: `tool:${e.id}`,
    kind: 'toolError',
    summary: `${a.title} failed`,
    seq: e.seq,
    ts: e.ts,
    callId: a.callId,
  });
  log.add('what', `${a.title} failed`, 'observed');
}
