import { useEffect, useRef, useState } from 'react';
import { readToken, rememberToken, resolveToken } from './api/client.ts';
import { BrandLockup, BrandMark } from './components/Brand.tsx';
import { ConnectionBadge, ToolButton } from './components/Controls.tsx';
import { Icon } from './components/Icon.tsx';
import { RawDrawer } from './components/RawDrawer.tsx';
import { MarksKey, SessionList } from './components/SessionList.tsx';
import { SessionView } from './components/SessionView.tsx';
import { ExplainerSettings } from './components/Settings.tsx';
import { useSessionList } from './hooks/useLiveSession.ts';
import { useModalFocus } from './lib/useModalFocus.ts';
import { useAppStore } from './store/appStore.ts';

/** The one command that ends up back here with a token attached, named once because it is quoted twice. */
const COMMAND = 'salidium open';

/**
 * The only link in the application. The product had none at all, so a reader who wanted to know
 * what a word on a report meant had nowhere to go from inside the thing that printed it.
 */
const DOCS = 'https://salidium.com/docs';

/** Named for the platform, because "press the copy key" is not something anyone has ever pressed. */
const COPY_KEY = /Mac|iPhone|iPad/.test(navigator.platform ?? '') ? '\u2318C' : 'Ctrl+C';

/** Ticks once a minute so relative times stay honest without re-rendering on every event. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

export function App() {
  const api = useAppStore((s) => s.api);
  const setToken = useAppStore((s) => s.setToken);
  const authRejected = useAppStore((s) => s.authRejected);
  const selectedId = useAppStore((s) => s.selectedId);
  const select = useAppStore((s) => s.select);
  const order = useAppStore((s) => s.sessionOrder);
  const daemonError = useAppStore((s) => s.daemonError);
  const sessionCount = order.length;
  const listConnection = useAppStore((s) => s.listConnection);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const sideRef = useRef<HTMLElement>(null);
  const mobileSideTriggerRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowLayout();
  const mobileSidebarOpen = narrow && sidebarOpen;
  const now = useNow();

  useEffect(() => {
    const apply = () => {
      const token = resolveToken();
      if (token) setToken(token);
    };
    apply();
    // The CLI may deliver the token via a hash-only navigation on an already-open tab.
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [setToken]);

  // Hash routing: #/s/<sessionId>
  useEffect(() => {
    const apply = () => {
      const m = /^#\/s\/(.+)$/.exec(window.location.hash);
      if (m?.[1]) select(decodeURIComponent(m[1]));
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [select]);
  useEffect(() => {
    const target = selectedId ? `#/s/${encodeURIComponent(selectedId)}` : '';
    if (window.location.hash !== target && !/token=/.test(window.location.hash))
      history.replaceState(null, '', `${window.location.pathname}${target}`);
  }, [selectedId]);
  // Auto-select the most recent session when nothing is selected.
  useEffect(() => {
    if (!selectedId && order.length > 0) select(order[0]);
  }, [selectedId, order, select]);

  // The list toggle lives here rather than in the session view, so it still works on the empty
  // state — a collapsed sidebar with no session selected would otherwise have no way back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape' &&
        window.matchMedia('(max-width: 900px)').matches &&
        useAppStore.getState().sidebarOpen
      ) {
        useAppStore.getState().toggleSidebar();
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '[') useAppStore.getState().toggleSidebar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useModalFocus({
    // The gate renders before the authenticated app. Including readiness makes the focus effect
    // activate when the actual dialog mounts instead of spending its activation on a null ref.
    active: mobileSidebarOpen && Boolean(api),
    containerRef: sideRef,
    onClose: toggleSidebar,
    initialFocus: (root) =>
      root.querySelector<HTMLElement>('[data-modal-initial] button') ??
      root.querySelector<HTMLElement>('button:not([disabled])'),
    restoreFocus: () => mobileSideTriggerRef.current?.querySelector('button') ?? null,
    shouldRestoreFocus: () => !useAppStore.getState().sidebarOpen,
  });

  useSessionList();

  if (!api) return <Gate authRejected={authRejected} onToken={setToken} />;

  return (
    <div className={`app ${sidebarOpen ? '' : 'no-side'}`}>
      {/* Always present so it can fade with the drawer it dims; `.arrives` makes it deaf to the
          pointer the moment it starts leaving, so the fade cannot catch the tap that dismissed it. */}
      <div
        className={`side-backdrop arrives ${sidebarOpen ? 'is-open' : ''}`}
        aria-hidden="true"
        onClick={toggleSidebar}
      />
      {!sidebarOpen && (
        <div className="mobile-side-trigger" ref={mobileSideTriggerRef}>
          <ToolButton icon="panel" title="Show the session list ([)" onClick={toggleSidebar} />
        </div>
      )}
      {/* Biome resolves the native aside role statically; on mobile this element is explicitly a dialog. */}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-modal is paired with the conditional dialog role below. */}
      <aside
        ref={sideRef}
        className={`side arrives ${sidebarOpen ? 'is-open' : ''}`}
        role={mobileSidebarOpen ? 'dialog' : undefined}
        aria-modal={mobileSidebarOpen ? 'true' : undefined}
        aria-labelledby={mobileSidebarOpen ? 'session-list-title' : undefined}
        aria-label={mobileSidebarOpen ? undefined : 'Sessions'}
        tabIndex={mobileSidebarOpen ? -1 : undefined}
        /*
         * `display: none` takes a closed panel out of the tab order, but only once it has
         * finished leaving. For the 180ms in between it is still painted and still holds thirty
         * focusable rows, and the keyboard could walk back into a list the reader has just
         * dismissed. This is the same boolean the class is keyed to, so there is no second state
         * to keep in step, and no timer.
         */
        inert={!sidebarOpen}
        /*
         * Closed by `.arrives` rather than by `hidden`. The attribute cannot be used here any
         * more: it is `display: none` from the frame it is set, which is the frame the drawer is
         * supposed to spend sliding out. `.arrives` reaches the same `display: none` and takes
         * the panel out of the tab order and the accessibility tree exactly as `hidden` did, but
         * at the end of the gesture rather than instead of it.
         */
        onClickCapture={(event) => {
          if (
            window.matchMedia('(max-width: 900px)').matches &&
            (event.target as HTMLElement).closest('.session-row')
          )
            toggleSidebar();
        }}
      >
        <div className="side-head">
          <BrandMark size={22} className="side-mark" decorative />
          {/* The panel is the session list; the heading beside the mark is the product's name. */}
          <span className="side-head-title" id="session-list-title">
            Salidium
          </span>
          <ConnectionBadge status={listConnection} />
          {/* The key to the marks a row can carry, asked for rather than standing at the foot of
              the panel taking a row and a half of the list from it for good. */}
          {sessionCount > 0 && <MarksKey />}
          {/* When Salidium spends the reader's own quota on an explanation. It is a setting for the
              whole application rather than for a session, so it belongs to the surface that names
              the application — and deliberately not to the foot of the panel, which is empty. */}
          <ExplainerSettings />
          {/* The control that folds the list belongs to the list. Same primitive as the toolbar's,
              so it is the same box and the same glyph in both states rather than a stray chevron. */}
          <span data-modal-initial="true">
            <ToolButton icon="panel" title="Hide the session list ([)" onClick={toggleSidebar} />
          </span>
        </div>
        <SessionList now={now} />
        {/*
         * The banner used to be the thrown message alone: `daemon unreachable (Failed to fetch)`,
         * in red, with nothing to do about it. The message stays, because it says which failure
         * this was, but it is no longer the whole of what the reader is given.
         */}
        {daemonError && (
          <div className="side-error" role="alert">
            <p className="side-error-title">The session list is not updating</p>
            <p>
              {daemonError.message}.{' '}
              {daemonError.unreachable ? (
                <>
                  Start the daemon again with <code>salidium</code> in a terminal.
                </>
              ) : (
                'It is reachable, so this is worth reporting rather than restarting.'
              )}
            </p>
          </div>
        )}
      </aside>
      <main className="main" inert={mobileSidebarOpen} aria-hidden={mobileSidebarOpen || undefined}>
        {selectedId ? (
          <SessionView key={selectedId} sessionId={selectedId} now={now} />
        ) : (
          <div className="main-empty">
            {sessionCount === 0 ? (
              /*
               * The first screen anyone sees, and it used to be "Nothing to show yet." on its own:
               * a state described, in the larger half of a window whose smaller half was already
               * telling the reader what to do. Someone who has just installed this does not yet
               * know it watches an agent they have not started, so the pane that will hold the
               * report says what will put one there.
               *
               * It claims nothing about whether the hooks are connected, because nothing here has
               * checked that. It says what happens when a run starts, which is true either way.
               */
              <div className="main-empty-first">
                <p>A report appears here when your agent runs.</p>
                <p className="muted">
                  Start a run in Claude Code or Codex. Salidium reads the session it writes and
                  turns it into what changed, what was checked, and what needs you.
                </p>
                <a className="link" href={DOCS} target="_blank" rel="noreferrer">
                  Read the documentation
                </a>
              </div>
            ) : (
              <p className="muted">Pick a session to see what its agent did.</p>
            )}
          </div>
        )}
      </main>
      <div
        className="raw-layer"
        inert={mobileSidebarOpen}
        aria-hidden={mobileSidebarOpen || undefined}
      >
        <RawDrawer />
      </div>
    </div>
  );
}

/**
 * The gate: the whole application until a token arrives.
 *
 * It is a page rather than a dialog. It was a card — charcoal, rounded, drop-shadowed — sitting
 * 12vh down an otherwise empty window: measured at 1280x800, 200 px of card with 504 px of nothing
 * beneath it. A card is how a thing says it is laid over something else, and there is nothing
 * behind this one. It now follows the rule the stylesheet opens with, which the session page
 * already follows: separated by space and hairlines, not boxed.
 *
 * And it does the thing it is asking for. Before, it named a command and left you to read it,
 * switch app, retype it and come back — a dead end reached every single time the daemon restarts,
 * which is every time the token rotates. Now the command is one click to take, and if you already
 * have the token, the second path keeps you in the tab you are in.
 */
function Gate({
  authRejected,
  onToken,
}: {
  authRejected: boolean;
  onToken: (token: string) => void;
}) {
  /** `idle` → `copied` when the clipboard took it, → `selected` when it would not. */
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'selected'>('idle');
  const [pasted, setPasted] = useState('');
  const [bad, setBad] = useState(false);
  const cmdRef = useRef<HTMLElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (copyState === 'idle') return;
    const t = setTimeout(() => setCopyState('idle'), 2400);
    return () => clearTimeout(t);
  }, [copyState]);

  /**
   * Loopback is a secure context and the permission is granted, so this normally just works — but
   * `writeText` rejects with `NotAllowedError` whenever the document does not hold focus, which is
   * a state a real window gets into too. A button that silently does nothing is worse than the
   * screen this replaced, so the refusal selects the command instead and says so: the text is real
   * text for exactly this reason, and the keyboard can finish the job.
   */
  const copy = () => {
    const select = () => {
      const el = cmdRef.current;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setCopyState('selected');
    };
    if (!navigator.clipboard) return select();
    navigator.clipboard.writeText(COMMAND).then(() => setCopyState('copied'), select);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Empty is not a mistake, it is an unstarted field: say nothing and put the caret in it.
    if (pasted.trim() === '') {
      fieldRef.current?.focus();
      return;
    }
    const token = readToken(pasted);
    if (!token) {
      setBad(true);
      return;
    }
    setBad(false);
    rememberToken(token);
    onToken(token);
  };

  return (
    <div className="gate">
      <div className="gate-inner">
        <h1 className="gate-mark">
          <BrandLockup markSize={34} />
        </h1>
        <p className="gate-lede" role={authRejected ? 'alert' : undefined}>
          {authRejected
            ? 'The daemon restarted with a new token, so this page signed out.'
            : 'This page needs the token your daemon is listening for.'}
        </p>
        <p className="gate-note">
          It is rotated every time the daemon starts, so it is never the same one twice.
        </p>

        <div className="gate-cmd">
          <code ref={cmdRef}>{COMMAND}</code>
          <button
            type="button"
            className="btn btn-icon"
            onClick={copy}
            title={copyState === 'copied' ? 'Copied' : 'Copy the command'}
          >
            <Icon name={copyState === 'copied' ? 'check' : 'copy'} />
            <span className="sr-only">
              {copyState === 'copied' ? 'Copied' : 'Copy the command'}
            </span>
          </button>
        </div>
        <p className="gate-hint" role={copyState === 'idle' ? undefined : 'status'}>
          {copyState === 'copied'
            ? 'Copied. Run it in a terminal; it opens this page with the token attached.'
            : copyState === 'selected'
              ? `This window cannot reach the clipboard, so the command is selected — ${COPY_KEY} to take it.`
              : 'Run it in a terminal; it opens this page with the token attached.'}
        </p>

        {/* Already holding it — from the URL the CLI printed, or from `daemon.json`. */}
        <form className="gate-paste" onSubmit={submit}>
          <input
            ref={fieldRef}
            className="field gate-field"
            value={pasted}
            onChange={(e) => {
              setPasted(e.target.value);
              setBad(false);
            }}
            placeholder="or paste the token, or the URL carrying it"
            aria-label="Daemon token, or a URL containing it"
            aria-invalid={bad || undefined}
            spellCheck={false}
            autoComplete="off"
          />
          {/*
           * Always live. Disabled it sat at 45% opacity, which is legal — a disabled control is
           * exempt from the contrast floor — and still read as broken furniture rather than as a
           * control waiting for something. An empty submit just puts the caret in the field.
           */}
          <button type="submit" className="btn btn-accent">
            Connect
          </button>
        </form>
        {bad && (
          <p className="gate-bad" role="alert">
            That is not a token. It is a long run of hex, and the URL the command prints carries one
            after <code>#token=</code>.
          </p>
        )}
      </div>
    </div>
  );
}
