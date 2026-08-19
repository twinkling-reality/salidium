import type { ActivityRow, CommitRow, TurnRow, VerificationRow } from '@salidium/core';
import { useState } from 'react';
import { basename, timeOfDay } from '../lib/format.ts';

/**
 * What the agent did, in order, as a flow rather than a count.
 *
 * The charts elsewhere answer "how much"; this answers "what happened, and in what order" — the
 * question you actually have when you come back to a session. Runs of the same kind of work
 * collapse into one labelled step ("edited 8 files") so the shape of the session survives, while
 * the moments that decide whether to trust it — checks and commits — always get their own step
 * and never merge into anything.
 *
 * The step that matters most is the one that is missing: when edits come after the last check,
 * the flow ends on an explicit "nothing checked this" step, because absence is invisible in a
 * list and is exactly what a human needs to catch.
 */

type Step =
  | {
      kind: 'work';
      bucket: Bucket;
      label: string;
      detail?: string;
      at: string;
      refs: string[];
      /** Incidental work, merged and dimmed: it changed nothing on its own. */
      quiet: boolean;
    }
  | { kind: 'check'; row: VerificationRow }
  | { kind: 'commit'; sha: string; at: string; callId?: string }
  | { kind: 'gap'; label: string };

type Bucket = 'edit' | 'read' | 'run' | 'delegate' | 'look' | 'plan';

const BUCKET: Record<ActivityRow['kind'], Bucket> = {
  fileEdit: 'edit',
  fileWrite: 'edit',
  fileRead: 'read',
  search: 'read',
  command: 'run',
  subagent: 'delegate',
  webFetch: 'look',
  webSearch: 'look',
  mcp: 'look',
  plan: 'plan',
  question: 'plan',
  other: 'run',
};

/** Incidental steps shorter than this do not break a run of the same work. */
const SMOOTH = 4;

const VERB: Record<Bucket, (n: number) => string> = {
  edit: (n) => `edited ${n} ${n === 1 ? 'file' : 'files'}`,
  read: (n) => `read ${n} ${n === 1 ? 'file' : 'files'}`,
  run: (n) => `ran ${n} ${n === 1 ? 'command' : 'commands'}`,
  delegate: (n) => `delegated to ${n} ${n === 1 ? 'subagent' : 'subagents'}`,
  look: (n) => `${n} ${n === 1 ? 'lookup' : 'lookups'}`,
  plan: (n) => `planned (${n})`,
};

/*
 * A step's glyph says what kind of work it was, and none of them may be a control shape. `read`
 * was `›`, which is the chevron this app uses on the turn above it to mean "open" — so a marker
 * that only names a kind sat one line under a marker that opens something, wearing the same
 * shape, next to a label that does open something. It reads as a disclosure, and clicking it does
 * not disclose.
 */
const GLYPH: Record<Bucket, string> = {
  edit: '±',
  read: '⋯',
  run: '$',
  delegate: '⇢',
  look: '@',
  plan: '☰',
};

/** Pulls a filename out of a tool title, which is usually "Tool /some/path" or a bare path. */
function fileFromTitle(title: string): string | undefined {
  const token = title.split(/\s+/).find((t) => t.includes('/') || /\.[a-z0-9]+$/i.test(t));
  return token ? basename(token) : undefined;
}

/**
 * Only editing changes the world. Delegating, reading and running things are how the agent got
 * there, and they merge into the quiet step — otherwise a session that fans out to a dozen
 * subagents renders as "delegated to 1 subagent" a dozen times and buries the two edits.
 */
const MAJOR: ReadonlySet<Bucket> = new Set<Bucket>(['edit']);

/**
 * Collapses the flow to the steps that decide anything. Edits, checks, commits and delegations
 * stand alone; reading, searching and incidental commands merge into a single quiet step, however
 * many kinds they span. Without that merge the flow degenerates into "ran 1 command / read 1 file"
 * repeated forty times, which is the log this view exists to replace.
 */
function toSteps(turn: TurnRow, commits: CommitRow[]): Step[] {
  const checks = new Map(turn.verifications.map((v) => [v.callId, v]));
  const commitBy = new Map(commits.filter((c) => c.callId).map((c) => [c.callId as string, c]));
  const steps: Step[] = [];
  let major: { bucket: Bucket; items: ActivityRow[] } | undefined;
  let minor: ActivityRow[] = [];

  const flushMajor = () => {
    if (!major) return;
    const names = [...new Set(major.items.map((a) => fileFromTitle(a.title)).filter(Boolean))];
    // Ten edits to one file is one file edited ten times, not ten files.
    const label =
      major.bucket === 'edit' && names.length === 1
        ? `edited ${names[0]}${major.items.length > 1 ? ` (${major.items.length}\u00d7)` : ''}`
        : VERB[major.bucket](names.length || major.items.length);
    steps.push({
      kind: 'work',
      bucket: major.bucket,
      label,
      detail: names.length > 1 ? names.slice(0, 3).join(', ') : undefined,
      at: major.items[0]?.startedAt ?? '',
      refs: major.items.map((a) => a.callId),
      quiet: false,
    });
    major = undefined;
  };
  const flushMinor = () => {
    if (minor.length === 0) return;
    const counts = new Map<Bucket, number>();
    for (const a of minor) {
      const b = BUCKET[a.kind];
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    steps.push({
      kind: 'work',
      bucket: 'read',
      label: [...counts.entries()].map(([b, n]) => VERB[b](n)).join(', '),
      at: minor[0]?.startedAt ?? '',
      refs: minor.map((a) => a.callId),
      quiet: true,
    });
    minor = [];
  };
  const flushAll = () => {
    flushMajor();
    flushMinor();
  };

  for (const a of turn.activities) {
    const check = checks.get(a.callId);
    if (check) {
      flushAll();
      steps.push({ kind: 'check', row: check });
      continue;
    }
    const commit = commitBy.get(a.callId);
    if (commit) {
      flushAll();
      steps.push({ kind: 'commit', sha: commit.sha, at: commit.at, callId: commit.callId });
      continue;
    }
    const bucket = BUCKET[a.kind];
    if (MAJOR.has(bucket)) {
      // A short interlude between two stretches of the same work is not a step of its own; it
      // is how the agent got from one edit to the next, and breaking on it shreds the flow.
      if (major && major.bucket === bucket && minor.length < SMOOTH) {
        minor = [];
        major.items.push(a);
      } else {
        // Order matters: the run that was already open happened before the interlude did.
        flushMajor();
        flushMinor();
        major = { bucket, items: [a] };
      }
    } else {
      minor.push(a);
    }
  }
  flushAll();

  // The absent step: edits after the last check are the thing a list will never show you.
  const lastCheck = steps.map((s) => s.kind === 'check').lastIndexOf(true);
  const editsAfter = steps
    .slice(lastCheck + 1)
    .some((s) => s.kind === 'work' && s.bucket === 'edit');
  if (editsAfter) steps.push({ kind: 'gap', label: 'nothing checked these edits' });
  return steps;
}

const TURN_PAGE = 6;

export function SessionFlow({
  turns,
  commits,
  onRef,
}: {
  turns: TurnRow[];
  commits: CommitRow[];
  onRef: (ref: string) => void;
}) {
  const [shown, setShown] = useState(TURN_PAGE);
  if (turns.length === 0) return null;
  const visible = turns.length > shown ? turns.slice(turns.length - shown) : turns;
  const hidden = turns.length - visible.length;
  return (
    <section className="viz" aria-label="What the agent did, in order">
      <h3 className="viz-title">
        What happened <span className="viz-count num">{turns.length} turns</span>
      </h3>
      {hidden > 0 && (
        <button type="button" className="flow-more" onClick={() => setShown((n) => n + TURN_PAGE)}>
          show {Math.min(TURN_PAGE, hidden)} earlier {hidden === 1 ? 'turn' : 'turns'}
        </button>
      )}
      <ol className="flow">
        {visible.map((t, i) => (
          <FlowTurn
            key={t.id}
            turn={t}
            commits={commits}
            onRef={onRef}
            defaultOpen={i === visible.length - 1}
          />
        ))}
      </ol>
    </section>
  );
}

/**
 * One turn: the ask, what it came to, and its steps underneath when you want them.
 *
 * Every turn used to print every step, which can turn a short session into a long column of rows
 * reading "ran 2 commands". A turn is the
 * unit the reader thinks in (it is one thing they asked for), so it is the unit that folds, and the
 * latest one is open because that is the one they came back for.
 *
 * What survives the fold is what the flow exists to say: how many steps, whether anything checked
 * them, and whether it was committed. The absence step in particular is carried up to the header —
 * "nothing checked these edits" is the whole reason this visualization ends the way it does, and a
 * warning that only exists inside a collapsed section is a warning that does not exist.
 */
function FlowTurn({
  turn,
  commits,
  onRef,
  defaultOpen,
}: {
  turn: TurnRow;
  commits: CommitRow[];
  onRef: (ref: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const steps = toSteps(turn, commits);
  const checks = steps.filter((s) => s.kind === 'check');
  const failed = checks.filter((s) => s.kind === 'check' && s.row.outcome === 'fail').length;
  const passed = checks.filter((s) => s.kind === 'check' && s.row.outcome === 'pass').length;
  const unchecked = steps.some((s) => s.kind === 'gap');
  return (
    <li className={`flow-turn ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="flow-ask"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {/*
         * The number leads, because it is the row's identity and the column every step below it
         * hangs from. A caret in front of it put two marks in the slot the eye uses to find the
         * ordinal, and pushed the column off the rule the steps nest against.
         */}
        <span className="flow-ask-n num">{turn.index + 1}</span>
        <span className="flow-ask-text">{turn.prompt || '(prompt not recorded)'}</span>
        {/*
         * One reading, not four. This row carried `39 steps ✓6 ✕4 ◆7`. A step count measures how
         * much the agent said rather than what came of it — the objection that removed the raw
         * event count from the masthead — and a commit count is a fact about the repository that
         * the churn view already holds. What a reader wants from a collapsed turn is whether it
         * went wrong, so that is all it says, and it says nothing at all when nothing did.
         */}
        <span className="flow-sum">
          {unchecked && <span className="flow-chip flow-sum-gap">unchecked</span>}
          {failed > 0 ? (
            <span className="flow-chip flow-sum-bad">
              <span className="num">{failed}</span> failed
            </span>
          ) : (
            passed > 0 && (
              <span className="flow-chip flow-sum-ok">
                <span className="num">{passed}</span> passed
              </span>
            )
          )}
        </span>
        {/* The affordance sits where a row's disclosure sits: at the end, clear of the ordinal. */}
        <span className="flow-ask-caret" aria-hidden="true">
          ›
        </span>
      </button>
      {open && (
        <ol className="flow-steps">
          {steps.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional by construction.
            <FlowStep key={i} step={s} onRef={onRef} />
          ))}
        </ol>
      )}
    </li>
  );
}

function FlowStep({ step, onRef }: { step: Step; onRef: (ref: string) => void }) {
  if (step.kind === 'gap') {
    return (
      <li className="flow-step is-gap">
        <span className="flow-node" aria-hidden="true">
          !
        </span>
        <span className="flow-label">{step.label}</span>
      </li>
    );
  }
  if (step.kind === 'check') {
    const v = step.row;
    const glyph = v.outcome === 'pass' ? '✓' : v.outcome === 'fail' ? '✕' : '?';
    return (
      <li className={`flow-step is-check v-${v.outcome}`}>
        <span className="flow-node" aria-hidden="true">
          {glyph}
        </span>
        <button type="button" className="flow-label as-button" onClick={() => onRef(v.callId)}>
          {v.label}
          {v.epistemic === 'inferred' && <span className="flow-derived">derived</span>}
        </button>
        <span className="flow-at mono">{timeOfDay(v.at)}</span>
      </li>
    );
  }
  if (step.kind === 'commit') {
    return (
      <li className="flow-step is-commit">
        <span className="flow-node" aria-hidden="true">
          ◆
        </span>
        <button
          type="button"
          className="flow-label as-button"
          onClick={() => step.callId && onRef(step.callId)}
        >
          committed <span className="mono">{step.sha.slice(0, 7)}</span>
        </button>
        <span className="flow-at mono">{timeOfDay(step.at)}</span>
      </li>
    );
  }
  return (
    <li className={`flow-step is-${step.bucket} ${step.quiet ? 'is-quiet' : ''}`}>
      <span className="flow-node" aria-hidden="true">
        {GLYPH[step.bucket]}
      </span>
      <button
        type="button"
        className="flow-label as-button"
        onClick={() => step.refs[0] && onRef(step.refs[0])}
      >
        {step.label}
        {step.detail && <span className="flow-detail mono">{step.detail}</span>}
      </button>
      <span className="flow-at mono">{timeOfDay(step.at)}</span>
    </li>
  );
}
