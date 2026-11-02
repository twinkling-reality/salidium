import type {
  FileRow,
  ReviewGroup,
  SessionView,
  StripView,
  VerdictView,
  VerificationRow,
} from '@salidium/core';
import { useState } from 'react';
import { basename, commonDir, dirname, shortHome, shortPath, timeOfDay } from '../lib/format.ts';
import { outcomeGlyph } from '../lib/outcome.ts';
import { useClamped } from '../lib/useClamped.ts';
import type { Detail, PanelId } from '../store/appStore.ts';
import { Disclosure } from './Controls.tsx';
import { SessionFlow } from './SessionFlow.tsx';

export { Explained } from './canvas/NarrativeLens.tsx';

/** Files ranked by how much of them moved, so the biggest edit is obvious without reading paths. */
export function FileChurn({
  files,
  cwd,
  limit = 10,
  onOpen,
}: {
  files: FileRow[];
  cwd: string;
  limit?: number;
  onOpen: (f: FileRow) => void;
}) {
  if (files.length === 0) return null;
  const ranked = [...files]
    .sort((a, b) => b.linesAdded + b.linesRemoved - (a.linesAdded + a.linesRemoved))
    .slice(0, limit);
  const peak = Math.max(1, ...ranked.map((f) => f.linesAdded + f.linesRemoved));
  const hidden = files.length - ranked.length;
  const root = commonDir(ranked.map((f) => f.path));
  return (
    <section className="viz" aria-label={`Churn for ${files.length} changed files`}>
      <h3 className="viz-title">
        Changed <span className="viz-count num">{files.length}</span>
      </h3>
      {root && (
        <p className="viz-root mono" title={root}>
          <bdi>{shortHome(root)}</bdi>
        </p>
      )}
      <ul className="churn">
        {ranked.map((f) => {
          const total = f.linesAdded + f.linesRemoved;
          return (
            <li key={f.path} className="churn-row">
              <button type="button" className="churn-main" onClick={() => onOpen(f)}>
                <span className="churn-name mono" title={f.path}>
                  {basename(f.path)}
                  <span className="churn-dir">
                    {dirname(root ? f.path.slice(root.length) : shortPath(f.path, cwd))}
                  </span>
                </span>
                <span className="churn-bar" aria-hidden="true">
                  <span
                    className="churn-add"
                    style={{ width: `${(f.linesAdded / peak) * 100}%` }}
                  />
                  <span
                    className="churn-del"
                    style={{ width: `${(f.linesRemoved / peak) * 100}%` }}
                  />
                </span>
                <span className="churn-num num">
                  <span className="add">+{f.linesAdded}</span>
                  <span className="del">−{f.linesRemoved}</span>
                </span>
                {!f.verifiedAfter && (
                  <span className="churn-flag" title="No passing check ran after this edit">
                    ?
                  </span>
                )}
              </button>
              <span className="sr-only">
                {shortPath(f.path, cwd)}: {total} lines changed
                {f.verifiedAfter ? '' : ', unchecked since'}
              </span>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && <p className="viz-foot">{hidden} smaller changes not shown</p>}
    </section>
  );
}

/**
 * Every check that ran, by kind: what it came to last, and the run of outcomes behind it.
 */
export function CheckLanes({
  runs,
  onOpen,
}: {
  runs: VerificationRow[];
  onOpen: (v: VerificationRow) => void;
}) {
  if (runs.length === 0) return null;
  const methods = [...new Set(runs.map((r) => r.method))];
  const word = (o: VerificationRow['outcome']) =>
    o === 'pass' ? 'passing' : o === 'fail' ? 'failing' : o === 'partial' ? 'partial' : 'unknown';
  return (
    <section
      className="viz checks"
      aria-label={`${runs.length} checks across ${methods.length} kinds`}
    >
      <ul className="checks-rows">
        {methods.map((m) => {
          const mine = runs.filter((r) => r.method === m).sort((a, b) => a.at.localeCompare(b.at));
          const last = mine[mine.length - 1];
          if (!last) return null;
          const failed = mine.filter((r) => r.outcome === 'fail').length;
          return (
            <li className="checks-row" key={m}>
              <span className="checks-method">{m}</span>
              <span className={`checks-now v-${last.outcome}`}>
                <span className="checks-now-mark" aria-hidden="true">
                  {outcomeGlyph(last.outcome)}
                </span>
                {word(last.outcome)}
                {last.counts?.total !== undefined && (
                  <span className="checks-counts num">
                    {last.counts.passed ?? 0}/{last.counts.total}
                  </span>
                )}
              </span>
              <span className="checks-strip">
                {mine.map((r) => (
                  <button
                    type="button"
                    key={r.id}
                    className={`checks-tick v-${r.outcome} ${r.epistemic === 'inferred' ? 'is-derived' : ''}`}
                    onClick={() => onOpen(r)}
                    title={`${timeOfDay(r.at)}, ${r.label}${r.epistemic === 'inferred' ? ' (worked out, not observed)' : ''}`}
                  >
                    <span className="sr-only">
                      {timeOfDay(r.at)} {r.outcome}
                    </span>
                  </button>
                ))}
              </span>
              <span className="checks-runs">
                {mine.length === 1
                  ? 'ran once'
                  : `${mine.length} runs${failed > 0 ? `, ${failed} failed` : ''}`}
              </span>
              <span className="checks-when">{timeOfDay(last.at)}</span>
            </li>
          );
        })}
      </ul>
      <p className="checks-key">
        Oldest first. A hollow mark is one Salidium worked out rather than read. Open any run for
        its record.
      </p>
    </section>
  );
}

export function Coverage({
  files,
  failing,
  onOpen,
}: {
  files: FileRow[];
  failing: string[];
  onOpen?: (f: FileRow) => void;
}) {
  if (files.length === 0) return null;
  const CAP = 120;
  const shown = files.slice(0, CAP);
  const covered = files.filter((f) => f.verifiedAfter).length;
  const stale = files.length - covered;
  const held = failing.length > 0;
  return (
    <section className="viz cov" aria-label="Which changed files a passing check ran after">
      <p className="cov-lead">
        <strong className="num">
          {covered} of {files.length}
        </strong>{' '}
        changed {files.length === 1 ? 'file has' : 'files have'} had a passing check since it was
        last edited.
      </p>
      {held && (
        <p className="cov-held">
          {failing.join(' and ')} {failing.length === 1 ? 'is' : 'are'} still failing.
        </p>
      )}
      <p className="cov-scope">
        A filled square is one file, not the project. A full grid does not mean the project is
        green.
      </p>
      <ul className="cov-grid">
        {shown.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              className={`cov-cell ${f.verifiedAfter ? 'is-covered' : 'is-stale'}`}
              onClick={() => onOpen?.(f)}
              title={`${f.path}: ${f.verifiedAfter ? (f.verifiedBy ?? 'checked after the last edit') : 'changed after the last passing check'}`}
            >
              <span className="sr-only">
                {f.path}:{' '}
                {f.verifiedAfter ? 'checked since last edit' : 'not checked since last edit'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {files.length > CAP && <p className="cov-more">…and {files.length - CAP} more.</p>}
      <ul className="cov-key">
        <li>
          <span className="cov-cell is-covered" aria-hidden="true" /> checked since last edit
          <span className="num cov-key-n">{covered}</span>
        </li>
        <li>
          <span className="cov-cell is-stale" aria-hidden="true" /> changed since the last check
          <span className="num cov-key-n">{stale}</span>
        </li>
      </ul>
    </section>
  );
}

/** The four pieces of Evidence, each opened on its own from the panel's rail. */
export function EvidenceCoverage({
  view,
  onRef,
}: {
  view: SessionView;
  onRef: (ref: string) => void;
}) {
  const failing = [
    ...new Set(
      view.left.items
        .filter((i) => i.source === 'verification' && i.status === 'failing')
        .map((i) => i.text.replace(/\s.*$/, '').toLowerCase()),
    ),
  ];
  return (
    <Coverage files={view.changes.files} failing={failing} onOpen={(f) => onRef(f.lastCallId)} />
  );
}

export function EvidenceChecks({
  view,
  onRef,
}: {
  view: SessionView;
  onRef: (ref: string) => void;
}) {
  return <CheckLanes runs={view.verified.runs} onOpen={(v) => onRef(v.callId)} />;
}

export function EvidenceChanged({
  view,
  cwd,
  onRef,
}: {
  view: SessionView;
  cwd: string;
  onRef: (ref: string) => void;
}) {
  return (
    <FileChurn
      files={view.changes.files}
      cwd={cwd}
      limit={20}
      onOpen={(f) => onRef(f.lastCallId)}
    />
  );
}

export function EvidenceHappened({
  view,
  onRef,
}: {
  view: SessionView;
  onRef: (ref: string) => void;
}) {
  return (
    <>
      <SessionFlow turns={view.turns} commits={view.changes.commits} onRef={onRef} />
      <Delegated subagents={view.subagents} onRef={onRef} />
    </>
  );
}

/**
 * One column of "where it stands", on its own, because each is now opened by the badge that
 * states its headline rather than read as one of three columns nobody asked for.
 */
export function StatusColumn({
  which,
  view,
  onRef,
}: {
  which: 'checks' | 'left' | 'review';
  view: SessionView;
  onRef: (ref: string) => void;
}) {
  return <StatusBlock view={view} detail={2} onRef={onRef} only={which} />;
}

const OUTCOME_WORD: Record<string, string> = {
  pass: 'passed',
  fail: 'failed',
  partial: 'partial',
  unknown: 'unknown',
};

const CAVEAT_TEXT: Record<string, string> = {
  'exit-inferred': 'exit code not reported, read from the output',
  'exit-masked': 'exit code hidden by a pipe',
  'output-truncated': 'output was truncated',
  'no-summary-parsed': 'no summary line found in the output',
  'exit-summary-mismatch': 'the output says passed and the exit code says failed',
};

function caveatText(caveats: string[]): string {
  return caveats
    .filter((c) => c !== 'scope-partial')
    .map((c) => CAVEAT_TEXT[c] ?? c)
    .join(' · ');
}

const AT_A_GLANCE = 6;

function StatusBlock({
  view,
  detail,
  onRef,
  only,
}: {
  view: SessionView;
  detail: Detail;
  onRef: (ref: string) => void;
  only?: 'checks' | 'left' | 'review';
}) {
  const summary = view.verified.summary;
  const attention = view.review.groups.filter((g) => g.severity !== 'info');
  const clip = <T,>(items: T[]) => (detail > 1 ? items : items.slice(0, AT_A_GLANCE));
  const more = (n: number) =>
    detail > 1 || n <= AT_A_GLANCE ? null : (
      <li className="rp-none">…{n - AT_A_GLANCE} more, under Records</li>
    );
  const show = (col: 'checks' | 'left' | 'review') => only === undefined || only === col;
  return (
    <div className={`rp-cols${only ? ' is-single' : ''}`}>
      {show('checks') && (
        <div className="rp-block" id="sec-verified">
          <h3 className="rp-title">Verified</h3>
          {summary.length === 0 ? (
            <p className="rp-none">No checks observed.</p>
          ) : (
            <ul className="rp-status">
              {summary.map((v) => {
                const caveat = caveatText(v.caveats);
                return (
                  <li key={v.id} className={`v-${v.outcome}`}>
                    <span className="rp-mark" aria-hidden="true">
                      {outcomeGlyph(v.outcome)}
                    </span>
                    <button
                      type="button"
                      className="rp-status-label"
                      onClick={() => onRef(v.callId)}
                    >
                      {v.method}
                      <span className="sr-only">{OUTCOME_WORD[v.outcome] ?? v.outcome}</span>
                      {v.counts?.total !== undefined && (
                        <span className="mono rp-counts">
                          {v.counts.passed ?? 0}/{v.counts.total}
                        </span>
                      )}
                    </button>
                    {v.scope === 'partial' && <span className="rp-subset">subset</span>}
                    {v.laterUnreadable > 0 && (
                      <span
                        className="rp-stale"
                        title={`${v.laterUnreadable} later ${v.laterUnreadable === 1 ? 'run' : 'runs'} of ${v.method} produced no readable outcome`}
                      >
                        not the latest run
                      </span>
                    )}
                    {caveat && <span className="rp-caveat">{caveat}</span>}
                    {detail > 1 && v.epistemic === 'inferred' && (
                      <span className="rp-derived">derived</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {show('left') && (
        <div className="rp-block" id="sec-left">
          <h3 className="rp-title">Remaining</h3>
          {view.left.items.length === 0 ? (
            <p className="rp-none">Nothing recorded.</p>
          ) : (
            <ul className="rp-status">
              {clip(view.left.items).map((i) => (
                <li key={i.id}>
                  <span className="rp-mark" aria-hidden="true">
                    {i.status === 'failing' ? '✕' : i.status === 'in_progress' ? '▸' : '○'}
                  </span>
                  <span>{i.text}</span>
                </li>
              ))}
              {more(view.left.items.length)}
            </ul>
          )}
        </div>
      )}

      {show('review') && (
        <div className="rp-block" id="sec-review">
          <h3 className="rp-title">Review</h3>
          {attention.length === 0 ? (
            <p className="rp-none">Nothing needs you.</p>
          ) : (
            <ul className="rp-status">
              {clip(attention).map((g) => (
                <ReviewGroupRow key={g.rule} group={g} onRef={onRef} />
              ))}
              {more(attention.length)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Delegated({
  subagents,
  onRef,
}: {
  subagents: SessionView['subagents'];
  onRef: (ref: string) => void;
}) {
  if (subagents.length === 0) return null;
  const reported = subagents.filter((s) => s.lastMessage).length;
  return (
    <Disclosure
      label={`Delegated to ${subagents.length} ${subagents.length === 1 ? 'agent' : 'agents'}${reported > 0 ? `, ${reported} reported back` : ''}`}
      id="subagents"
    >
      <ul className="rows">
        {subagents.map((s) => (
          <DelegatedRow key={s.id} agent={s} onRef={onRef} />
        ))}
      </ul>
    </Disclosure>
  );
}

function DelegatedRow({
  agent,
  onRef,
}: {
  agent: SessionView['subagents'][number];
  onRef: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const text = agent.lastMessage ?? '';
  const [ref, clamped] = useClamped<HTMLSpanElement>(open, text);
  return (
    <li className="row row-flat is-quote">
      <span className="attrib">{agent.description ?? agent.agentType ?? agent.id}</span>
      {text ? (
        <>
          <span ref={ref} className={`rp-statement-body${open ? ' is-open' : ''}`}>
            {text}
          </span>
          {(clamped || open) && (
            <button type="button" className="link" onClick={() => setOpen(!open)}>
              {open ? 'less' : 'more'}
            </button>
          )}
        </>
      ) : (
        <span className="muted">{agent.endedAt ? 'ended without reporting' : 'still running'}</span>
      )}
      {agent.eventId && (
        <button
          type="button"
          className="link"
          onClick={() => onRef(agent.eventId)}
          aria-label={`Open the record for ${agent.description ?? agent.agentType ?? agent.id}`}
        >
          record
        </button>
      )}
    </li>
  );
}

function ReviewGroupRow({ group, onRef }: { group: ReviewGroup; onRef: (ref: string) => void }) {
  const [open, setOpen] = useState(false);
  const one = group.items[0];
  if (group.occurrences === 1 && one)
    return (
      <li className="is-attn">
        <span className="rp-mark" aria-hidden="true">
          ⚠
        </span>
        <span>{one.summary}</span>
        {one.refs[0] && (
          <button type="button" className="link rp-ev" onClick={() => onRef(one.refs[0] as string)}>
            record
          </button>
        )}
      </li>
    );
  return (
    <li className="is-attn rp-group">
      <span className="rp-mark" aria-hidden="true">
        ⚠
      </span>
      <div className="rp-group-body">
        <button
          type="button"
          className="rp-group-head"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className="rp-group-label">{group.label}</span>
          <span className="rp-group-count num">
            {group.occurrences}
            {group.items.length < group.occurrences && (
              <span className="rp-group-distinct"> · {group.items.length} distinct</span>
            )}
          </span>
        </button>
        {open && (
          <ul className="rp-group-items">
            {group.items.map((i) => (
              <li key={i.id}>
                <span className="mono" title={i.instance ?? i.label}>
                  {shortHome(i.instance ?? i.label)}
                </span>
                {i.repeats > 1 && <span className="rp-group-repeats num">×{i.repeats}</span>}
                {i.refs[0] && (
                  <button
                    type="button"
                    className="link rp-ev"
                    onClick={() => onRef(i.refs[0] as string)}
                  >
                    record
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export function VerdictBadge({
  verdict,
  strip,
  onOpen,
}: {
  verdict: VerdictView;
  strip: StripView;
  onOpen: (panel: PanelId) => void;
}) {
  const note = [
    verdict.because,
    strip.waiting?.summary,
    verdict.epistemic === 'inferred' && !verdict.because ? 'Worked out, not observed.' : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="masthead-badges">
      <button
        type="button"
        className="tag is-open"
        data-tone={verdict.tone}
        onClick={() => onOpen('checks')}
        title="Open the checks this verdict was read from"
      >
        <span className="tag-strong">{verdict.headline}</span>
        {note && <span className="tag-note">{note}</span>}
      </button>
      {strip.reviewOpen > 0 && (
        <button
          type="button"
          className="tag is-open"
          data-tone="attention"
          onClick={() => onOpen('review')}
          title="Flagged items requiring human review: failing checks, waiting prompts, destructive commands, or unverified claims"
        >
          <span className="tag-key">review</span>
          <span className="num tag-strong">{strip.reviewOpen}</span>
        </button>
      )}
      {strip.remaining > 0 && (
        <button
          type="button"
          className="tag is-open"
          onClick={() => onOpen('left')}
          title="Remaining plan steps or unresolved checks"
        >
          <span className="tag-key">remaining</span>
          <span className="num tag-strong">{strip.remaining}</span>
        </button>
      )}
    </div>
  );
}
