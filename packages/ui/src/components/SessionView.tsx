import {
  type SessionView as ProjectedSessionView,
  projectSession,
  type RunState,
} from '@salidium/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveSession } from '../hooks/useLiveSession.ts';
import { relativeTime, shortHome, shortPath, timeOfDay } from '../lib/format.ts';
import { providerLabel } from '../lib/providerLabel.ts';
import { useFootSpace } from '../lib/useFootSpace.ts';
import { useScrollState } from '../lib/useScrollState.ts';
import { useStaysMounted } from '../lib/useStaysMounted.ts';
import { type LiveError, useAppStore } from '../store/appStore.ts';
import { BrandMark } from './Brand.tsx';
import { ConnectionBadge, DOCS, ThemeToggle, ToolButton, ToolLink } from './Controls.tsx';
import { HistoryRail } from './HistoryRail.tsx';
import { HistoryTable } from './HistoryTable.tsx';
import { Icon } from './Icon.tsx';
import { Loading } from './Loading.tsx';
import { Panel, type PanelSection } from './Panel.tsx';
import {
  EvidenceChanged,
  EvidenceChecks,
  EvidenceCoverage,
  EvidenceHappened,
  Explained,
  StatusColumn,
  Telemetry,
  VerdictBadge,
} from './Report.tsx';
import { statusGlyph } from './SessionList.tsx';
import { Timeline, TimelineKey } from './Timeline.tsx';

/**
 * The session page, laid out as a written document rather than a dashboard.
 *
 * Product mark, session title, the facts that identify the run, the verdict where a README puts
 * its badges, a rule, and then the explanation — a description followed by the diagrams, given the
 * width of the page and room to breathe. Quantities stay behind their own control, because
 * whichever of meaning and measurement sits on top is the one that gets read.
 *
 * Detail is section-level: Evidence and Rewind open independently, while Quantities and History
 * share the supporting inspector beside the explanation.
 */
export function SessionView({ sessionId, now }: { sessionId: string; now: number }) {
  const [attempt, setAttempt] = useState(0);
  useLiveSession(sessionId, attempt);
  const api = useAppStore((s) => s.api);
  const live = useAppStore((s) => s.live[sessionId]);
  const liveError = useAppStore((s) => s.liveErrors[sessionId]);
  const summary = useAppStore((s) => s.sessions[sessionId]);
  const openRaw = useAppStore((s) => s.openRaw);
  const setScrub = useAppStore((s) => s.setScrub);
  const markSeen = useAppStore((s) => s.markSeen);
  const openPanel = useAppStore((s) => s.openPanel);
  const rewindOpen = useAppStore((s) => s.rewindOpen);
  const toggleRewind = useAppStore((s) => s.toggleRewind);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const statsOpen = useAppStore((s) => s.statsOpen);
  const toggleStats = useAppStore((s) => s.toggleStats);
  const historyMode = useAppStore((s) => s.historyMode);
  const setHistoryMode = useAppStore((s) => s.setHistoryMode);
  /**
   * The sequence "new" was counted from, frozen when the reader asks to see it. The badge clears
   * on the click — it has been answered — but the entries it was counting have to stay marked
   * while they are being read, and they are marked relative to `lastSeenSeq`, which the same click
   * moves. Holding the old value here keeps the highlight from vanishing at the moment it matters.
   */
  const [markedFrom, setMarkedFrom] = useState<number | undefined>(undefined);
  const contentRef = useScrollState<HTMLDivElement>();
  /*
   * The floating scrubber costs the layout no height, so the document has to keep its own last
   * line clear of it. Its height changes with width, so it is measured rather than written down;
   * see `useFootSpace`.
   */
  const [paneRef, footRef] = useFootSpace<HTMLDivElement, HTMLDivElement>(`${rewindOpen}`);
  /* It leaves by retracing its arrival, so it has to still be there while it does. */
  const rewindMounted = useStaysMounted(rewindOpen);

  const liveState: RunState | undefined = live?.state;
  const scrubState: RunState | undefined = live?.scrub?.state;
  const revision = live?.revision ?? 0;
  const scrubSeq = live?.scrub?.seq;
  /*
   * The run is projected twice while a handle is held, because the page is answering two questions
   * at once. The document reads the session as it stood at the handle. The timeline reads the whole
   * session: an axis drawn from the scrubbed projection restates where the handle is rather than
   * what the run was, so its right-hand label walked left as you dragged, and every check and
   * commit past the handle left the track entirely — where `.tl-future` exists precisely to dim
   * them and leave them where they are.
   *
   * The second pass only exists while a drag is in flight: with nothing scrubbed `scrubState` is
   * undefined and `view` is `liveView`, which is the one projection per render this always did.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `liveState` is mutated in place by the reducer, so `revision` is the signal that it moved.
  const liveView = useMemo(
    () => (liveState ? projectSession(liveState, now) : undefined),
    [liveState, revision, now],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a replay arrives as a fresh object, but `scrubSeq` is what names which replay it is.
  const scrubView = useMemo(
    () => (scrubState ? projectSession(scrubState, now) : undefined),
    [scrubState, scrubSeq, now],
  );

  const onRef = useCallback(
    (ref: string) => {
      const s = useAppStore.getState().live[sessionId]?.state;
      if (!s) return;
      const eventId = ref.includes('#')
        ? ref
        : (s.activities[ref]?.eventIds[0] ??
          s.claims.find((c) => c.id === ref)?.eventId ??
          s.claims.find((c) => c.id === ref)?.id);
      if (eventId) openRaw(sessionId, eventId);
    },
    [openRaw, sessionId],
  );

  // Scrub requests are ordered: only the most recent click may update the view, so rapid
  // clicks (or "back to live") can never be overtaken by an older response.
  const scrubRequest = useRef(0);
  const onScrub = useCallback(
    (ts: string, seq: number) => {
      const cur = useAppStore.getState().live[sessionId];
      if (!api || !cur) return;
      const req = ++scrubRequest.current;
      setScrub(sessionId, { ts, seq, state: cur.scrub?.state ?? cur.state, loading: true });
      api.stateAtTime(sessionId, ts).then(
        (r) => {
          if (scrubRequest.current !== req) return;
          setScrub(sessionId, { ts, seq, state: r.state as RunState, loading: false });
        },
        () => {
          if (scrubRequest.current !== req) return;
          setScrub(sessionId, undefined);
        },
      );
    },
    [api, sessionId, setScrub],
  );
  const onLive = useCallback(() => {
    scrubRequest.current++;
    setScrub(sessionId, undefined);
  }, [sessionId, setScrub]);

  /**
   * How much arrived while you were on another session. Counted over the facets that change what
   * you would do — an edit, a check, something now needing a human, something no longer left —
   * and not over `status`, `why` or `how`, which move whenever the agent narrates and would put a
   * number on the screen for a paragraph of prose. It used to count only edits and checks, so a
   * session that started needing you while you were away reported nothing new.
   */
  const freshCount = useMemo(() => {
    if (!live) return 0;
    return live.changes.filter(
      (c) =>
        c.seq > live.lastSeenSeq &&
        (c.facet === 'what' ||
          c.facet === 'verified' ||
          c.facet === 'review' ||
          c.facet === 'left'),
    ).length;
  }, [live]);
  useEffect(() => () => markSeen(sessionId), [sessionId, markSeen]);

  const showNew = useCallback(() => {
    setMarkedFrom(useAppStore.getState().live[sessionId]?.lastSeenSeq);
    if (useAppStore.getState().statsOpen) toggleStats();
    setHistoryMode('rail');
    markSeen(sessionId);
  }, [sessionId, markSeen, setHistoryMode, toggleStats]);

  /** Closing history ends the reading, so the scoping does not come back with it. */
  const toggleHistory = useCallback(() => {
    const cur = useAppStore.getState().historyMode;
    if (cur === 'off') {
      if (useAppStore.getState().statsOpen) toggleStats();
      setHistoryMode('rail');
    } else {
      setMarkedFrom(undefined);
      setHistoryMode('off');
    }
  }, [setHistoryMode, toggleStats]);

  /** Quantities and History occupy one inspector slot, so opening either replaces the other. */
  const toggleQuantities = useCallback(() => {
    const opening = !useAppStore.getState().statsOpen;
    if (opening) {
      setMarkedFrom(undefined);
      setHistoryMode('off');
    }
    toggleStats();
  }, [setHistoryMode, toggleStats]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'h') toggleHistory();
      else if (e.key === 'l' && scrubSeq !== undefined) onLive();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scrubSeq, onLive, toggleHistory]);

  if (!live || !liveState || !liveView) {
    if (liveError)
      return <SessionError error={liveError} onRetry={() => setAttempt((a) => a + 1)} />;
    return (
      <div className="main-empty">
        <div className="muted" role="status">
          <Loading label="Loading session" size="md" />
        </div>
      </div>
    );
  }

  const state: RunState = scrubState ?? liveState;
  const view = scrubView ?? liveView;
  const hasEvidence =
    view.changes.files.length > 0 ||
    view.verified.runs.length > 0 ||
    view.turns.length + view.subagents.length > 0;
  const st = statusGlyph(view.strip.status);
  /*
   * When the session ended is a fact about the run, not about the handle, so the axis's end label
   * is read off the live projection. Taken from the scrubbed one it moved with every drag and said
   * the session had ended wherever you happened to let go.
   */
  const ended = liveView.strip.status === 'ended' ? liveState.lastEventAt : undefined;
  const ex = view.explained;

  return (
    <div className={`session ${statsOpen || historyMode === 'rail' ? 'has-inspector' : ''}`}>
      <div className="session-main" ref={paneRef}>
        <div className="session-actions">
          {/* Only shown while the list is folded: with the list on screen its own header carries
              the control, and two of them competing would be one too many. */}
          {!sidebarOpen && (
            <ToolButton icon="panel" title="Show the session list ([)" onClick={toggleSidebar} />
          )}
          {/*
           * There is no table of contents any more, because there is no longer a document to
           * navigate: the page is the diagram, and every other section is opened from the badge
           * that states its headline. Two links pointing at two sections already on screen is
           * furniture.
           */}
          <div className="toolbar session-actions-end">
            {/*
             * A count on its own is a notice with nothing to do about it: the page is already
             * live, so there is nothing to refresh, and the changes are scattered through it. It
             * is a button, and it takes you to them — History, filtered to what you have not seen.
             *
             * It leads the group because it is the only thing in it that comes and goes: the run of
             * settings behind it then keeps the same distance from the window's edge whether it is
             * on screen or not, and none of them move under the pointer when it clears.
             */}
            {scrubSeq === undefined && freshCount > 0 && (
              <button
                type="button"
                className="fresh"
                onClick={showNew}
                title="Changes since you last had this session open. Opens History filtered to them."
              >
                Show {freshCount} new
              </button>
            )}
            {/*
             * The depth control is gone. Its whole job was deciding which sections were present,
             * and sections are no longer present: each is opened by the badge that summarises it,
             * so presence is per-section and there is nothing left for one control to set.
             */}
            {hasEvidence && (
              <ToolButton
                icon="table"
                label="Evidence"
                title="Coverage, checks over time, what changed, what happened when"
                onClick={() => openPanel('evidence')}
              />
            )}
            <ToolButton
              icon="latest"
              label="Rewind"
              on={rewindOpen}
              title="Show the session as it stood at a moment in time"
              onClick={toggleRewind}
            />
            <ToolButton
              icon="stats"
              label="Quantities"
              on={statsOpen}
              title="Show measured totals beside the session"
              onClick={toggleQuantities}
            />
            <ToolButton
              icon="history"
              label="History"
              on={historyMode !== 'off'}
              title="Toggle history (h)"
              onClick={toggleHistory}
            />
            {/*
             * The product's route to its own documentation, and for most of a session's life the
             * only one there is: the first screen carries the same link, but the first screen is
             * shown when no session has ever existed, so once one has the reader never sees it
             * again. The words that need a definition — observed, derived, partial, needs you —
             * are all on the report, which was the one surface with nothing to press.
             *
             * Here rather than in the list's head, which was measured and cannot take it: at
             * 288px that head has 68px of room, a seventh control leaves 32px, and with the
             * connection badge showing "disconnected" it reaches zero and truncates the product's
             * own name, at the moment a reader most needs to read it. This row has the room
             * because it wraps.
             *
             * Beside the theme rather than among Evidence and the rest, because those four are
             * the session and these two are not.
             */}
            <ToolLink
              icon="outbound"
              label="Docs"
              href={DOCS}
              title="Open the Salidium documentation in a new tab"
            />
            <ThemeToggle />
            {/* The separator belongs to the badge: with a healthy connection neither is drawn,
                and a rule with nothing after it is just a mark at the end of the bar. */}
            {live.connection !== 'open' && live.connection !== 'connecting' && (
              <>
                <span className="toolbar-sep" aria-hidden="true" />
                <ConnectionBadge status={live.connection} />
              </>
            )}
          </div>
        </div>

        {/* The table takes the pane: at 320 px a four-hundred-entry log is unreadable, and the
            session it belongs to is one click away on the toolbar. */}
        {historyMode === 'table' ? (
          <HistoryTable
            changes={live.changes}
            scrubTs={live.scrub?.ts}
            onScrub={onScrub}
            onLive={onLive}
            onRef={onRef}
          />
        ) : (
          <div className="session-content scroll-fade" ref={contentRef}>
            <article className="page">
              <header className="masthead">
                <BrandMark size={16} className="masthead-mark" />
                <h1 className="masthead-title">{state.title || summary?.title || state.cwd}</h1>
                {/*
                 * The run's identity. Each tag names the fact it carries: `main` on its own is legible
                 * only to someone who already knows the shape of the data, and the same went for the
                 * path, the agent and the model.
                 */}
                <p className="masthead-meta">
                  <span className="tag is-status">
                    <span className={`status-dot ${st.cls}`} aria-hidden="true">
                      {st.glyph}
                    </span>
                    {st.label}
                    {view.strip.statusSince && ` ${relativeTime(view.strip.statusSince, now)}`}
                  </span>
                  <span className="tag masthead-path" title={state.cwd}>
                    <span className="tag-key">in</span>
                    <span className="mono">{shortHome(shortPath(state.cwd))}</span>
                  </span>
                  {state.gitBranch && (
                    <span className="tag">
                      <span className="tag-key">branch</span>
                      <span className="mono">{state.gitBranch}</span>
                    </span>
                  )}
                  <span className={`tag is-${state.provider}`}>
                    <span className="tag-key">agent</span>
                    {providerLabel(state.provider)}
                  </span>
                  {state.model && (
                    <span className="tag">
                      <span className="tag-key">model</span>
                      <span className="mono">{state.model}</span>
                    </span>
                  )}
                </p>
                <VerdictBadge verdict={view.verdict} strip={view.strip} onOpen={openPanel} />
              </header>

              {scrubSeq !== undefined && (
                <p className="scrub-note" role="status">
                  Showing this session as it stood at <strong>{timeOfDay(live.scrub?.ts)}</strong>.
                  Anything later is hidden. {live.scrub?.loading && <Loading label="replaying" />}
                </p>
              )}

              {ex ? (
                <Explained ex={ex} />
              ) : (
                <ExplanationPending turns={view.turns.length} status={summary?.explanationStatus} />
              )}

              {/*
               * Nothing else lives in the page. The report and the timeline are opened from the
               * badges and the toolbar; see `Panel`.
               */}
            </article>
          </div>
        )}
        {/* The scrubber stays at the foot because it controls the document across its full width.
            It was once inside a panel, where dragging changed a page the reader could no longer
            see. Here the document moves above it and the handle stays under the pointer. */}
        <div className="session-foot" ref={footRef}>
          {rewindMounted && (
            <div className={`rewind arrives ${rewindOpen ? 'is-open' : ''}`}>
              <button
                type="button"
                className="btn btn-float"
                onClick={toggleRewind}
                title="Close the scrubber"
              >
                <Icon name="close" />
                <span className="sr-only">Close the scrubber</span>
              </button>
              <Timeline
                startedAt={liveState.startedAt}
                endedAt={ended}
                now={now}
                changes={live.changes}
                checks={liveView.verified.runs}
                commits={liveView.changes.commits}
                scrubTs={live.scrub?.ts}
                onScrub={onScrub}
                onLive={onLive}
              />
              <TimelineKey />
            </div>
          )}
        </div>
        <Panel id="checks" title="Verified">
          <StatusColumn which="checks" view={view} onRef={onRef} />
        </Panel>
        <Panel id="left" title="Left">
          <StatusColumn which="left" view={view} onRef={onRef} />
        </Panel>
        <Panel id="review" title="Needs you">
          <StatusColumn which="review" view={view} onRef={onRef} />
        </Panel>
        {/*
         * Evidence is four unrelated things, so it is four choices rather than one scroll: what
         * proportion of the work a passing check stands behind, the checks themselves over time,
         * which files moved, and what happened in order. Stacked, a reader met them in whatever
         * order the page happened to use and had to work out which was which on the way past.
         */}
        <EvidencePanel view={view} cwd={state.cwd} onRef={onRef} />
      </div>
      {statsOpen ? (
        <QuantitiesRail view={view} onClose={toggleQuantities} />
      ) : historyMode === 'rail' ? (
        <HistoryRail
          changes={live.changes}
          scrubTs={live.scrub?.ts}
          focusSeq={markedFrom}
          onScrub={onScrub}
          onLive={onLive}
          onClose={toggleHistory}
          onRef={onRef}
        />
      ) : null}
    </div>
  );
}

/** Build the rail from renderable evidence, so no choice can lead to an empty panel. */
function EvidencePanel({
  view,
  cwd,
  onRef,
}: {
  view: ProjectedSessionView;
  cwd: string;
  onRef: (ref: string) => void;
}) {
  const panel = useAppStore((s) => s.panel);
  const closePanel = useAppStore((s) => s.closePanel);
  const files = view.changes.files.length;
  const checks = view.verified.runs.length;
  const happened = view.turns.length + view.subagents.length;
  const sections: PanelSection[] = [];

  if (files > 0) {
    sections.push({
      key: 'coverage',
      label: 'Coverage',
      count: files,
      render: () => <EvidenceCoverage view={view} onRef={onRef} />,
    });
  }
  if (checks > 0) {
    sections.push({
      key: 'checks',
      label: 'Checks',
      count: checks,
      render: () => <EvidenceChecks view={view} onRef={onRef} />,
    });
  }
  if (files > 0) {
    sections.push({
      key: 'changed',
      label: 'Changed',
      count: files,
      render: () => <EvidenceChanged view={view} cwd={cwd} onRef={onRef} />,
    });
  }
  if (happened > 0) {
    sections.push({
      key: 'happened',
      label: 'What happened',
      count: happened,
      render: () => <EvidenceHappened view={view} onRef={onRef} />,
    });
  }

  useEffect(() => {
    if (panel === 'evidence' && sections.length === 0) closePanel();
  }, [panel, sections.length, closePanel]);

  if (sections.length === 0) return null;
  return <Panel id="evidence" title="Evidence" sections={sections} />;
}

/** Measured facts use the same supporting rail as History, never a competing third column. */
function QuantitiesRail({ view, onClose }: { view: ProjectedSessionView; onClose: () => void }) {
  return (
    <aside className="inspector quantities" aria-label="Quantities">
      <div className="inspector-head">
        <ToolButton icon="panel" title="Hide quantities" onClick={onClose} />
        <span className="inspector-title">Quantities</span>
      </div>
      <div className="quantities-body scroll-fade">
        <Telemetry view={view} />
      </div>
    </aside>
  );
}

/**
 * The explanation is the page. When there is not one yet, say which of the three reasons applies
 * rather than showing one progress state for all of them — the daemon reports whether a call is
 * actually in flight, and animating a call that finished and returned nothing is a lie the reader
 * cannot catch. An activity chart in this slot is the telemetry dashboard this product replaces.
 */
function ExplanationPending({
  turns,
  status,
}: {
  turns: number;
  status: 'generating' | 'generated' | 'disabled' | 'unavailable' | 'failed' | undefined;
}) {
  if (turns === 0)
    return (
      <section className="ex-pending" role="status">
        <p>Nothing has happened in this session yet.</p>
      </section>
    );
  if (status === 'generating')
    return (
      <section className="ex-pending is-running" role="status">
        <p className="ex-pending-main">
          <Loading label="Reading the session" size="md" />
        </p>
        <p>
          Your selected agent is writing from a bounded, redacted summary of the session. It takes a
          few seconds, then the explanation is cached.
        </p>
      </section>
    );
  if (status === 'disabled')
    return (
      <section className="ex-pending" role="status">
        <p className="ex-pending-main">Visual explanations are off.</p>
        <p>No evidence was sent to an agent. Observed facts are still available in Evidence.</p>
      </section>
    );
  if (status === 'unavailable')
    return (
      <section className="ex-pending" role="status">
        <p className="ex-pending-main">No explanation for this session.</p>
        <p>
          No compatible Claude Code or Codex command is available, so nothing was sent. Observed
          facts are still available in Evidence.
        </p>
      </section>
    );
  if (status === 'failed')
    return (
      <section className="ex-pending" role="status">
        <p className="ex-pending-main">No explanation for this session.</p>
        <p>
          The selected agent was asked but returned no usable structured explanation. Observed facts
          are still available in Evidence; the next turn will try again.
        </p>
      </section>
    );
  return (
    <section className="ex-pending" role="status">
      <p className="ex-pending-main">No explanation yet.</p>
      <p>One is written when the agent finishes its next turn.</p>
    </section>
  );
}

function SessionError({ error, onRetry }: { error: LiveError; onRetry: () => void }) {
  const select = useAppStore((s) => s.select);
  return (
    <div className="main-empty">
      <div className="session-error" role="alert">
        {error.kind === 'not-found' && (
          <>
            <p className="session-error-title">This session is not in the store</p>
            <p className="muted">
              It may have been forgotten, or the daemon was restarted with a fresh store. Pick
              another session from the list.
            </p>
          </>
        )}
        {error.kind === 'unreachable' && (
          <>
            <p className="session-error-title">Cannot reach the Salidium daemon</p>
            <p className="muted">
              {error.message}. Start it again with <code>salidium</code> in a terminal.
            </p>
          </>
        )}
        {error.kind === 'failed' && (
          <>
            <p className="session-error-title">Could not load this session</p>
            <p className="muted mono">{error.message}</p>
          </>
        )}
        <div className="session-error-actions">
          <button type="button" className="btn btn-accent" onClick={onRetry}>
            Try again
          </button>
          {error.kind === 'not-found' && (
            <button type="button" className="btn" onClick={() => select(undefined)}>
              Back to sessions
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
