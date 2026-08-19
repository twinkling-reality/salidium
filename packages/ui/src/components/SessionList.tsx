import type { SessionStatus, SessionSummary } from '@salidium/protocol';
import { useEffect, useState } from 'react';
import { basename, relativeTime } from '../lib/format.ts';
import { useScrollState } from '../lib/useScrollState.ts';
import { NOTHING_RECORDED, useAppStore } from '../store/appStore.ts';
import { useDismiss } from './Controls.tsx';
import { Icon } from './Icon.tsx';
import { Loading } from './Loading.tsx';

export function statusGlyph(status: SessionStatus): { glyph: string; label: string; cls: string } {
  switch (status) {
    case 'working':
      return { glyph: '●', label: 'Working', cls: 'st-working' };
    case 'waiting':
      return { glyph: '◐', label: 'Waiting for you', cls: 'st-waiting' };
    case 'idle':
      return { glyph: '○', label: 'Idle', cls: 'st-idle' };
    case 'ended':
      return { glyph: '◌', label: 'Ended', cls: 'st-ended' };
    default:
      return { glyph: '·', label: 'Unknown', cls: 'st-unknown' };
  }
}

/** Every status a row can be in, in the order a reader meets them. */
const KEYED: SessionStatus[] = ['working', 'waiting', 'idle', 'ended'];

/**
 * What the marks on a row mean, behind a question mark at the head of the panel.
 *
 * It was a permanent key across the panel's foot, which is a poor trade: a reader learns three
 * symbols once and then pays 42 px of a list for them forever — one and a half rows, on the
 * surface whose whole job is to hold rows. Asked for instead, it costs nothing at rest and can
 * say more than a single wrapping row had room for: the foot named three of the four statuses,
 * so `idle` and `ended` — which a row draws as a bare ○ and ◌ and names only in its tooltip —
 * were the two you could not look up anywhere.
 *
 * The rows are generated from `statusGlyph`, the same function the list itself calls, so the key
 * cannot come to describe marks the rows no longer draw.
 *
 * It still goes when the rows do. On a first run it was the only thing in the panel besides the
 * empty state: a key to symbols the reader has no instance of, on the first screen they ever see.
 */
export function MarksKey() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="pop" ref={ref}>
      <button
        type="button"
        className={`btn btn-icon ${open ? 'is-on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="What the marks on a row mean"
      >
        <Icon name="help" />
        <span className="sr-only">What the marks on a row mean</span>
      </button>
      {open && (
        <div className="pop-panel is-narrow marks-key">
          <div className="pop-head">
            <span>On a row</span>
          </div>
          <dl>
            {KEYED.map((status) => {
              const st = statusGlyph(status);
              return (
                <div key={status}>
                  <dt className={`status-dot ${st.cls}`} aria-hidden="true">
                    {st.glyph}
                  </dt>
                  <dd>{st.label.toLowerCase()}</dd>
                </div>
              );
            })}
            <div>
              <dt aria-hidden="true">
                <span className="attn-badge num is-live">
                  <Icon name="flag" />1
                </span>
              </dt>
              <dd>to review</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

/** How long after its last event an idle session is still something you might act on. */
const STILL_ACTIONABLE_MS = 30 * 60_000;

/**
 * "Needs you" means a human could act on it *now*. Every session keeps its unresolved review
 * items forever, so counting them all produced a headline in the hundreds — a number nobody can
 * act on and everybody learns to ignore. A blocked agent always counts; otherwise the session
 * has to be running, or only recently stopped. Older sessions keep their per-row badge, which
 * is a fact about that session, and stay out of the headline, which is a call to act.
 */
function needsYou(s: SessionSummary, now: number): boolean {
  if (s.status === 'waiting') return true;
  if (s.counts.reviewOpen === 0 || s.status === 'ended') return false;
  if (s.status === 'working') return true;
  const last = Date.parse(s.lastEventAt ?? '');
  return Number.isFinite(last) && now - last < STILL_ACTIONABLE_MS;
}

/**
 * A session that never ran a turn, never called a tool and never named itself has nothing to
 * explain. A third of the store is these: short-lived `claude -p` invocations that start, end, and
 * leave one event behind. Rendered as rows they are a wall of identical entries the eye has to
 * scan past on the way to real work, so they are collapsed behind one line that says how many
 * there are — hidden by default, never dropped, because "nothing was recorded" is itself a fact
 * about the store and the reader may want to check it.
 */
function isEmpty(s: SessionSummary): boolean {
  return (
    !s.title && s.counts.turns === 0 && s.counts.toolCalls === 0 && s.counts.filesChanged === 0
  );
}

/**
 * The same match the daemon runs, over the rows this client already holds — the fast path that
 * keeps typing instant while the debounced request is in flight.
 *
 * It is not a second definition of what a match is. What is searched, and why the id is in there,
 * now lives beside the SQL that searches it. This function is the oracle the SQL is checked
 * against with multi-word, mixed-case, and non-ASCII queries. So what this returns is exactly
 * what the daemon will return, restricted to the rows in hand, which is why the answer landing can
 * only ever *add* rows and the two can never be seen to disagree about one.
 */
function haystack(s: SessionSummary): string {
  return `${s.title ?? ''} ${s.repoRoot ?? ''} ${s.cwd ?? ''} ${s.providerSessionId}`.toLowerCase();
}

/** Every word has to appear somewhere, so "salidium ui" narrows rather than widening. */
function matcher(query: string): (s: SessionSummary) => boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return () => true;
  return (s) => {
    const hay = haystack(s);
    return terms.every((t) => hay.includes(t));
  };
}

/**
 * How long the panel waits for typing to stop before it asks the daemon.
 *
 * Not a motion token, and deliberately not `--motion-fast`: nothing here is animating, this is a
 * network policy. Broad prefixes can return the full session page on every keystroke, while a
 * debounced search sends only the settled query. 150 ms sits above a fast typist's inter-keystroke
 * interval and below the ~200 ms at which a find starts to feel unresponsive.
 */
const SEARCH_QUIET_MS = 150;

/**
 * The list is the product's home surface, not a file tree. Concurrent agents make its primary
 * question "which of these needs me now".
 *
 * That question is the grouping. Rows carrying something a human must handle head the panel, then
 * what is still running, then everything else in last-activity order — which is the order the list
 * always used, with the boundaries now named instead of left for the reader to infer. Sessions are
 * still not grouped by repo: only two or three repos are hot in a week, so that buys structure
 * nobody needs while pushing the attention signal down the panel.
 *
 * The groups can be wildly uneven, and that is why there is a filter as well as a fold. Folding a
 * head can recover space but does not answer how to find one row in a long Recent group. That is
 * a search problem, not a folding problem.
 */
export function SessionList({ now }: { now: number }) {
  const order = useAppStore((s) => s.sessionOrder);
  const sessions = useAppStore((s) => s.sessions);
  const selectedId = useAppStore((s) => s.selectedId);
  const loaded = useAppStore((s) => s.sessionsLoaded);
  const select = useAppStore((s) => s.select);
  const query = useAppStore((s) => s.sessionQuery);
  const setQuery = useAppStore((s) => s.setSessionQuery);
  const api = useAppStore((s) => s.api);
  const search = useAppStore((s) => s.sessionSearch);
  const setSearch = useAppStore((s) => s.setSessionSearch);
  const scrollRef = useScrollState<HTMLDivElement>();
  const q = query.trim();

  /*
   * The debounce lives here, on the surface that asks the question, and not in `setSessionQuery`:
   * the text field is controlled by `sessionQuery`, so a timer in the setter would make the field
   * echo the reader's own typing 150 ms late — on the most-used control in the app — to save a
   * request nobody would have noticed.
   *
   * Both guards are needed and they guard different things. The abort cancels a superseded request
   * on the wire; the store then refuses any answer whose echoed query is not the one on screen,
   * because a broad query issued two keystrokes ago can still land after a narrow one issued since.
   */
  useEffect(() => {
    if (!api) return;
    const ctl = new AbortController();
    // The default view is not a search: it asks for the two counts and no rows, because the panel
    // already holds the rows — what it cannot otherwise say is what it is holding a fraction of.
    const timer = setTimeout(() => {
      api
        .searchSessions(q, { limit: q ? undefined : 0, signal: ctl.signal })
        .then(setSearch, () => {
          /* superseded, or the daemon is unreachable — which the list stream already reports */
        });
    }, SEARCH_QUIET_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [api, q, setSearch]);

  if (!loaded)
    return (
      <div className="side-empty">
        <Loading label="Loading sessions" />
      </div>
    );
  if (order.length === 0) {
    return (
      <div className="side-empty">
        <p>No agent sessions yet.</p>
        {/*
         * The second sentence used to say recent sessions "are being imported in the background",
         * which on a machine with no transcripts to import is the app asserting something it has
         * not checked — on the first screen a new reader ever sees, from a tool whose whole claim
         * is that what it prints is true. It says what will happen instead of what is happening.
         */}
        <p className="muted">
          Start a Claude Code or Codex session and it will appear here within a second. Sessions
          from the last few days are read in when the daemon starts.
        </p>
      </div>
    );
  }

  /*
   * The daemon's answer when it is an answer to the query on screen, and the local match until it
   * arrives. The daemon searched the whole store; this client holds the newest page of it plus
   * whatever earlier searches pulled in, so the local result is a subset that the answer completes.
   */
  const answer = search?.query === q ? search : undefined;
  const rows = answer?.ids
    ? answer.ids.map((id) => sessions[id]).filter((s): s is SessionSummary => Boolean(s))
    : order
        .map((id) => sessions[id])
        .filter((s): s is SessionSummary => Boolean(s))
        .filter(matcher(q));
  const empty = rows.filter(isEmpty);
  const real = rows.filter((s) => !isEmpty(s));
  // The sort already ranked these; naming the boundaries turns an ordering the reader has to infer
  // into three headed groups they can read past. Empty groups are omitted, never headed as "none".
  const groups: Array<[string, SessionSummary[]]> = [
    ['Needs you', real.filter((s) => needsYou(s, now))],
    ['Working', real.filter((s) => !needsYou(s, now) && s.status === 'working')],
    ['Recent', real.filter((s) => !needsYou(s, now) && s.status !== 'working')],
  ];
  const filtering = q.length > 0;
  /*
   * What the panel is a fraction of. `total` is a fact about the store rather than about the query,
   * so it survives newer typing; `matched` is only true of the query it was counted for, so it is
   * read from the answer and is absent while one is in flight. Salidium says nothing rather than
   * something it does not yet know: for the ~160 ms between the last keystroke and the reply, the
   * rows are the local match and the foot is silent.
   */
  const searched = search?.total;
  const matched = answer?.matched;
  // Over the store, not over the DOM. When matching ran in the browser this was
  // `all.length - rows.length` — how much of the *page* the filter hid, which is not the number the
  // reader wants when the store exceeds that page. Silent when nothing matched: the sentence for
  // that case already carries the total, and duplicating it as "hidden" and "searched" is
  // the same fact told twice.
  const hidden =
    matched !== undefined && matched > 0 && searched !== undefined ? searched - matched : 0;
  // Broad prefixes can match more rows than the page cap, so windowing is a routine state.
  const windowed = matched !== undefined && matched > rows.length;

  return (
    <>
      <Find query={query} setQuery={setQuery} />
      <div className="side-scroll scroll-fade" ref={scrollRef}>
        {groups.map(([title, items]) =>
          items.length === 0 ? null : (
            <Group key={title} title={title} count={items.length} filtering={filtering}>
              <ul className="session-list" aria-label={title}>
                {items.map((s) => (
                  <SessionRow
                    key={s.id}
                    s={s}
                    selected={s.id === selectedId}
                    now={now}
                    onSelect={() => select(s.id)}
                  />
                ))}
              </ul>
            </Group>
          ),
        )}
        {empty.length > 0 && (
          <Group
            title={NOTHING_RECORDED}
            count={empty.length}
            filtering={filtering}
            title2="Sessions that started and ended without running a turn"
          >
            <ul className="session-list is-quiet" aria-label="Sessions with nothing recorded">
              {[...empty]
                .sort((a, b) =>
                  (b.lastEventAt ?? b.startedAt ?? '').localeCompare(
                    a.lastEventAt ?? a.startedAt ?? '',
                  ),
                )
                .map((s) => (
                  <SessionRow
                    key={s.id}
                    s={s}
                    selected={s.id === selectedId}
                    now={now}
                    onSelect={() => select(s.id)}
                  />
                ))}
            </ul>
          </Group>
        )}
        {/*
         * Four things can be true at the end of this list, and each is printed only when its own
         * number says something. Together they are the difference between a panel that holds the
         * store and a panel that holds a window on it — which is what this one has always been.
         *
         * The default view says so first: the cap is right — 740 rows at `--row-h` is 20,720 px of
         * list, which React reconciles on every summary that streams in — but a panel that shows
         * 500 of 740 and says nothing is asserting it holds them all.
         */}
        {!filtering && searched !== undefined && searched > rows.length && (
          <p className="side-hidden">
            {rows.length} of {searched} sessions
          </p>
        )}
        {filtering && matched === 0 && searched !== undefined && (
          <p className="side-none">
            Nothing matches <strong>{query}</strong>.
            <span className="muted"> {searched} searched by name, repo and id.</span>
          </p>
        )}
        {filtering && windowed && (
          <p className="side-hidden">
            Showing the newest {rows.length} of {matched} matches
          </p>
        )}
        {filtering && hidden > 0 && (
          <p className="side-hidden">
            {hidden} {hidden === 1 ? 'session' : 'sessions'} hidden by the filter
          </p>
        )}
      </div>
    </>
  );
}

/**
 * Find-as-you-type, above the list rather than behind a control, because the panel it filters is
 * the surface the reader lands on and a search you have to find first is one nobody uses.
 */
function Find({ query, setQuery }: { query: string; setQuery: (q: string) => void }) {
  return (
    <div className="side-find">
      <span className="side-find-mark" aria-hidden="true">
        <Icon name="search" />
      </span>
      <input
        className="field side-find-field"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a session"
        aria-label="Find a session by name, repo or id"
        spellCheck={false}
        autoComplete="off"
      />
      {query !== '' && (
        <button
          type="button"
          className="btn btn-icon side-find-clear"
          onClick={() => setQuery('')}
          title="Clear the filter"
        >
          <Icon name="close" />
          <span className="sr-only">Clear the filter</span>
        </button>
      )}
    </div>
  );
}

/**
 * A named run of rows, folded away by its own head.
 *
 * A fold is ignored while a filter is running. A folded group that quietly swallows the only match
 * would have the panel report "Nothing recorded 1" with the row you searched for inside it and no
 * sign that it is there — the filter is a question, and a stored preference may not answer it.
 * The fold itself is untouched, so clearing the filter puts the panel back as you left it.
 */
function Group({
  title,
  count,
  filtering,
  title2,
  children,
}: {
  title: string;
  count: number;
  filtering: boolean;
  title2?: string;
  children: React.ReactNode;
}) {
  const folded = useAppStore((s) => s.folded.includes(title));
  const toggleFold = useAppStore((s) => s.toggleFold);
  const open = filtering || !folded;
  return (
    <section className="side-section">
      <h2 className="side-section-h">
        <button
          type="button"
          className="side-section-head is-toggle"
          onClick={() => toggleFold(title)}
          aria-expanded={open}
          title={title2 ?? (open ? `Fold ${title} away` : `Show ${title}`)}
        >
          <span className={`chev ${open ? 'is-open' : ''}`} aria-hidden="true">
            ›
          </span>
          <span>{title}</span>
          <span className="num">{count}</span>
        </button>
      </h2>
      {open && children}
    </section>
  );
}

function SessionRow({
  s,
  selected,
  now,
  onSelect,
}: {
  s: SessionSummary;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const st = statusGlyph(s.status);
  const attention = needsYou(s, now);
  const repo = basename(s.repoRoot || s.cwd);
  // Untitled sessions fall back to the repo, so the repo label would repeat it; drop the label.
  // A session with nothing recorded has no repo worth naming either — several dozen of them share
  // the same one — so it is identified by the only thing that distinguishes it, its id.
  const name = s.title || (isEmpty(s) ? s.providerSessionId.slice(0, 8) : repo) || 'unnamed';
  const showRepo = name !== repo;
  const label = [
    name,
    showRepo && `in ${repo}`,
    st.label,
    s.counts.reviewOpen > 0 && `${s.counts.reviewOpen} to review`,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <li>
      <button
        type="button"
        className={`session-row ${selected ? 'is-selected' : ''} ${attention ? 'has-attn' : ''}`}
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        aria-label={label}
        title={showRepo ? `${name} — ${repo}` : name}
      >
        <span className={`status-dot ${st.cls}`} aria-hidden="true">
          {st.glyph}
        </span>
        {/*
         * One line, the way a page row in a well-made sidebar is one line. The repo moved into
         * the tooltip and the accessible name: it disambiguates two sessions with the same title,
         * which is worth having, but not worth a second line on every row to get it.
         */}
        <span className="session-title">{name}</span>
        <span className="session-when" title="Last activity">
          {relativeTime(s.lastEventAt ?? s.startedAt, now)}
        </span>
        {/*
         * One mark, and it carries a flag so the number reads as "things flagged" rather than as
         * an unread count. A bare ✕ for a failing check used to sit beside it; it was removed for
         * being two problems at once — at the right-hand edge of a row an ✕ reads as "dismiss",
         * and a failing check already opens a review item (`reviewRules.ts`), so it was counted
         * here twice over.
         */}
        {s.counts.reviewOpen > 0 && (
          <span
            className={`attn-badge num ${attention ? 'is-live' : ''}`}
            title={
              attention
                ? `${s.counts.reviewOpen} to review — needs you now`
                : `${s.counts.reviewOpen} flagged during this session; it is no longer running`
            }
          >
            <Icon name="flag" />
            {s.counts.reviewOpen}
          </span>
        )}
      </button>
    </li>
  );
}
