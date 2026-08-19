import type { ActivityRow, TurnRow } from '@salidium/core';
import { memo, useMemo, useState } from 'react';
import { rowEqual } from '../lib/equal.ts';
import { durationMs, plural, timeOfDay } from '../lib/format.ts';
import { Loading } from './Loading.tsx';
import { ProvenanceMark } from './Provenance.tsx';
import { Section, type SectionState } from './Sections.tsx';

/** Turns rendered at once (newest first); older ones are a click away. */
const TURN_PAGE = 30;

/**
 * Turn-by-turn activity: the ask, the agent's headline, evidence counts, and each tool call
 * behind a click. This is the raw-ish spine; everything above it is derived from it. Prompts are
 * clamped — a turn row exists to be scanned, and pasting a whole brief into it defeats that.
 * Long sessions are capped to the last TURN_PAGE turns with a "show earlier" control, and rows
 * are memoized structurally because the projection rebuilds every row on each event batch.
 */
export function ActivityList({
  turns,
  onRef,
  section,
}: {
  turns: TurnRow[];
  onRef: (ref: string) => void;
  section: SectionState;
}) {
  const [shown, setShown] = useState(TURN_PAGE);
  const newestFirst = useMemo(() => [...turns].reverse(), [turns]);
  const visible = newestFirst.length > shown ? newestFirst.slice(0, shown) : newestFirst;
  const hidden = newestFirst.length - visible.length;
  return (
    <Section
      id="activity"
      title="Activity"
      glance={`${plural(turns.length, 'turn')}`}
      count={turns.length}
      {...section}
    >
      {turns.length === 0 && <div className="empty-line muted">No turns yet.</div>}
      <ol className="turns">
        {visible.map((t) => (
          <TurnItem key={t.id} t={t} onRef={onRef} />
        ))}
      </ol>
      {hidden > 0 && (
        <div className="turns-more">
          <button
            type="button"
            className="btn"
            onClick={() => setShown((n) => n + TURN_PAGE)}
            aria-label={`Show ${Math.min(TURN_PAGE, hidden)} earlier turns (${hidden} hidden)`}
          >
            Show earlier turns
          </button>
          <span className="muted">
            {hidden} earlier {hidden === 1 ? 'turn' : 'turns'} hidden
          </span>
          {hidden > TURN_PAGE && (
            <button type="button" className="link" onClick={() => setShown(newestFirst.length)}>
              show all
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

const TurnItem = memo(function TurnItem({
  t,
  onRef,
}: {
  t: TurnRow;
  onRef: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((o) => !o);
  const [showMessage, setShowMessage] = useState(false);
  const outcome = t.outcome ?? (t.endedAt ? 'completed' : 'in progress');
  const bodyId = `turn-${t.id}-activities`;
  return (
    <li className={`turn turn-${outcome.replace(' ', '-')}`}>
      <div className="turn-head">
        <button
          type="button"
          className="row-toggle"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`Toggle tool calls for turn ${t.index + 1}`}
        >
          <span className={`chev ${open ? 'is-open' : ''}`} aria-hidden="true">
            ›
          </span>
        </button>
        <span className="turn-index mono num">{t.index + 1}</span>
        <span className="turn-main">
          <span className="turn-prompt is-quote">
            <span className="attrib">you</span>
            <span className="turn-prompt-text">
              {t.prompt || <span className="muted">(prompt not recorded)</span>}
            </span>
          </span>
          {t.headline && <span className="turn-headline">{t.headline}</span>}
          <span className="row-meta">
            <span className="mono muted">{timeOfDay(t.startedAt)}</span>
            {t.endedAt && <span className="mono muted">→ {timeOfDay(t.endedAt)}</span>}
            <span className={`turn-outcome outcome-${outcome.replace(' ', '-')}`}>{outcome}</span>
            <span className="muted">{plural(t.activityCount, 'tool call')}</span>
            {t.files.length > 0 && (
              <span className="mono num muted">
                {t.files.length} files +{t.linesAdded} −{t.linesRemoved}
              </span>
            )}
            {t.verifications.map((v) => (
              <span
                key={v.id}
                className={`v-${v.outcome} mono ${v.epistemic === 'inferred' ? 'ep-inferred' : ''}`}
                title={
                  v.epistemic === 'inferred'
                    ? `${v.label} — derived from output/inferred exit`
                    : v.label
                }
              >
                <span className="ep-text">
                  {v.outcome === 'pass' ? '✓' : v.outcome === 'fail' ? '✕' : '?'} {v.label}
                </span>
              </span>
            ))}
            {t.lastMessage && (
              <button
                type="button"
                className="link"
                onClick={() => setShowMessage((s) => !s)}
                aria-expanded={showMessage}
              >
                {showMessage ? 'hide agent message' : 'agent message'}
              </button>
            )}
          </span>
          {showMessage && t.lastMessage && (
            <div className="turn-message ep-reported">
              <ProvenanceMark epistemic="reported" author="agent" />
              <pre>{t.lastMessage}</pre>
            </div>
          )}
        </span>
      </div>
      {open && (
        <ul className="activities" id={bodyId}>
          {t.activities.map((a) => (
            <ActivityItem key={a.callId} a={a} onRef={onRef} />
          ))}
        </ul>
      )}
    </li>
  );
}, rowEqual);

const KIND_GLYPH: Record<ActivityRow['kind'], string> = {
  command: '$',
  fileEdit: '±',
  fileWrite: '+',
  fileRead: '›',
  search: '?',
  webFetch: '@',
  webSearch: '@',
  subagent: '⇢',
  plan: '☰',
  question: '?',
  mcp: '⚙',
  other: '·',
};

const ActivityItem = memo(function ActivityItem({
  a,
  onRef,
}: {
  a: ActivityRow;
  onRef: (ref: string) => void;
}) {
  return (
    <li
      className={`activity act-${a.kind} status-${a.status} ${a.isVerification ? 'is-verification' : ''}`}
    >
      <button
        type="button"
        className="activity-main"
        onClick={() => onRef(a.callId)}
        title="Open the source record"
      >
        <span className="act-glyph mono" aria-hidden="true">
          {KIND_GLYPH[a.kind]}
        </span>
        <span className="act-title mono">{a.title}</span>
        <span className="row-meta">
          {a.agentId && <span className="muted">subagent</span>}
          {a.status === 'running' && <Loading label="running" className="running" />}
          {a.status === 'failed' && <span className="bad">failed</span>}
          {a.status === 'unknown' && <span className="muted">no result</span>}
          {a.exit?.observation === 'explicit' && (
            <span className="mono muted">exit {a.exit.code}</span>
          )}
          {a.durationMs !== undefined && (
            <span className="mono muted">{durationMs(a.durationMs)}</span>
          )}
          <span className="mono muted">{timeOfDay(a.startedAt)}</span>
        </span>
      </button>
    </li>
  );
}, rowEqual);
