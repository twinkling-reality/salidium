import type {
  ExplanationStatus,
  FileRepository,
  Provenance,
  RevisionAnchor,
  SessionEntry,
  SessionReport,
  SessionStatus,
  Statement,
  VerificationRun,
} from '@salidium/consumer-contract';
import type {
  FileLocation,
  Line,
  RunState,
  RevisionAnchor as RunStateAnchor,
  SessionView,
  VerificationRow,
  WaitingState,
} from '@salidium/core';
import { clip, createRedactor, ownEntry, WORKING_STALE_MS } from '@salidium/core';
import type { Epistemic, SessionSummary, ToolKind } from '@salidium/protocol';
import { explanationIsCurrent } from '../sessions/sessionCoordinator.ts';

/**
 * Salidium's private projection, minimized into the consumer contract.
 *
 * The report carries findings, not content. What crosses is Salidium's own wording (headlines,
 * labels, glances), observed identifiers and counts (paths, SHAs, line counts, exit codes), short
 * attributed statements the claim classifier already isolated, the fragment that is a review
 * finding, and the optional generated explanation. What does not cross, by construction rather than
 * by filtering: prompts, full agent messages, command lines, command output, tool inputs, turn and
 * activity lists, event ids, and provider file references. There is no field for any of them.
 *
 * Text that does cross passes the redactor again. Events were redacted at ingest; running it at the
 * boundary covers records ingested before a rule existed, and costs little. Each document gets its
 * own redactor; see `redactedDocument`.
 *
 * The mappings below are exhaustive over Salidium's internal vocabularies, so a new internal value
 * fails the type check here instead of leaking an unlisted value into a closed contract enum.
 */

const PROVENANCE: Record<Epistemic, Provenance> = {
  observed: 'observed',
  reported: 'reported',
  inferred: 'inferred',
  planned: 'planned',
  explained: 'explained',
};

const STATUS: Record<SessionSummary['status'], SessionStatus> = {
  working: 'working',
  idle: 'idle',
  waiting: 'waiting',
  ended: 'ended',
  unknown: 'unknown',
};

const EXPLANATION: Record<NonNullable<SessionSummary['explanationStatus']>, ExplanationStatus> = {
  generated: 'generated',
  generating: 'generating',
  disabled: 'disabled',
  unavailable: 'unavailable',
  failed: 'failed',
};

const WAITING: Record<WaitingState['kind'], NonNullable<SessionReport['waiting']>['kind']> = {
  permission: 'permission',
  question: 'question',
  input: 'input',
};

/**
 * What a working session is doing, in Salidium's words. The interface shows the current tool
 * call's title, which for a command is the command line; the contract names the kind of work and,
 * for a file, its path, which is an observed identifier.
 */
const ACTIVITY: Record<ToolKind, string> = {
  command: 'Running a command',
  fileEdit: 'Editing a file',
  fileWrite: 'Writing a file',
  fileRead: 'Reading files',
  search: 'Searching the code',
  webFetch: 'Fetching a web page',
  webSearch: 'Searching the web',
  subagent: 'Delegating to a subagent',
  plan: 'Updating its plan',
  question: 'Asking you a question',
  mcp: 'Using a tool',
  other: 'Working',
};

function workingHeadline(state: RunState, callId: string | undefined): string {
  const activity = callId ? ownEntry(state.activities, callId) : undefined;
  if (!activity) return 'Working';
  const input = activity.input;
  if (input.kind === 'fileEdit' || input.kind === 'fileWrite')
    return `${input.kind === 'fileEdit' ? 'Editing' : 'Writing'} ${input.path}`;
  return ACTIVITY[activity.kind];
}

export interface ConsumerText {
  (value: string, max: number): string;
  (value: string | undefined, max: number): string | null;
  /** Redacted only: never clipped or reflowed, for identifiers such as paths. */
  exact(value: string): string;
}

/** Redact, then clip: clipping first could cut a secret in half and hide it from the redactor. */
function consumerText(redact: (value: string) => string): ConsumerText {
  const text = ((value: string | undefined, max: number) =>
    value === undefined ? null : clip(redact(value), max)) as ConsumerText;
  text.exact = redact;
  return text;
}

/**
 * Builds one document, a report or one session's entry, with all of its text passing one fresh
 * redactor.
 *
 * Stored text was redacted at ingest by the session's own redactor and holds its placeholders.
 * Text stored before a rule existed is redacted here for the first time, and the number it gets
 * must not be one that another field of the same document already holds for a different secret.
 * `redact` skips the numbers in the text it is given, but fields are redacted one at a time, so a
 * number handed out for an early field could be one a later field holds. When that can have
 * happened, the document is built again by a redactor that reserves the highest stored number
 * first. Most documents hold no new finding, or no stored placeholder, and are built once. A secret
 * found here never takes a stored number, even one that stands for the same secret, because the
 * stored text no longer holds the secret to compare.
 *
 * A redactor never outlives its document. One shared across documents would number a secret by
 * whichever session or request reached it first, and would carry a number it had handed out in
 * one session into another session whose stored text uses that number for something else.
 */
export function redactedDocument<T>(build: (text: ConsumerText) => T): T {
  // The text holding the highest stored number found so far, reserved before the next attempt.
  let highestIn = '';
  for (;;) {
    const redactor = createRedactor();
    const reserved = redactor.reserve(highestIn);
    let highest = reserved;
    const document = build(
      consumerText((value) => {
        const held = redactor.reserve(value);
        if (held > highest) {
          highest = held;
          highestIn = value;
        }
        return redactor.redact(value).text;
      }),
    );
    if (redactor.findingsCount === 0 || highest === reserved) return document;
  }
}

/**
 * The same staleness rule the reducer's projection applies, for summaries read from the store
 * without replaying their state: a session that stopped reporting mid-turn is not still working.
 */
export function currentStatus(summary: SessionSummary, now: number): SessionStatus {
  if (summary.status === 'working' && summary.lastEventAt) {
    const age = now - Date.parse(summary.lastEventAt);
    if (Number.isFinite(age) && age > WORKING_STALE_MS) return 'idle';
  }
  return STATUS[summary.status];
}

/**
 * A pure function of the summary, and of `now` only through `currentStatus`: the list's entry cache
 * in `routes.ts` relies on that, so anything else that varies with time belongs in its key too.
 */
export function toSessionEntry(
  summary: SessionSummary,
  now: number,
  text: ConsumerText,
): SessionEntry {
  return {
    id: summary.id,
    native: { provider: summary.provider, sessionId: summary.providerSessionId },
    // A provider's own title only. Salidium's fallback is the first line of the prompt, and prompts
    // do not cross this boundary; a summary that does not say which it holds is treated as a prompt.
    title: summary.titleSource === 'provider' ? text(summary.title, 200) : null,
    // `cwd` is required in v1, so it crosses redacted; `repositoryRoot` is nullable and follows
    // the identifier rule, as every 1.1 path and branch does.
    cwd: text.exact(summary.cwd),
    repositoryRoot: identifier(summary.repoRoot, 4096, text),
    // Nullable, so one the contract cannot carry whole is null rather than clipped into another id.
    model: identifier(summary.model, 200, text),
    status: currentStatus(summary, now),
    startedAt: summary.startedAt ?? null,
    lastEventAt: summary.lastEventAt ?? null,
    endedAt: summary.endedAt ?? null,
    evidenceSeq: summary.latestSeq,
    counts: {
      turns: summary.counts.turns,
      toolCalls: summary.counts.toolCalls,
      filesChanged: summary.counts.filesChanged,
      linesAdded: summary.counts.linesAdded,
      linesRemoved: summary.counts.linesRemoved,
      // Summaries written before the field existed predate any provider that could leave it false.
      linesRemovedExact: summary.counts.linesRemovedExact ?? true,
      reviewOpen: summary.counts.reviewOpen,
      remaining: summary.counts.remaining,
    },
    lastVerification: summary.lastVerification
      ? {
          outcome: summary.lastVerification.outcome,
          at: summary.lastVerification.at,
          provenance: PROVENANCE[summary.lastVerification.epistemic],
        }
      : null,
    explanation: summary.explanationStatus ? EXPLANATION[summary.explanationStatus] : 'none',
  };
}

/**
 * An attributed sentence, or null when the line is not one this contract carries.
 *
 * Only statements the agent made cross. A line authored by the user is prompt text (the interface
 * says "Working on: <prompt>" before the agent has narrated), and a line that is not reported is
 * not a statement at all: a file's reason can be a subagent's delegation brief, which is a tool
 * input.
 */
function statement(line: Line | undefined, text: ConsumerText): Statement | null {
  if (line?.epistemic !== 'reported' || line.author === 'user') return null;
  return {
    text: text(line.text, 600),
    provenance: 'reported',
    author: line.author ?? null,
    at: line.at ?? null,
  };
}

/**
 * An observed identifier in a nullable field crosses whole or not at all. One the redactor would
 * change, because it holds something credential-shaped, is null rather than altered, so it never
 * names a different path or branch, and two fields naming the same repository never seem to
 * differ because one was redacted. Too long is null too, because a clipped one names something
 * else.
 */
function identifier(value: string | undefined, max: number, text: ConsumerText): string | null {
  if (value === undefined || value.length > max) return null;
  return text.exact(value) === value ? value : null;
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function anchor(value: RunStateAnchor | undefined, text: ConsumerText): RevisionAnchor | null {
  if (!value) return null;
  return {
    root: identifier(value.root, 4096, text),
    head: value.head && FULL_SHA.test(value.head) ? value.head : null,
    branch: identifier(value.branch, 256, text),
    at: value.at,
    provenance: 'observed',
  };
}

export function repository(
  location: FileLocation | null | undefined,
  text: ConsumerText,
): FileRepository | null {
  if (!location) return null;
  const root = identifier(location.root, 4096, text);
  const path = identifier(location.path, 4096, text);
  if (root === null || path === null) return null;
  const mainRoot =
    location.mainRoot === undefined ? null : identifier(location.mainRoot, 4096, text);
  if (location.mainRoot !== undefined && mainRoot === null) return null;
  return { root, path, mainRoot, provenance: 'observed' };
}

function run(row: VerificationRow, text: ConsumerText): VerificationRun {
  return {
    id: row.id,
    at: row.at,
    label: text(row.label, 300),
    method: row.method,
    runner: text(row.runner, 120),
    outcome: row.outcome,
    counts: row.counts
      ? {
          passed: row.counts.passed ?? null,
          failed: row.counts.failed ?? null,
          skipped: row.counts.skipped ?? null,
          total: row.counts.total ?? null,
        }
      : null,
    scope: row.scope,
    exit: { code: row.exit.code ?? null, observation: row.exit.observation },
    provenance: PROVENANCE[row.epistemic],
    caveats: row.caveats.map((caveat) => text(caveat, 120)),
    stale: row.stale,
  };
}

/** A path is required wherever it appears and never clipped, so the contract's bound is a limit. */
export const MAX_CONSUMER_PATH = 4096;

/**
 * Builds the report. A changed file whose path cannot cross whole, which redaction can cause by
 * lengthening it, is left out of `changes.files` and `verification.unverifiedFiles`; the contract
 * has no count of omitted files, so each one is passed to `omitted` by length for the caller to log.
 */
export function toSessionReport(
  state: RunState,
  view: SessionView,
  summary: SessionSummary,
  now: number,
  text: ConsumerText,
  omitted: (pathLength: number) => void = () => {},
): SessionReport {
  const session = toSessionEntry(summary, now, text);
  const carried = (path: string): string | undefined => {
    const crossing = text.exact(path);
    if (crossing.length <= MAX_CONSUMER_PATH) return crossing;
    omitted(crossing.length);
    return undefined;
  };
  const explained = view.explained;
  const current = explained ? explanationIsCurrent(summary.latestSeq, explained.basedOnSeq) : false;
  return {
    format: 'salidium.session-report',
    version: 2,
    generatedAt: new Date(now).toISOString(),
    session,
    verdict: {
      headline: text(
        view.verdict.tone === 'working'
          ? workingHeadline(state, view.verdict.refs[0])
          : view.verdict.headline,
        300,
      ),
      tone: view.verdict.tone,
      provenance: PROVENANCE[view.verdict.epistemic],
      because: text(view.verdict.because, 600),
      at: view.verdict.at ?? null,
    },
    latestStatement: statement(view.report.whatNow, text),
    waiting: view.strip.waiting
      ? {
          kind: WAITING[view.strip.waiting.kind],
          summary: text(view.strip.waiting.summary, 300),
          since: view.strip.waiting.since,
          provenance: PROVENANCE[view.strip.waiting.epistemic],
        }
      : null,
    revision: {
      atStart: anchor(state.git.atStart, text),
      atLatestTurnEnd: anchor(state.git.atTurnEnd, text),
    },
    changes: {
      glance: text(view.changes.glance, 300),
      files: view.changes.files.flatMap((file) => {
        // Identifiers cross whole; like every string that crosses, they pass the redactor again.
        const path = carried(file.path);
        if (path === undefined) return [];
        return {
          path,
          repository: repository(ownEntry(state.fileLocations, file.path), text),
          changeCount: file.changeCount,
          linesAdded: file.linesAdded,
          linesRemoved: file.linesRemoved,
          linesRemovedExact: !ownEntry(state.files, file.path)?.linesRemovedUnknown,
          kinds: [...file.kinds],
          lastChangedAt: file.lastChangedAt,
          coverage: {
            verifiedAfter: file.verifiedAfter,
            by: text(file.verifiedBy, 300),
            provenance: 'inferred',
          },
          reason: statement(file.reason, text),
        };
      }),
      commits: view.changes.commits.map((commit) => ({ sha: commit.sha, at: commit.at })),
    },
    verification: {
      glance: text(view.verified.glance, 300),
      runs: view.verified.runs.map((row) => run(row, text)),
      latestByMethod: view.verified.summary.map((row) => ({
        ...run(row, text),
        laterUnreadable: row.laterUnreadable,
      })),
      unverifiedFiles: view.verified.unverifiedFiles.flatMap((path) => carried(path) ?? []),
      statements: view.verified.claims.flatMap((line) => statement(line, text) ?? []),
    },
    review: {
      glance: text(view.review.glance, 300),
      open: view.review.items.length,
      resolved: view.review.resolvedCount,
      groups: view.review.groups.map((group) => ({
        rule: group.rule,
        label: text(group.label, 300),
        severity: group.severity,
        occurrences: group.occurrences,
        latestAt: group.createdAt,
        items: group.items.map((item) => ({
          id: item.id,
          label: text(item.label, 300),
          instance: text(item.instance, 200),
          createdAt: item.createdAt,
          provenance: PROVENANCE[item.epistemic],
          repeats: item.repeats,
        })),
      })),
    },
    remaining: {
      glance: text(view.left.glance, 300),
      // Remaining is built from pending and in-progress plan steps, failing checks, and reported
      // leftovers; a completed or cancelled step is not remaining, whatever the row type allows.
      items: view.left.items.flatMap((item) =>
        item.status === 'completed' || item.status === 'cancelled'
          ? []
          : [
              {
                id: item.id,
                text: text(item.text, 600),
                status: item.status,
                provenance: PROVENANCE[item.epistemic],
                source: item.source,
              },
            ],
      ),
    },
    explanation: {
      status: session.explanation,
      provenance: 'explained',
      current,
      basedOnSeq: explained?.basedOnSeq ?? null,
      generatedAt: explained?.at ?? null,
      model: text(explained?.model, 120),
      content: explained
        ? {
            what: {
              summary: text(explained.what.summary, 600),
              currently: text(explained.what.currently ?? undefined, 600),
            },
            why: {
              summary: text(explained.why.summary, 600),
              lanes: explained.why.lanes.map((lane) => ({
                title: text(lane.title, 100),
                steps: lane.steps.map((step) => text(step, 200)),
              })),
              chain: explained.why.chain.map((step) => text(step, 200)),
            },
            how: {
              summary: text(explained.how.summary, 600),
              root: text(explained.how.root ?? undefined, 200),
              steps: explained.how.steps.map((step) => text(step, 200)),
            },
            approachChange: explained.approachChange
              ? {
                  from: text(explained.approachChange.from, 200),
                  fromSteps: explained.approachChange.fromSteps.map((step) => text(step, 200)),
                  why: text(explained.approachChange.why, 600),
                  to: text(explained.approachChange.to, 200),
                  toSteps: explained.approachChange.toSteps.map((step) => text(step, 200)),
                }
              : null,
          }
        : null,
    },
    usage: view.usage ? { ...view.usage } : null,
    ingest: { ...view.ingest },
  };
}
