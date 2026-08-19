import type { Epistemic, ExitStatus, PlanItem, SessionStatus } from '@salidium/protocol';
import { headlineOf } from '../claims/classifyAgentMessage.ts';
import { basename, clip, shortSha } from '../state/changeLog.ts';
import { describeVerification } from '../state/reducer.ts';
import type {
  Activity,
  Claim,
  Explanation,
  FileState,
  ReviewItem,
  RunState,
  Turn,
  Verification,
} from '../state/runState.ts';
import { effectiveStatus } from './summarizeSession.ts';

/**
 * `looksLikeTask` lived in this file and gated exactly one facet, while the change log took the
 * same claims ungated: 381 `left` entries across the store asserted from prose that Left itself
 * would have refused. It is the classifier's `remaining` rule now, so the gate applies wherever
 * the claim goes. Re-exported because its regression suite names this module.
 */
export { looksLikeTask } from '../claims/classifyAgentMessage.ts';

/**
 * The projection returns everything it knows; deciding what to show is the client's job
 * (progressive disclosure per section), not a global "how much text" knob. Raw records stay
 * a drill-through.
 */

/** A running call older than this is not shown as the current activity. */
export const ACTIVE_CALL_MAX_AGE_MS = 10 * 60_000;

/**
 * The one-line answer to "can I trust what happened here?", derived by the named rules in
 * `verdict()`. `because` states the evidence and its caveat in plain words — the caveat is the
 * content, not decoration, because an inferred pass is not the same fact as an observed one.
 */
export interface VerdictView {
  headline: string;
  tone: 'pass' | 'fail' | 'attention' | 'working' | 'neutral';
  epistemic: Epistemic;
  because?: string;
  /** Timestamp of the evidence `because` refers to, for the client to render in local time. */
  at?: string;
  refs: string[];
}

export interface Line {
  text: string;
  epistemic: Epistemic;
  /** Event ids or activity ids to drill into. */
  refs: string[];
  at?: string;
  /** Who said it, for reported lines. */
  author?: 'agent' | 'user' | 'subagent';
}

export interface StripView {
  status: SessionStatus;
  statusSince?: string;
  activeTitle?: string;
  activeSince?: string;
  model?: string;
  turns: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  latestVerification?: VerificationRow;
  reviewOpen: number;
  remaining: number;
  waiting?: { kind: string; summary: string; since: string };
}

export interface FileRow {
  path: string;
  changeCount: number;
  linesAdded: number;
  linesRemoved: number;
  kinds: FileState['kinds'];
  lastChangedAt: string;
  lastCallId: string;
  /** A full-scope passing check ran after the last change (derived; see verifiedBy). */
  verifiedAfter: boolean;
  /** Label of that check, e.g. "45/45 tests passed (vitest)". */
  verifiedBy?: string;
  turnIndexes: number[];
  /** Nearest agent-reported rationale from the same turn (reported), if any. */
  reason?: Line;
}

export interface CommandRow {
  callId: string;
  command: string;
  description?: string;
  at: string;
  status: Activity['status'];
  exit?: ExitStatus;
  durationMs?: number;
  isVerification: boolean;
  turnIndex?: number;
  agentId?: string;
}

export interface CommitRow {
  sha: string;
  at: string;
  callId?: string;
}

export interface VerificationSummaryRow extends VerificationRow {
  /** Runs of this method after this one whose outcome could not be read. */
  laterUnreadable: number;
}

export interface VerificationRow {
  id: string;
  callId: string;
  at: string;
  label: string;
  method: Verification['method'];
  runner?: string;
  outcome: Verification['outcome'];
  counts?: Verification['counts'];
  scope: Verification['scope'];
  exit: ExitStatus;
  epistemic: Epistemic;
  caveats: string[];
  stale: boolean;
  command: string;
  failureExcerpt?: string;
  turnIndex?: number;
}

export interface ReviewRow {
  id: string;
  rule: string;
  severity: ReviewItem['severity'];
  label: string;
  instance?: string;
  summary: string;
  detail?: string;
  refs: string[];
  createdAt: string;
  epistemic: Epistemic;
}

/**
 * One rule's open items, gathered.
 *
 * Review is the section that decides whether a human has to stop, and one row per occurrence meant
 * a run that cleared a cache before
 * each of twenty test runs printed twenty rows reading "Recursive force delete", which is one fact
 * told twenty times and reads as twenty problems. It is the same collapse the session flow already
 * applies to runs of identical work — say the kind once, say how many, and keep the occurrences
 * one gesture away.
 *
 * `occurrences` is how many times the rule fired; `items` is those occurrences with identical text
 * folded together. The two counts differing is itself the answer to "is this one thing repeated or
 * twenty different ones", which is the question that decides whether the reader has to look.
 */
export interface ReviewGroup {
  rule: string;
  label: string;
  severity: ReviewItem['severity'];
  occurrences: number;
  /** Distinct occurrences, most recent first, each carrying how many times it repeated. */
  items: Array<ReviewRow & { repeats: number }>;
  /** Latest occurrence, so groups can be ordered by recency within a severity. */
  createdAt: string;
}

export interface LeftRow {
  id: string;
  text: string;
  status: PlanItem['status'] | 'failing' | 'reported';
  epistemic: Epistemic;
  source: 'plan' | 'verification' | 'agent';
  refs: string[];
}

export interface TurnRow {
  id: string;
  index: number;
  prompt: string;
  headline?: string;
  startedAt: string;
  endedAt?: string;
  outcome?: Turn['outcome'];
  lastMessage?: string;
  activityCount: number;
  files: string[];
  linesAdded: number;
  linesRemoved: number;
  verifications: VerificationRow[];
  activities: ActivityRow[];
  claims: Line[];
}

export interface ActivityRow {
  callId: string;
  kind: Activity['kind'];
  title: string;
  toolName: string;
  startedAt: string;
  durationMs?: number;
  status: Activity['status'];
  agentId?: string;
  isVerification: boolean;
  exit?: ExitStatus;
  eventIds: string[];
}

/**
 * The dense report: the pieces a spatial layout needs, pre-separated so the client never has to
 * re-parse prose it was handed.
 *
 * `chain` and `approaches` used to live here — the agent's ordered discoveries and its stated
 * steps — and no renderer has read either since the three-column account was deleted from the web
 * and from `salidium show`. They are gone rather than carried: a projection nothing draws is a
 * region waiting to be filled, and filling regions is the fault this whole change is about.
 * The claims themselves are unaffected; they reach the reader through the change log, which is
 * where a statement the agent made in passing belongs.
 */
export interface ReportView {
  /**
   * The agent's latest statement, quoted and attributed. It asserts only that the agent said this
   * — no heading, no kind — which is why it may show a claim the classifier could not place.
   */
  whatNow?: Line;
  /** File the agent is working in right now, if it is editing. */
  editing?: string;
  ask?: Line;
  plan: Array<{ text: string; status: PlanItem['status'] }>;
  files: Array<{ path: string; mark: '~' | '+' | '-' }>;
  runtimeMs?: number;
}

export interface SessionView {
  strip: StripView;
  verdict: VerdictView;
  report: ReportView;
  /** Generated explanation, when one exists. Always rendered as generated, never as observed. */
  explained?: Explanation;
  review: {
    glance: string;
    items: ReviewRow[];
    /** The same items, one entry per rule. What every surface should render. */
    groups: ReviewGroup[];
    resolvedCount: number;
  };
  changes: { glance: string; files: FileRow[]; commands: CommandRow[]; commits: CommitRow[] };
  verified: {
    glance: string;
    runs: VerificationRow[];
    /**
     * One row per method for the at-a-glance columns, which have room for a line per method and
     * not a line per run.
     *
     * It used to be the *latest* run of each method, computed independently by each renderer. On
     * a provider where a run's outcome is often unreadable that can print a question mark directly
     * above a lane showing readable results. It is the latest run whose outcome could be *read*,
     * and `laterUnreadable`
     * counts the runs after it that could not, so the row can say it is not the latest. Saying
     * less than we know is the one thing this page is not allowed to do; saying it without that
     * count would be the other one.
     */
    summary: VerificationSummaryRow[];
    unverifiedFiles: string[];
    claims: Line[];
  };
  left: { glance: string; items: LeftRow[]; planExplanation?: string };
  turns: TurnRow[];
  subagents: Array<{
    id: string;
    agentType?: string;
    description?: string;
    startedAt: string;
    endedAt?: string;
    toolCalls: number;
    lastMessage?: string;
    /** The record the row is reading from, so it can be opened like everything else. */
    eventId: string;
  }>;
  ingest: { warnings: number; redactions: number; compactions: number };
  /**
   * What this session's agent consumed, when any of it was observed.
   *
   * Observed tokens only, and absent rather than zeroed when nothing was seen: a transcript that
   * was already fully read before `agent.usage` existed emits none, and a session reporting four
   * zeroes would be asserting a measurement it never made.
   */
  usage?: {
    messages: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

export function projectSession(state: RunState, now: number = Date.now()): SessionView {
  const status = effectiveStatus(state, now);
  const verificationRows = state.verifications.map((v) => toVerificationRow(state, v));
  const latestVerification = verificationRows[verificationRows.length - 1];
  const files = Object.values(state.files).sort((a, b) => b.lastChangeSeq - a.lastChangeSeq);
  // The last passing check that can vouch for the current tree: full-scope test/build/typecheck
  // runs (a lint pass or a single-file test subset does not clear "unverified").
  const lastPass = [...state.verifications]
    .filter((v) => v.outcome === 'pass' && v.scope !== 'partial' && v.method !== 'lint')
    .sort((a, b) => a.at.localeCompare(b.at))
    .pop();
  const openReview = state.review.filter((r) => r.resolvedSeq === undefined);
  const attention = openReview.filter((r) => r.severity !== 'info');
  const reviewRows = openReview
    .slice()
    .sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity) || b.createdSeq - a.createdSeq,
    )
    .map(toReviewRow);
  const left = leftSection(state);
  // The main agent's most recent running call, if it started recently; stale running calls
  // (results that never arrived) and sub-agent lanes are not "what is happening now".
  const activeCall = [...state.running]
    .reverse()
    .map((id) => state.activities[id])
    .find((a) => a && !a.agentId && now - Date.parse(a.startedAt) < ACTIVE_CALL_MAX_AGE_MS);

  const strip: StripView = {
    status,
    statusSince: status === state.status ? state.statusSince : state.lastEventAt,
    activeTitle: status === 'working' ? activeCall?.title : undefined,
    activeSince: status === 'working' ? activeCall?.startedAt : undefined,
    model: state.model,
    turns: state.turns.length,
    filesChanged: state.counters.filesChanged,
    linesAdded: state.counters.linesAdded,
    linesRemoved: state.counters.linesRemoved,
    commits: state.git.commits.length,
    latestVerification,
    reviewOpen: attention.length,
    remaining: left.items.length,
    waiting: state.waiting
      ? { kind: state.waiting.kind, summary: state.waiting.summary, since: state.waiting.since }
      : undefined,
  };

  const currentTurn = state.turns[state.turns.length - 1];
  const markOf = (f: FileState): '~' | '+' | '-' =>
    f.kinds.includes('delete') ? '-' : f.kinds.includes('add') && f.kinds.length === 1 ? '+' : '~';

  const whatNow = whatLines(state, activeCall, currentTurn, files, status)[0];

  return {
    strip,
    explained: state.explained,
    verdict: verdict(state, status, activeCall, lastPass, attention.length, files),
    report: {
      whatNow,
      editing:
        activeCall && (activeCall.kind === 'fileEdit' || activeCall.kind === 'fileWrite')
          ? activeCall.title
          : files[0]?.path,
      ask: currentTurn?.prompt
        ? {
            text: clip(currentTurn.prompt, 300),
            epistemic: 'reported',
            refs: [],
            at: currentTurn.startedAt,
            author: 'user',
          }
        : undefined,
      plan: state.plan.items.map((i) => ({ text: i.text, status: i.status })),
      files: files.map((f) => ({ path: f.path, mark: markOf(f) })),
      runtimeMs: state.startedAt
        ? Math.max(
            0,
            (state.lastEventAt ? Date.parse(state.lastEventAt) : now) - Date.parse(state.startedAt),
          )
        : undefined,
    },
    review: {
      glance:
        attention.length === 0
          ? openReview.length === 0
            ? 'Nothing needs you'
            : `Nothing needs you · ${openReview.length} noted`
          : `${attention.length} item${attention.length === 1 ? '' : 's'} need attention`,
      items: reviewRows,
      groups: groupReview(reviewRows),
      resolvedCount: state.review.length - openReview.length,
    },
    changes: {
      glance: changesGlance(state),
      files: files.map((f) => toFileRow(state, f, lastPass)),
      commands: state.activityOrder
        .map((id) => state.activities[id])
        .filter((a): a is Activity =>
          Boolean(a && a.kind === 'command' && a.input.kind === 'command'),
        )
        .map((a) => toCommandRow(state, a)),
      commits: state.git.commits.map((c) => ({ sha: c.sha, at: c.at, callId: c.callId })),
    },
    verified: {
      glance: verifiedGlance(state, latestVerification),
      runs: verificationRows.slice().reverse(),
      summary: summarizeByMethod(verificationRows),
      unverifiedFiles: files
        .filter((f) => !lastPass || f.lastChangedAt > lastPass.at)
        .map((f) => f.path),
      claims: state.claims.filter((c) => c.kind === 'verification').map((c) => claimLine(c)),
    },
    left,
    turns: state.turns.map((t) => toTurnRow(state, t, verificationRows)),
    subagents: Object.values(state.subagents).map((s) => ({ ...s })),
    ingest: {
      warnings: state.counters.ingestWarnings,
      redactions: state.counters.redactions,
      compactions: state.counters.compactions,
    },
    usage:
      state.usage.messages > 0
        ? {
            messages: state.usage.messages,
            inputTokens: state.usage.inputTokens,
            outputTokens: state.usage.outputTokens,
            cacheReadTokens: state.usage.cacheReadTokens,
            cacheWriteTokens: state.usage.cacheWriteTokens,
          }
        : undefined,
  };
}

// ---------------------------------------------------------------------------------------------

function severityRank(s: ReviewItem['severity']): number {
  return s === 'high' ? 3 : s === 'medium' ? 2 : s === 'low' ? 1 : 0;
}

/** Checks that failed and have had no later full-scope pass of the same method to clear them. */
function unclearedFailures(state: RunState): Verification[] {
  return state.verifications.filter(
    (v) =>
      v.outcome === 'fail' &&
      !state.verifications.some(
        (w) =>
          w.at >= v.at &&
          w.seq !== v.seq &&
          w.method === v.method &&
          w.outcome === 'pass' &&
          w.scope !== 'partial',
      ),
  );
}

function countAfter(files: FileState[], at: string | undefined): number {
  return at === undefined ? files.length : files.filter((f) => f.lastChangedAt > at).length;
}

/**
 * The single derived answer, by rules in priority order: a blocked agent outranks a failing
 * check, which outranks work in progress, which outranks unverified edits, which outranks a
 * pass. Every branch reports its own epistemic class, so an inferred pass never reads like an
 * observed one.
 */
function verdict(
  state: RunState,
  status: SessionStatus,
  active: Activity | undefined,
  lastPass: Verification | undefined,
  attention: number,
  files: FileState[],
): VerdictView {
  const changed = state.counters.filesChanged;
  const noun = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

  if (status === 'waiting' && state.waiting)
    return {
      headline: 'Waiting for you',
      tone: 'attention',
      epistemic: 'observed',
      because: state.waiting.summary,
      at: state.waiting.since,
      refs: [],
    };

  const failure = unclearedFailures(state).pop();
  if (failure) {
    const since = countAfter(files, failure.at);
    return {
      headline: describeVerification(failure),
      tone: 'fail',
      epistemic: failure.outcomeEpistemic,
      because:
        since > 0
          ? `${noun(since)} changed after this check, so it may be out of date.`
          : failure.caveats.includes('exit-inferred')
            ? 'Read from the output; the command reported no exit code.'
            : undefined,
      at: failure.at,
      refs: [failure.callId],
    };
  }

  if (status === 'working' && active)
    return {
      headline: active.title,
      tone: 'working',
      epistemic: 'observed',
      because: changed > 0 ? `${changesGlance(state)} so far.` : undefined,
      at: active.startedAt,
      refs: [active.callId],
    };

  const staleFor = countAfter(files, lastPass?.at);
  if (changed > 0 && staleFor > 0)
    return {
      headline: `${noun(changed)} changed, unverified`,
      tone: 'attention',
      epistemic: 'observed',
      because: lastPass
        ? `${noun(staleFor)} changed after the last passing check (${describeVerification(lastPass)}).`
        : 'No passing test, build or typecheck run was observed in this session.',
      at: lastPass?.at,
      refs: lastPass ? [lastPass.callId] : [],
    };

  if (lastPass)
    return {
      headline: describeVerification(lastPass),
      tone: 'pass',
      epistemic: lastPass.outcomeEpistemic,
      because: lastPass.caveats.includes('exit-inferred')
        ? 'Read from the output; the command reported no exit code.'
        : changed > 0
          ? `Ran after the last of ${noun(changed)} changed.`
          : undefined,
      at: lastPass.at,
      refs: [lastPass.callId],
    };

  if (attention > 0)
    return {
      headline: `${attention} thing${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} you`,
      tone: 'attention',
      epistemic: 'inferred',
      refs: [],
    };

  if (changed > 0)
    return {
      headline: `${noun(changed)} changed`,
      tone: 'neutral',
      epistemic: 'observed',
      because: 'No checks were observed in this session.',
      refs: [],
    };

  return {
    headline: state.turns.length === 0 ? 'Nothing recorded yet' : 'No files changed',
    tone: 'neutral',
    epistemic: 'observed',
    refs: [],
  };
}

function claimLine(c: Claim): Line {
  return {
    text: c.text,
    epistemic: 'reported',
    refs: [c.id],
    at: c.ts,
    author: c.agentId ? 'subagent' : 'agent',
  };
}

/**
 * The agent's own account of what it is doing. Derived facts belong in `verdict` and the
 * counters; this is narration, always attributed and quoted by the client. Empty means the
 * agent has said nothing yet — the client omits the row rather than printing a placeholder.
 *
 * This is the one place a claim below the threshold is still shown, and it is allowed because of
 * what it asserts: "the agent said this", under no heading and with no kind. That is true of any
 * claim. It is also why the line carries no facet — the same sentence appearing here and under a
 * heading one screen away, each with its own `record` link to the same event, is what made How
 * print What's sentence verbatim.
 */
function whatLines(
  state: RunState,
  active: Activity | undefined,
  turn: Turn | undefined,
  files: FileState[],
  status: SessionStatus,
): Line[] {
  const lines: Line[] = [];
  if (status === 'working' && turn) {
    // Between tool calls: the agent's most recent narration for this turn.
    const latest = [...state.claims]
      .reverse()
      .find((c) => c.turnId === turn.id && !c.agentId && c.kind !== 'question');
    if (latest)
      lines.push({
        text: latest.text,
        epistemic: 'reported',
        refs: [latest.id],
        at: latest.ts,
        author: 'agent',
      });
    else if (turn.headline)
      lines.push({
        text: turn.headline,
        epistemic: 'reported',
        refs: [],
        at: turn.startedAt,
        author: 'agent',
      });
    else
      lines.push({
        text: `Working on: ${clip(turn.prompt, 140)}`,
        epistemic: 'reported',
        refs: [],
        at: turn.startedAt,
        author: 'user',
      });
  } else if (turn?.lastMessage) {
    /*
     * The turn is over, so the statement is the agent's report on it. A `summary` claim is that
     * report by definition; failing one, the message's opening line is what a reader would read
     * first. Taking the *last* claim of any kind was neither — on a final message that ends by
     * naming what is left, it printed the leftover as the account of what happened.
     */
    const c = state.claims
      .filter((k) => k.turnId === turn.id && k.phase === 'final' && k.kind === 'summary')
      .pop();
    lines.push({
      text: c?.text ?? headlineOf(turn.lastMessage, 300),
      epistemic: 'reported',
      refs: c ? [c.id] : [],
      at: turn.endedAt,
      author: 'agent',
    });
  } else if (turn?.headline) {
    lines.push({
      text: turn.headline,
      epistemic: 'reported',
      refs: [],
      at: turn.startedAt,
      author: 'agent',
    });
  }
  const recent = files.slice(0, 6);
  if (active === undefined && recent.length > 0)
    lines.push({
      text: `Recently: ${recent.map((f) => basename(f.path)).join(', ')}`,
      epistemic: 'observed',
      refs: recent.map((f) => f.lastCallId),
    });
  const commits = state.git.commits;
  if (commits.length > 0)
    lines.push({
      text: `${commits.length} commit${commits.length === 1 ? '' : 's'}: ${commits.map((c) => shortSha(c.sha || '???????')).join(', ')}`,
      epistemic: 'observed',
      refs: commits.map((c) => c.callId ?? '').filter(Boolean),
    });
  return lines;
}

function changesGlance(state: RunState): string {
  const c = state.counters;
  const parts: string[] = [];
  parts.push(
    c.filesChanged === 0
      ? 'No files changed'
      : `${c.filesChanged} file${c.filesChanged === 1 ? '' : 's'} changed (+${c.linesAdded} −${c.linesRemoved})`,
  );
  if (c.commands > 0) parts.push(`${c.commands} command${c.commands === 1 ? '' : 's'}`);
  if (state.git.commits.length > 0)
    parts.push(`${state.git.commits.length} commit${state.git.commits.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function verifiedGlance(state: RunState, latest: VerificationRow | undefined): string {
  if (!latest) return state.counters.filesChanged > 0 ? 'No checks observed' : 'No checks yet';
  return `${latest.label}${latest.stale ? ' — before latest changes' : ''}`;
}

/**
 * The latest readable run of each method, in the order the methods were first run, with a count of
 * anything later that could not be read. `rows` is in run order, oldest first.
 */
function summarizeByMethod(rows: VerificationRow[]): VerificationSummaryRow[] {
  const chosen = new Map<string, VerificationSummaryRow>();
  for (const r of rows) {
    const held = chosen.get(r.method);
    if (r.outcome === 'unknown') {
      // Nothing readable yet: hold the latest run so the method is still named. Otherwise it only
      // records that a later run said nothing.
      if (!held) chosen.set(r.method, { ...r, laterUnreadable: 0 });
      else if (held.outcome !== 'unknown') held.laterUnreadable += 1;
      else chosen.set(r.method, { ...r, laterUnreadable: 0 });
      continue;
    }
    chosen.set(r.method, { ...r, laterUnreadable: 0 });
  }
  return [...chosen.values()];
}

function toVerificationRow(state: RunState, v: Verification): VerificationRow {
  const turn = v.turnId ? state.turns.find((t) => t.id === v.turnId) : undefined;
  return {
    id: v.id,
    callId: v.callId,
    at: v.at,
    label: describeVerification(v),
    method: v.method,
    runner: v.runner,
    outcome: v.outcome,
    counts: v.counts,
    scope: v.scope,
    exit: v.exit,
    epistemic: v.outcomeEpistemic,
    caveats: v.caveats,
    stale: v.stale,
    command: v.command,
    failureExcerpt: v.failureExcerpt,
    turnIndex: turn?.index,
  };
}

function toReviewRow(r: ReviewItem): ReviewRow {
  return {
    id: r.id,
    rule: r.rule,
    severity: r.severity,
    label: r.label,
    instance: r.instance,
    summary: r.summary,
    detail: r.detail,
    refs: r.refs,
    createdAt: r.createdAt,
    epistemic: r.epistemic,
  };
}

/**
 * Rows to groups: one per rule, worst severity first and most recent within that, with identical
 * occurrences folded. Order is preserved from the already-sorted rows, so a group's position is
 * that of its most alarming member.
 */
function groupReview(rows: ReviewRow[]): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const row of rows) {
    const g = groups.get(row.rule);
    if (!g) {
      groups.set(row.rule, {
        rule: row.rule,
        label: row.label,
        severity: row.severity,
        occurrences: 1,
        items: [{ ...row, repeats: 1 }],
        createdAt: row.createdAt,
      });
      continue;
    }
    g.occurrences++;
    if (severityRank(row.severity) > severityRank(g.severity)) g.severity = row.severity;
    if (row.createdAt > g.createdAt) g.createdAt = row.createdAt;
    // Fold by what the reader would actually see repeated. A rule with no instance text (one
    // sentence, e.g. "3 files changed since the last passing check") folds on the label.
    const key = row.instance ?? row.label;
    const same = g.items.find((i) => (i.instance ?? i.label) === key);
    if (same) same.repeats++;
    else g.items.push({ ...row, repeats: 1 });
  }
  return [...groups.values()];
}

function toFileRow(state: RunState, f: FileState, lastPass: Verification | undefined): FileRow {
  const turnIndexes = f.turnIds
    .map((id) => state.turns.find((t) => t.id === id)?.index)
    .filter((i): i is number => i !== undefined);
  const lastTurnId = f.turnIds[f.turnIds.length - 1];
  const reason = lastTurnId ? nearestReason(state, lastTurnId, f) : undefined;
  return {
    path: f.path,
    changeCount: f.changeCount,
    linesAdded: f.linesAdded,
    linesRemoved: f.linesRemoved,
    kinds: f.kinds,
    lastChangedAt: f.lastChangedAt,
    lastCallId: f.lastCallId,
    verifiedAfter: lastPass !== undefined && lastPass.at > f.lastChangedAt,
    verifiedBy:
      lastPass !== undefined && lastPass.at > f.lastChangedAt
        ? describeVerification(lastPass)
        : undefined,
    turnIndexes,
    reason,
  };
}

/**
 * Nearest preceding narration by time (attributed, inferred binding). Files changed by a
 * subagent are explained by that subagent's own narration or its delegation description.
 */
function nearestReason(state: RunState, turnId: string, f: FileState): Line | undefined {
  const lane = f.lastAgentId;
  const candidates = state.claims
    .filter(
      (c) =>
        (lane ? c.agentId === lane : c.turnId === turnId && !c.agentId) &&
        c.ts <= f.lastChangedAt &&
        (c.kind === 'approach' || c.kind === 'discovery' || c.kind === 'status'),
    )
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const name = basename(f.path).replace(/\.[^.]+$/, '');
  const mention = [...candidates].reverse().find((c) => name.length > 2 && c.text.includes(name));
  const pick = mention ?? candidates[candidates.length - 1];
  if (pick)
    return {
      text: pick.text,
      epistemic: 'reported',
      refs: [pick.id],
      at: pick.ts,
      author: lane ? 'subagent' : 'agent',
    };
  if (lane) {
    const sub = state.subagents[lane];
    if (sub?.description)
      return {
        text: `Subagent: ${sub.description}`,
        epistemic: 'observed',
        refs: [],
        at: sub.startedAt,
        author: 'subagent',
      };
  }
  return undefined;
}

function toCommandRow(state: RunState, a: Activity): CommandRow {
  const input = a.input.kind === 'command' ? a.input : undefined;
  const turn = a.turnId ? state.turns.find((t) => t.id === a.turnId) : undefined;
  return {
    callId: a.callId,
    command: input?.command ?? a.title,
    description: input?.description,
    at: a.startedAt,
    status: a.status,
    exit: a.exit,
    durationMs: a.durationMs,
    isVerification: state.verifications.some((v) => v.callId === a.callId),
    turnIndex: turn?.index,
    agentId: a.agentId,
  };
}

function leftSection(state: RunState): SessionView['left'] {
  const items: LeftRow[] = [];
  for (const i of state.plan.items) {
    if (i.status === 'pending' || i.status === 'in_progress')
      items.push({
        id: `plan:${i.id}`,
        text: i.text,
        status: i.status,
        epistemic: 'planned',
        source: 'plan',
        refs: [],
      });
  }
  const failing = unclearedFailures(state);

  const seen = new Set<string>();
  for (const v of failing) {
    if (seen.has(v.method)) continue;
    seen.add(v.method);
    items.push({
      id: `verification:${v.id}`,
      text: describeVerification(v),
      status: 'failing',
      epistemic: v.outcomeEpistemic,
      source: 'verification',
      refs: [v.callId],
    });
  }
  const lastTurn = state.turns[state.turns.length - 1];
  /*
   * `looksLikeTask` used to be applied here, and only here, while the change log took the same
   * claims ungated. It is the classifier's `remaining` rule now, so a claim that reaches this
   * point is already shaped like a task and the gate is not repeated: a filter re-applied at the
   * point of use is how the same defect came to be fixed in four places and fixed nowhere.
   */
  const remainingClaims = state.claims.filter(
    (c) => c.kind === 'remaining' && !c.agentId && (!lastTurn || c.turnId === lastTurn.id),
  );
  for (const c of remainingClaims.slice(-5))
    items.push({
      id: `claim:${c.id}`,
      text: c.text,
      status: 'reported',
      epistemic: 'reported',
      source: 'agent',
      refs: [c.id],
    });
  const pending = state.plan.items.filter(
    (i) => i.status === 'pending' || i.status === 'in_progress',
  ).length;
  const parts: string[] = [];
  if (state.plan.items.length > 0)
    parts.push(
      pending === 0
        ? 'All plan steps done'
        : `${pending} of ${state.plan.items.length} steps remaining`,
    );
  if (failing.length > 0)
    parts.push(`${failing.length} failing check${failing.length === 1 ? '' : 's'}`);
  if (remainingClaims.length > 0)
    parts.push(
      `${remainingClaims.length} item${remainingClaims.length === 1 ? '' : 's'} agent says remain`,
    );
  return {
    glance: parts.length
      ? parts.join(' · ')
      : items.length === 0
        ? 'Nothing recorded as remaining'
        : `${items.length} remaining`,
    items,
    planExplanation: state.plan.explanation,
  };
}

function toTurnRow(state: RunState, t: Turn, verificationRows: VerificationRow[]): TurnRow {
  const activities = t.activityIds
    .map((id) => state.activities[id])
    .filter((a): a is Activity => Boolean(a));
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const a of activities) {
    if (a.result?.kind === 'fileChanges')
      for (const c of a.result.changes) {
        linesAdded += c.linesAdded;
        linesRemoved += c.linesRemoved;
      }
  }
  return {
    id: t.id,
    index: t.index,
    // A turn header is a label, not the message. A first prompt can be a long briefing document, so
    // laying it into the flow whole would open the visualization with a wall of instructions.
    prompt: clip(t.prompt, 120),
    headline: t.headline,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    outcome: t.outcome,
    lastMessage: t.lastMessage,
    activityCount: activities.length,
    files: t.filesTouched,
    linesAdded,
    linesRemoved,
    verifications: verificationRows.filter((v) => t.verificationIds.includes(v.id)),
    activities: activities.map((a) => ({
      callId: a.callId,
      kind: a.kind,
      title: a.title,
      toolName: a.toolName,
      startedAt: a.startedAt,
      durationMs: a.durationMs,
      status: a.status,
      agentId: a.agentId,
      isVerification: t.verificationIds.includes(a.callId),
      exit: a.exit,
      eventIds: a.eventIds,
    })),
    claims: state.claims.filter((c) => c.turnId === t.id).map(claimLine),
  };
}
