import type { StoredEvent } from '@salidium/protocol';
import { detectDestructiveCommand, detectGitCommand } from '../verification/classifyCommand.ts';
import type { ChangeLog } from './changeLog.ts';
import { clip } from './changeLog.ts';
import type { ReviewItem, ReviewSeverity, RunState } from './runState.ts';

/**
 * Deterministic rules that decide what a human should look at. Each rule owns a stable id
 * prefix so items are opened once and resolved when the condition clears. Rules never invent
 * facts: every item cites the events it was derived from.
 */

function open(
  state: RunState,
  event: StoredEvent,
  log: ChangeLog,
  item: Omit<ReviewItem, 'createdSeq' | 'createdAt' | 'refs' | 'epistemic' | 'summary'> & {
    refs?: string[];
    epistemic?: ReviewItem['epistemic'];
  },
): void {
  if (state.review.some((r) => r.id === item.id && r.resolvedSeq === undefined)) return;
  // Composed here rather than at each rule, so the one-line form and the two fields a grouped
  // view reads cannot drift apart.
  const summary = item.instance ? `${item.label}: ${item.instance}` : item.label;
  state.review.push({
    ...item,
    summary,
    refs: item.refs ?? [event.id],
    createdSeq: event.seq,
    createdAt: event.ts,
    epistemic: item.epistemic ?? 'inferred',
  });
  if (!log.changes.some((c) => c.facet === 'review' && c.summary === clip(summary, 160))) {
    log.add('review', summary, item.epistemic ?? 'inferred', {
      rule: item.rule,
      severity: item.severity,
    });
  }
}

function resolve(state: RunState, event: StoredEvent, predicate: (r: ReviewItem) => boolean): void {
  for (const r of state.review)
    if (r.resolvedSeq === undefined && predicate(r)) r.resolvedSeq = event.seq;
}

/**
 * "tests pass" style claims. Adjacency keeps future/negated statements ("tests should pass",
 * "tests don't pass yet", "run the tests to make sure they pass") from counting as a claim.
 */
const VERIFICATION_CLAIM =
  /\b(?:all\s+)?(tests?|checks?|build|typecheck|lint)\s+(?:are\s+|is\s+|now\s+|still\s+)?(pass|passes|passed|passing|green|succeeds|succeeded|clean)\b/i;
const CLAIM_NEGATION =
  /\b(not|n't|never|should|will|would|until|once|need to|needs to|make sure|to see if|whether|if)\b[^.\n]{0,40}$/i;

function claimsVerification(text: string): boolean {
  const m = VERIFICATION_CLAIM.exec(text);
  if (!m) return false;
  const before = text.slice(Math.max(0, m.index - 60), m.index);
  return !CLAIM_NEGATION.test(before);
}

function applyVerificationReview(state: RunState, event: StoredEvent, log: ChangeLog): void {
  const v = state.verifications[state.verifications.length - 1];
  if (!v || v.seq !== event.seq) return;
  if (v.outcome === 'fail') {
    open(state, event, log, {
      id: `verification-failed:${v.method}`,
      rule: 'verification-failed',
      severity: 'high',
      label: describeFailure(v),
      epistemic: v.outcomeEpistemic,
    });
  } else if (v.outcome === 'pass' && v.scope !== 'partial') {
    /*
     * A pass always clears its own method's failure. It clears "unverified changes" only when it
     * is the kind of run that counts as covering the work, which is the same three-part test
     * `lastPass` applies in the projection: not partial scope, and not lint.
     *
     * Without the method test a passing lint dropped this item while the verdict above it still
     * read "N files changed, unverified" and Coverage still drew the files uncovered. One report
     * gave two answers to the same question, and the one it silently withdrew was the one a
     * person was meant to act on.
     */
    const covers = v.method !== 'lint';
    resolve(
      state,
      event,
      (r) =>
        r.id === `verification-failed:${v.method}` || (covers && r.rule === 'changes-unverified'),
    );
  }
}

export function applyReviewRulesAfterEvent(
  state: RunState,
  event: StoredEvent,
  log: ChangeLog,
): void {
  switch (event.kind) {
    case 'permission.requested':
      open(state, event, log, {
        id: `waiting:permission:${event.seq}`,
        rule: 'waiting-permission',
        severity: 'high',
        label: 'Waiting for your permission',
        instance: event.summary,
        epistemic: 'observed',
      });
      break;
    case 'notification':
      if (state.waiting?.kind === 'input' && state.waiting.seq === event.seq) {
        open(state, event, log, {
          id: `waiting:input:${event.seq}`,
          rule: 'waiting-input',
          severity: 'high',
          label: 'Agent needs input',
          instance: clip(event.message, 120),
          epistemic: 'observed',
        });
      }
      break;
    case 'tool.called': {
      if (event.input.kind === 'question') {
        open(state, event, log, {
          id: `waiting:question:${event.callId}`,
          rule: 'waiting-question',
          severity: 'high',
          label: 'Asked you a question',
          instance: clip(event.input.questions[0] ?? 'a question', 120),
          epistemic: 'observed',
        });
      }
      if (event.input.kind === 'command') {
        const d = detectDestructiveCommand(event.input.command);
        if (d)
          open(state, event, log, {
            id: `destructive:${event.callId}`,
            rule: `destructive:${d.id}`,
            severity: d.id === 'sudo' ? 'info' : 'medium',
            label: d.summary,
            instance: clip(d.segment, 100),
            epistemic: 'observed',
          });
      }
      // A result can precede its call. In that case the late call is the event that finally names
      // the command and allows the reducer to derive a verification.
      applyVerificationReview(state, event, log);
      // Any agent activity clears "waiting for permission/input" items.
      resolve(state, event, (r) => r.rule === 'waiting-permission' || r.rule === 'waiting-input');
      break;
    }
    case 'tool.completed':
    case 'tool.failed': {
      resolve(
        state,
        event,
        (r) =>
          r.rule === 'waiting-permission' ||
          r.rule === 'waiting-input' ||
          r.id === `waiting:question:${event.callId}`,
      );
      applyVerificationReview(state, event, log);
      if (
        event.kind === 'tool.completed' &&
        event.result.kind === 'command' &&
        !event.isError &&
        !event.result.gitOperation?.push
      ) {
        const a = state.activities[event.callId];
        if (a?.input.kind === 'command' && detectGitCommand(a.input.command) === 'push') {
          open(state, event, log, {
            id: `push:${event.callId}`,
            rule: 'git-push',
            severity: 'low',
            label: 'Pushed to remote',
            epistemic: 'inferred',
          });
        }
      }
      if (
        event.kind === 'tool.completed' &&
        event.result.kind === 'command' &&
        event.result.gitOperation?.push
      ) {
        open(state, event, log, {
          id: `push:${event.callId}`,
          rule: 'git-push',
          severity: 'low',
          label: `Pushed${event.result.gitOperation.push.branch ? ` ${event.result.gitOperation.push.branch}` : ' to remote'}`,
          epistemic: 'observed',
        });
      }
      break;
    }
    case 'turn.started':
      resolve(state, event, (r) => r.rule.startsWith('waiting-'));
      break;
    case 'turn.ended': {
      resolve(state, event, (r) => r.rule.startsWith('waiting-'));
      const turn = state.turns.find(
        (t) => t.id === (event.turnId ?? state.turns[state.turns.length - 1]?.id),
      );
      if (event.outcome === 'failed') {
        open(state, event, log, {
          id: `turn-failed:${event.seq}`,
          rule: 'turn-failed',
          severity: 'high',
          label: 'Turn failed',
          instance: clip(event.error ?? 'error', 120),
          epistemic: 'observed',
        });
      }
      if (turn) {
        const lastPass = [...state.verifications]
          .filter((v) => v.outcome === 'pass' && v.scope !== 'partial' && v.method !== 'lint')
          .sort((a, b) => a.at.localeCompare(b.at))
          .pop();
        const changedAfter = Object.values(state.files).filter(
          (f) => !lastPass || f.lastChangedAt > lastPass.at,
        );
        if (turn.filesTouched.length > 0 && changedAfter.length > 0) {
          const severity: ReviewSeverity = lastPass ? 'low' : 'medium';
          const summary = lastPass
            ? `${changedAfter.length} file${changedAfter.length === 1 ? '' : 's'} changed since the last passing check`
            : `${changedAfter.length} file${changedAfter.length === 1 ? '' : 's'} changed with no passing check observed`;
          const existing = state.review.find(
            (r) => r.rule === 'changes-unverified' && r.resolvedSeq === undefined,
          );
          if (existing) {
            existing.label = summary;
            existing.summary = summary;
            existing.severity = severity;
            existing.detail = changedAfter
              .map((f) => f.path)
              .slice(0, 50)
              .join('\n');
          } else {
            open(state, event, log, {
              id: `changes-unverified:${event.seq}`,
              rule: 'changes-unverified',
              severity,
              label: summary,
              detail: changedAfter
                .map((f) => f.path)
                .slice(0, 50)
                .join('\n'),
            });
          }
        }
        if (event.lastMessage && claimsVerification(event.lastMessage)) {
          const observedInTurn = state.verifications.some(
            (v) => v.turnId === turn.id && v.outcome === 'pass',
          );
          if (!observedInTurn) {
            open(state, event, log, {
              id: `claim-without-evidence:${turn.id}`,
              rule: 'claim-without-evidence',
              severity: 'medium',
              label: 'Agent reports checks passing, but no passing check was observed this turn',
              detail: clip(event.lastMessage, 300),
            });
          }
        }
      }
      break;
    }
    default:
      break;
  }
}

function describeFailure(v: {
  method: string;
  runner?: string;
  counts?: { failed?: number; total?: number };
}): string {
  const runner = v.runner ? ` (${v.runner})` : '';
  if (v.method === 'test') {
    if (v.counts?.failed)
      return `${v.counts.failed} test${v.counts.failed === 1 ? '' : 's'} failing${runner}`;
    return `Tests failing${runner}`;
  }
  const label =
    v.method === 'typecheck'
      ? 'Typecheck'
      : v.method === 'lint'
        ? 'Lint'
        : v.method === 'build'
          ? 'Build'
          : 'Check';
  return `${label} failing${runner}${v.counts?.failed ? ` (${v.counts.failed} errors)` : ''}`;
}
