import type { StoredEvent } from '@salidium/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText, selectNode } from '../lib/copy.ts';
import { type Fact, recordFacts } from '../lib/recordFacts.ts';
import { useModalFocus } from '../lib/useModalFocus.ts';
import { useScrollState } from '../lib/useScrollState.ts';
import { useAppStore } from '../store/appStore.ts';
import { Icon } from './Icon.tsx';
import { Loading } from './Loading.tsx';

interface Raw {
  event: StoredEvent;
  raw: unknown;
  path?: string;
  line?: number;
  reason?: string;
}

/**
 * The drill-through: the record behind whatever statement the reader just pressed.
 *
 * This is the product's central promise made checkable — every derived statement links here, and
 * here is where you find out whether Salidium invented it. Two panes, because there are two
 * different things to check: the **Salidium event** is what was derived and stored, against the
 * schemas in `packages/protocol`; the **provider record** is the original line from the agent's
 * own file, fetched on demand by `api.raw()`, redacted at render, and reported with `path:line`.
 * If those two disagree, the page is wrong, and that is the whole point of being able to see both.
 *
 * It used to be `JSON.stringify` and nothing else, which made the one screen whose job is to be
 * legible the least legible screen in the app. A command can sit deep inside a blob under opaque
 * identifiers, so the facts are named
 * (`recordFacts`) and the whole record is one press away, rather than the other way round.
 *
 * It behaves as a modal dialog: focus moves into it on open, Tab cycles inside it, Escape closes
 * it, the arrow keys step to the neighbouring record, and focus returns to the trigger.
 */
export function RawDrawer() {
  const api = useAppStore((s) => s.api);
  const rawOpen = useAppStore((s) => s.rawOpen);
  const closeRaw = useAppStore((s) => s.closeRaw);
  const openRaw = useAppStore((s) => s.openRaw);
  const [data, setData] = useState<Raw | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pane, setPane] = useState<'event' | 'raw'>('event');
  /** The ids either side of this record in the order Salidium stored them, once they are known. */
  const [step, setStep] = useState<{ prev?: string; next?: string }>({});
  const drawerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useScrollState<HTMLDivElement>();

  useEffect(() => {
    if (!api || !rawOpen) return;
    setData(undefined);
    setError(undefined);
    setStep({});
    api
      .raw(rawOpen.sessionId, rawOpen.eventId)
      .then(setData, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, rawOpen]);

  /*
   * The neighbours, in one request.
   *
   * Sequence numbers are assigned by the coordinator and are contiguous from zero, so the records
   * either side of `seq` are `seq ± 1`, and `events(after, until)` is
   * `seq > after AND seq <= until`. Asking for the window
   * rather than computing the ids means the ends of a session need no special case: at seq 0 the
   * window simply comes back without a previous record.
   */
  const sessionId = rawOpen?.sessionId;
  const seq = data?.event.seq;
  useEffect(() => {
    if (!api || sessionId === undefined || seq === undefined) return;
    let live = true;
    api.events(sessionId, seq - 2, seq + 1, 3).then(
      (near) => {
        if (!live) return;
        setStep({
          prev: near.find((e) => e.seq === seq - 1)?.id,
          next: near.find((e) => e.seq === seq + 1)?.id,
        });
      },
      () => {
        /* Stepping is an extra; a session that will not list its events still shows this one. */
      },
    );
    return () => {
      live = false;
    };
  }, [api, sessionId, seq]);

  const go = useCallback(
    (id: string | undefined) => {
      if (id && sessionId) openRaw(sessionId, id);
    },
    [openRaw, sessionId],
  );

  const isOpen = rawOpen !== undefined;
  useModalFocus({
    active: isOpen,
    containerRef: drawerRef,
    onClose: closeRaw,
    initialFocus: (root) => root.querySelector<HTMLElement>('[data-modal-initial]'),
  });

  useEffect(() => {
    if (!rawOpen) return;
    const onKey = (e: KeyboardEvent) => {
      // Stepping the log, not moving a caret: only when nothing text-shaped has the focus.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const a = document.activeElement;
        if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        go(e.key === 'ArrowLeft' ? step.prev : step.next);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rawOpen, go, step]);

  if (!rawOpen) return null;
  const rf = data ? recordFacts(data.event) : undefined;
  return (
    <div
      className="drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawer-title"
      ref={drawerRef}
      tabIndex={-1}
    >
      {/*
       * Two rows of chrome, and both carry something. It was five: a title, a line of prose about
       * why the drawer exists, a pane row empty across two thirds of its width, then the record's
       * kind and a caption restating the pane you had just pressed. The reason the drawer exists
       * is carried by the two pane names and their tooltips — which is where a reader asks the
       * question — rather than by a sentence printed over every record forever. Chrome is iconic
       * and only the pane names are words, which is the rule `ToolButton` already states.
       */}
      <div className="drawer-head">
        <h2 className="drawer-title" id="drawer-title">
          {rf ? rf.title : 'Source record'}
        </h2>
        <div className="drawer-acts">
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => go(step.prev)}
            disabled={!step.prev}
            title="The record before this one (←)"
          >
            <Icon name="prev" />
            <span className="sr-only">The record before this one</span>
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => go(step.next)}
            disabled={!step.next}
            title="The record after this one (→)"
          >
            <Icon name="next" />
            <span className="sr-only">The record after this one</span>
          </button>
          {data && <SaveRecord data={data} />}
          <span className="toolbar-sep" aria-hidden="true" />
          <button
            type="button"
            className="btn btn-icon"
            onClick={closeRaw}
            title="Close (Escape)"
            data-modal-initial="true"
          >
            <Icon name="close" />
            <span className="sr-only">Close</span>
          </button>
        </div>
      </div>
      <div className="drawer-panes">
        {/*
         * `btn` rather than a bare element with a state class. With no rule of their own these
         * two fell through to the reset — transparent, unpadded, unbordered, and the selected one
         * measured the same colour as the unselected one — so the head read as one title,
         * "Salidium event Provider record", instead of as two things you can press and one of
         * them being the one you are looking at. `aria-pressed` was carrying the whole state,
         * which is correct and invisible.
         */}
        <button
          type="button"
          aria-pressed={pane === 'event'}
          className={`btn ${pane === 'event' ? 'is-on' : ''}`}
          onClick={() => setPane('event')}
          title="What Salidium derived and stored"
        >
          Salidium event
        </button>
        <button
          type="button"
          aria-pressed={pane === 'raw'}
          className={`btn ${pane === 'raw' ? 'is-on' : ''}`}
          onClick={() => setPane('raw')}
          title="The original line from the agent's own file"
        >
          Provider record
        </button>
        {/* The right of this row was empty across two thirds of the drawer. It holds the record's
            identity now — which one, off which channel — where a reader stepping the log with the
            arrow keys is already looking, and it is no longer repeated in the fact list below. */}
        {rf && <span className="drawer-id mono">{rf.meta}</span>}
      </div>
      <div className="drawer-body scroll-fade" ref={bodyRef}>
        {error && (
          <div className="bad" role="alert">
            {error}
          </div>
        )}
        {!data && !error && (
          <div className="muted" role="status">
            <Loading label="Loading the record" />
          </div>
        )}
        {data && rf && pane === 'event' && (
          <>
            <Facts facts={rf.facts} />
            <h3 className="drawer-sub">How we know</h3>
            <Facts facts={rf.origin} />
            {/*
             * The whole record, still here and still one press away. The named facts above are a
             * reading of it, and a reading is exactly the thing this drawer exists to let you
             * check — so it may never be the only thing on offer.
             */}
            <details className="drawer-full">
              <summary>Everything Salidium stored, as it is stored</summary>
              <pre className="mono">{JSON.stringify(data.event, null, 2)}</pre>
            </details>
          </>
        )}
        {data && pane === 'raw' && (
          <>
            {data.path !== undefined && (
              <Facts
                facts={[
                  {
                    label: 'Line',
                    value: `${data.path}:${(data.line ?? 0) + 1}`,
                    mono: true,
                    copy: true,
                  },
                ]}
              />
            )}
            {data.raw === null || data.raw === undefined ? (
              <p className="muted">{data.reason ?? 'No raw record.'}</p>
            ) : (
              <pre className="mono drawer-raw">
                {typeof data.raw === 'string' ? data.raw : JSON.stringify(data.raw, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/*
 * Keyed by content rather than by position, and it matters here: stepping to the next record
 * replaces every fact while this list stays mounted, and a positional key would carry the copy
 * button's "copied" flag from one record's first fact onto the next one's. A repeated label and
 * value — two identical plan items, say — takes an occurrence number so the keys stay unique.
 */
function Facts({ facts }: { facts: Fact[] }) {
  if (facts.length === 0) return null;
  const seen = new Map<string, number>();
  const rows = facts.map((fact) => {
    const base = `${fact.label}\u0000${fact.value}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { fact, key: n === 1 ? base : `${base}\u0000${n}` };
  });
  return (
    <dl className="facts">
      {rows.map((r) => (
        <FactRow key={r.key} fact={r.fact} />
      ))}
    </dl>
  );
}

/**
 * One named fact. The copy control belongs to the row rather than to a toolbar, because what a
 * reader wants out of here is one value — the command, the path, the sha — and not the record.
 */
function FactRow({ fact }: { fact: Fact }) {
  const [state, setState] = useState<'idle' | 'copied' | 'selected'>('idle');
  const valueRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2400);
    return () => clearTimeout(t);
  }, [state]);
  const copy = () => {
    void copyText(fact.value).then((r) => {
      if (r === 'copied') return setState('copied');
      selectNode(valueRef.current);
      setState('selected');
    });
  };
  return (
    <div className={`fact ${fact.block ? 'is-block' : ''}`}>
      <dt className="fact-label">{fact.label}</dt>
      <dd className="fact-value">
        <span className={fact.mono ? 'mono' : undefined} ref={valueRef}>
          {fact.value}
        </span>
        {fact.note && <span className="fact-note">{fact.note}</span>}
        {fact.copy && (
          <button
            type="button"
            className="btn btn-icon fact-copy"
            onClick={copy}
            title={
              state === 'copied'
                ? 'Copied'
                : state === 'selected'
                  ? 'This window cannot reach the clipboard, so it is selected instead'
                  : `Copy the ${fact.label.toLowerCase()}`
            }
          >
            <Icon name={state === 'copied' ? 'check' : 'copy'} />
            <span className="sr-only">Copy the {fact.label.toLowerCase()}</span>
          </button>
        )}
      </dd>
    </div>
  );
}

/**
 * Takes the pair away as a file: the event Salidium stored and the provider line beside it, which
 * is the shape you want when the reason you opened this was to show someone else that the two
 * disagree. Built and revoked on the click rather than held, so a drawer left open holds no blob.
 */
function SaveRecord({ data }: { data: Raw }) {
  const save = () => {
    const body = JSON.stringify(
      {
        event: data.event,
        provider: { path: data.path, line: data.line, record: data.raw, reason: data.reason },
      },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `salidium-${data.event.seq}-${data.event.kind}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <button
      type="button"
      className="btn btn-icon"
      onClick={save}
      title="Save both records as a JSON file"
    >
      <Icon name="save" />
      <span className="sr-only">Save both records as a JSON file</span>
    </button>
  );
}
