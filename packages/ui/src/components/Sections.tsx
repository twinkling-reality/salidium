import type {
  CommandRow,
  FileRow,
  LeftRow,
  ReviewRow,
  RunState,
  SessionView,
  VerificationRow,
} from '@salidium/core';
import type { Hunk } from '@salidium/protocol';
import { memo, useState } from 'react';
import { rowEqual } from '../lib/equal.ts';
import { dateTime, durationMs, shortPath, timeOfDay } from '../lib/format.ts';
import { DiffView } from './DiffView.tsx';
import { Loading } from './Loading.tsx';
import { epistemicClass, ProvenanceMark } from './Provenance.tsx';

export type SectionId = 'review' | 'changes' | 'verified' | 'left' | 'activity';

/** Open state is owned by SessionView, so a jump from the verdict can open its target. */
export interface SectionState {
  open: boolean;
  onToggle: () => void;
}

interface SectionProps {
  view: SessionView;
  state: RunState;
  onRef: (ref: string) => void;
  section: SectionState;
}

/**
 * Caveats are recorded as slugs so rules stay greppable, but a slug is not a sentence. The UI
 * says what the caveat means; anything unmapped falls back to the slug rather than being hidden.
 */
const CAVEAT_TEXT: Record<string, string> = {
  'exit-inferred': 'exit code not reported — read from the output',
  'exit-masked': 'exit code hidden by a pipe',
  'output-truncated': 'output was truncated',
  'scope-partial': 'ran on a subset, not the whole suite',
  'no-summary-parsed': 'no summary line found in the output',
};

function caveatText(caveats: string[]): string {
  return caveats.map((c) => CAVEAT_TEXT[c] ?? c).join(' · ');
}

/**
 * References reach the UI in two shapes — a bare tool call id, and a full event id of the form
 * `<provider>:<session>#tool:<callId>:<phase>`. Reduce both to the call so two rules pointing at
 * the same evidence can be recognised as one.
 */
function callIdOf(ref: string): string {
  return /#tool:([^:]+):/.exec(ref)?.[1] ?? ref;
}

/**
 * Collapsible section using the standard disclosure pattern: the heading holds the button, the
 * button names the panel it controls, and the section is named by its title alone.
 */
export function Section({
  id,
  title,
  glance,
  count,
  children,
  open,
  onToggle,
}: {
  id: SectionId;
  title: string;
  glance: string;
  count?: number;
  children: React.ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="sec" id={`sec-${id}`} aria-labelledby={`sec-${id}-title`}>
      <h2 className="sec-head">
        <button
          type="button"
          className="sec-toggle"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`sec-${id}-body`}
        >
          <span className="sec-title" id={`sec-${id}-title`}>
            {title}
          </span>
          {count !== undefined && count > 0 && <span className="sec-count num">{count}</span>}
          <span className="sec-glance">{glance}</span>
          <span className={`chev ${open ? 'is-open' : ''}`} aria-hidden="true">
            ›
          </span>
        </button>
      </h2>
      <div className="sec-body" id={`sec-${id}-body`} hidden={!open}>
        {open && children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

/**
 * Review is the one section that opens itself, so it renders as a plain block rather than a
 * disclosure row — if something needs a human it should not be behind a click.
 */
export function ReviewSection({ view, onRef }: SectionProps) {
  // The verdict already states one of these in full; repeating it directly underneath reads as
  // two findings when there is one. Matched on the call they point at, not on wording — the
  // rules word the same failing check as "Lint failed" and "Lint failing", and refer to it as a
  // bare call id in one place and a full event id in the other.
  const verdictCalls = new Set(view.verdict.refs.map(callIdOf));
  const items = view.review.items.filter(
    (r) => !r.refs.some((ref) => verdictCalls.has(callIdOf(ref))),
  );
  const attention = items.filter((r) => r.severity !== 'info');
  const noted = items.filter((r) => r.severity === 'info');
  if (attention.length === 0 && noted.length === 0) return null;
  return (
    <section className="sec sec-review" id="sec-review" aria-labelledby="sec-review-title">
      <h2 className="sec-head">
        <span className="sec-title" id="sec-review-title">
          {attention.length > 0 ? 'Needs you' : 'Noted'}
        </span>
        {attention.length > 0 && <span className="sec-count num">{attention.length}</span>}
      </h2>
      {attention.length > 0 && (
        <ul className="rows">
          {attention.map((r) => (
            <ReviewItem key={r.id} r={r} onRef={onRef} />
          ))}
        </ul>
      )}
      {noted.length > 0 && (
        <Disclosure label={`${noted.length} also noted`} id="review-noted">
          <ul className="rows">
            {noted.map((r) => (
              <ReviewItem key={r.id} r={r} onRef={onRef} />
            ))}
          </ul>
        </Disclosure>
      )}
    </section>
  );
}

const ReviewItem = memo(function ReviewItem({
  r,
  onRef,
}: {
  r: ReviewRow;
  onRef: (ref: string) => void;
}) {
  return (
    <li className={`row row-review sev-${r.severity} ${epistemicClass(r.epistemic)}`}>
      <span className="sr-only">{r.severity === 'info' ? 'note' : `${r.severity} severity`}</span>
      <span className="row-main">
        <span className="row-title">{r.summary}</span>
        {r.detail && <p className="row-sub">{r.detail}</p>}
        <span className="row-meta">
          <ProvenanceMark epistemic={r.epistemic} />
          <span className="mono">{timeOfDay(r.createdAt)}</span>
          {r.refs[0] && (
            <button
              type="button"
              className="link"
              onClick={() => onRef(r.refs[0] ?? '')}
              aria-label={`Open the record behind: ${r.summary}`}
            >
              record
            </button>
          )}
        </span>
      </span>
    </li>
  );
}, rowEqual);

// ---------------------------------------------------------------------------------------------

/** A plain inline expander for secondary lists inside a section. */
export function Disclosure({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="disclosure">
      <button
        type="button"
        className="disclosure-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={`disc-${id}`}
      >
        <span className={`chev ${open ? 'is-open' : ''}`} aria-hidden="true">
          ›
        </span>
        {label}
      </button>
      <div id={`disc-${id}`} hidden={!open}>
        {open && children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function ChangesSection({ view, state, onRef, section }: SectionProps) {
  const files = view.changes.files;
  const commands = view.changes.commands.filter((c) => !c.isVerification);
  return (
    <Section
      id="changes"
      title="Changed"
      glance={view.changes.glance}
      count={files.length}
      {...section}
    >
      {files.length === 0 && (
        <div className="empty-line">No files were changed by the agent's tools.</div>
      )}
      {files.length > 0 && (
        <ul className="rows">
          {files.map((f) => (
            <FileItem
              key={f.path}
              f={f}
              cwd={state.cwd}
              hunks={state.files[f.path]?.lastHunks}
              onRef={onRef}
            />
          ))}
        </ul>
      )}
      {view.changes.commits.length > 0 && (
        <Disclosure label={`${view.changes.commits.length} commits`} id="commits">
          <ul className="rows">
            {view.changes.commits.map((c) => (
              <li key={`${c.sha}-${c.at}`} className="row row-flat">
                <span className="mono">{c.sha ? c.sha.slice(0, 7) : '(sha unknown)'}</span>
                <span className="row-meta">
                  <span className="mono">{dateTime(c.at)}</span>
                  {c.callId && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => onRef(c.callId ?? '')}
                      aria-label={`Open the record for commit ${c.sha ? c.sha.slice(0, 7) : ''}`}
                    >
                      record
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {commands.length > 0 && (
        <Disclosure label={`${commands.length} other commands`} id="commands">
          <ul className="rows">
            {commands.slice(-200).map((c) => (
              <CommandItem key={c.callId} c={c} onRef={onRef} />
            ))}
          </ul>
        </Disclosure>
      )}
    </Section>
  );
}

const FileItem = memo(function FileItem({
  f,
  cwd,
  hunks,
  onRef,
}: {
  f: FileRow;
  cwd: string;
  hunks: Hunk[] | undefined;
  onRef: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rel = shortPath(f.path, cwd);
  const kind =
    f.kinds.includes('add') && f.kinds.length === 1
      ? 'new'
      : f.kinds.includes('delete')
        ? 'deleted'
        : f.kinds.includes('move')
          ? 'moved'
          : '';
  return (
    <li className={`row row-file ${f.verifiedAfter ? '' : 'is-unchecked'}`}>
      <button
        type="button"
        className="row-main as-button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Show the diff for ${rel}`}
      >
        <span className="row-title mono" title={f.path}>
          <span className="path-dir">{dirOf(rel)}</span>
          <span className="path-base">{baseOf(rel)}</span>
          {kind && <span className="row-tag">{kind}</span>}
        </span>
        <span className="row-meta">
          <span className="num diff-stat">
            <span className="add">+{f.linesAdded}</span>{' '}
            <span className="del">−{f.linesRemoved}</span>
          </span>
          {f.changeCount > 1 && <span>{f.changeCount} edits</span>}
          <span className="mono">{timeOfDay(f.lastChangedAt)}</span>
          {!f.verifiedAfter && (
            <span
              className="flag-unchecked"
              title="No full-scope passing check ran after this edit"
            >
              unchecked
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="row-expand">
          {f.verifiedAfter && f.verifiedBy && (
            <p className={`row-sub ${epistemicClass('inferred')}`}>
              {f.verifiedBy} ran after this edit. Salidium cannot tell whether that run covered this
              file.
            </p>
          )}
          {f.reason && (
            <p className="row-sub is-quote">
              <span className="attrib">{f.reason.author ?? 'agent'}</span> {f.reason.text}
            </p>
          )}
          {hunks?.length ? (
            <DiffView hunks={hunks} />
          ) : (
            <p className="row-sub">
              No diff was recorded for the latest change — the file was created or deleted, or the
              runtime did not provide one.
            </p>
          )}
          <button type="button" className="link" onClick={() => onRef(f.lastCallId)}>
            open the record
          </button>
        </div>
      )}
    </li>
  );
}, rowEqual);

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? `${rel.slice(0, i)}/` : '';
}
function baseOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(i + 1) : rel;
}

function CommandItem({ c, onRef }: { c: CommandRow; onRef: (ref: string) => void }) {
  const exit = c.exit;
  const exitLabel = !exit
    ? ''
    : exit.observation === 'explicit'
      ? `exit ${exit.code}`
      : exit.observation === 'inferred-success'
        ? 'looks ok'
        : exit.observation === 'inferred-failure'
          ? 'failed'
          : 'result unknown';
  return (
    <li className={`row row-command status-${c.status}`}>
      <button
        type="button"
        className="row-main as-button"
        onClick={() => onRef(c.callId)}
        aria-label="Open the record for this command"
      >
        <span className="row-title mono">{c.command.split('\n')[0]}</span>
        <span className="row-meta">
          {c.description && <span>{c.description}</span>}
          <span className={c.status === 'failed' ? 'bad' : ''}>
            {c.status === 'running' ? <Loading label="running" /> : exitLabel}
          </span>
          {c.durationMs !== undefined && <span className="mono">{durationMs(c.durationMs)}</span>}
          <span className="mono">{timeOfDay(c.at)}</span>
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------

export function VerifiedSection({ view, state, onRef, section }: SectionProps) {
  const runs = view.verified.runs;
  return (
    <Section
      id="verified"
      title="Checks"
      glance={view.verified.glance}
      count={runs.length}
      {...section}
    >
      {runs.length === 0 && (
        <div className="empty-line">
          No test, build, typecheck or lint command was observed.
          {state.counters.filesChanged > 0 && (
            <span className="warn-text">
              {' '}
              {state.counters.filesChanged} changed files have no evidence of verification.
            </span>
          )}
        </div>
      )}
      {runs.length > 0 && (
        <ul className="rows">
          {runs.map((v) => (
            <VerificationItem key={v.id} v={v} onRef={onRef} />
          ))}
        </ul>
      )}
      {view.verified.unverifiedFiles.length > 0 && runs.length > 0 && (
        <Disclosure
          label={`${view.verified.unverifiedFiles.length} files changed after the last passing check`}
          id="unverified"
        >
          <ul className="rows">
            {view.verified.unverifiedFiles.map((p) => (
              <li key={p} className="row row-flat mono">
                {shortPath(p, state.cwd)}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {view.verified.claims.length > 0 && (
        <Disclosure label="What the agent said about checks" id="check-claims">
          <ul className="rows">
            {view.verified.claims.slice(-5).map((c) => (
              <li key={`${c.at ?? ''}-${c.text}`} className="row row-flat is-quote">
                <span className="attrib">{c.author ?? 'agent'}</span>
                <span>{c.text}</span>
                {c.refs[0] && (
                  <button type="button" className="link" onClick={() => onRef(c.refs[0] ?? '')}>
                    record
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </Section>
  );
}

const VerificationItem = memo(function VerificationItem({
  v,
  onRef,
}: {
  v: VerificationRow;
  onRef: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const glyph =
    v.outcome === 'pass' ? '✓' : v.outcome === 'fail' ? '✕' : v.outcome === 'partial' ? '◐' : '?';
  const caveats = caveatText(v.caveats);
  return (
    <li
      className={`row row-verification v-${v.outcome} ${v.stale ? 'is-stale' : ''} ${epistemicClass(v.epistemic)}`}
    >
      <span className="v-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="sr-only">{v.outcome}</span>
      <span className="row-main">
        <span className="row-title">
          {v.label}
          {v.stale && <span className="row-tag">ran before the latest changes</span>}
          {v.scope === 'partial' && <span className="row-tag">subset</span>}
        </span>
        <span className="row-cmd mono" title={v.command}>
          {v.command.split('\n')[0]}
        </span>
        {caveats && <p className={`row-sub ${epistemicClass('inferred')}`}>{caveats}</p>}
        <span className="row-meta">
          <span className="mono">{timeOfDay(v.at)}</span>
          {v.turnIndex !== undefined && <span>turn {v.turnIndex + 1}</span>}
          {v.failureExcerpt && (
            <button
              type="button"
              className="link"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
            >
              {open ? 'hide output' : 'show output'}
            </button>
          )}
          <button
            type="button"
            className="link"
            onClick={() => onRef(v.callId)}
            aria-label={`Open the record for ${v.label}`}
          >
            record
          </button>
        </span>
        {open && v.failureExcerpt && <pre className="row-detail mono">{v.failureExcerpt}</pre>}
      </span>
    </li>
  );
}, rowEqual);

// ---------------------------------------------------------------------------------------------

export function LeftSection({ view, onRef, section }: SectionProps) {
  const items = view.left.items;
  return (
    <Section id="left" title="Left" glance={view.left.glance} count={items.length} {...section}>
      {items.length === 0 ? (
        <div className="empty-line">
          Nothing is recorded as remaining. This reflects the agent's task list and its own
          statements, not an independent judgement.
        </div>
      ) : (
        <ul className="rows">
          {items.map((i) => (
            <LeftItem key={i.id} i={i} onRef={onRef} />
          ))}
        </ul>
      )}
      {view.left.planExplanation && (
        <p className="row-sub is-quote">
          <span className="attrib">agent</span> {view.left.planExplanation}
        </p>
      )}
    </Section>
  );
}

const LeftItem = memo(function LeftItem({
  i,
  onRef,
}: {
  i: LeftRow;
  onRef: (ref: string) => void;
}) {
  const glyph =
    i.status === 'in_progress'
      ? '▶'
      : i.status === 'failing'
        ? '✕'
        : i.status === 'reported'
          ? '"'
          : '○';
  const source =
    i.source === 'plan'
      ? 'task list'
      : i.source === 'verification'
        ? 'failing check'
        : 'agent said';
  return (
    <li className={`row row-left left-${i.status} ${epistemicClass(i.epistemic)}`}>
      <span className="left-glyph mono" aria-hidden="true">
        {glyph}
      </span>
      <span className="row-main">
        <span className="row-title">{i.text}</span>
        <span className="row-meta">
          <span>{source}</span>
          {i.refs[0] && (
            <button
              type="button"
              className="link"
              onClick={() => onRef(i.refs[0] ?? '')}
              aria-label={`Open the record behind: ${i.text}`}
            >
              record
            </button>
          )}
        </span>
      </span>
    </li>
  );
}, rowEqual);
