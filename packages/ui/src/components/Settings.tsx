import type { ExplainerCadence } from '@salidium/protocol';
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore.ts';
import { useDismiss } from './Controls.tsx';
import { Icon } from './Icon.tsx';

/**
 * When Salidium asks a model to explain a session, and what that has cost so far.
 *
 * It is the only setting on the page that is not the browser's. Detail, theme and the folds are
 * this window's opinion about this window; this one tells the daemon to spend, or not spend, the
 * reader's own subscription quota while they are not looking. So it is stored there, it survives a
 * restart, and it is read back rather than assumed.
 *
 * Same instrument as the depth control, for the same reason: three named stops, each stating what
 * it does, rather than a switch or a slider. A frequency has no good end to label — "less" and
 * "more" of what? — while "Off", "When a session ends" and "While it works" are the three things a
 * reader actually wants and each says what it buys.
 */
const STOPS: Array<{ value: ExplainerCadence; name: string; adds: string }> = [
  {
    value: 'off',
    name: 'Off',
    adds: 'The page Salidium derives, and nothing else. No model is ever called.',
  },
  {
    value: 'session',
    name: 'When a session ends',
    adds: 'One explanation each, written once a session has finished or gone quiet.',
  },
  {
    value: 'turn',
    name: 'While it works',
    adds: 'A fresh explanation at every turn end, so the page keeps up with the agent.',
  },
];

/** Observed token counts, in the order the record drawer lists them for one call. */
const TOKENS: Array<{
  key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens';
  label: string;
}> = [
  { key: 'inputTokens', label: 'input' },
  { key: 'outputTokens', label: 'output' },
  { key: 'cacheReadTokens', label: 'cache read' },
  { key: 'cacheWriteTokens', label: 'cache write' },
];

export function ExplainerSettings() {
  const api = useAppStore((s) => s.api);
  const explainer = useAppStore((s) => s.explainer);
  const loadExplainer = useAppStore((s) => s.loadExplainer);
  const setCadence = useAppStore((s) => s.setExplainerCadence);
  const [open, setOpen] = useState(false);
  const [explain, setExplain] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  // Read once the client exists rather than when the panel opens: the stop is the daemon's, and a
  // panel that opened on nothing and filled in a moment later would show the wrong radio first.
  useEffect(() => {
    if (api) loadExplainer();
  }, [api, loadExplainer]);

  const cadence = explainer?.cadence;
  const usage = explainer?.usage;
  return (
    <div className="pop" ref={ref}>
      {/*
       * Iconic, because the sidebar head is chrome: it identifies the surface rather than saying
       * anything about the session, and the panel it opens names itself. The glyph is the depth
       * control's — the icon set has no gear and drawing one is not this change's to make — and the
       * two are told apart by the pill: the depth control always carries its current level beside
       * the mark, so a bare mark in the panel head is not the same object twice.
       */}
      <button
        type="button"
        className={`btn btn-icon ${open ? 'is-on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="When Salidium explains"
      >
        <Icon name="sliders" />
        <span className="sr-only">When Salidium explains</span>
      </button>
      <div className={`pop-panel arrives ${open ? 'is-open' : ''}`}>
        <div className="pop-head">
          <span>Explaining</span>
          <button
            type="button"
            className={`pop-help ${explain ? 'is-on' : ''}`}
            onClick={() => setExplain((e) => !e)}
            aria-expanded={explain}
            title="What this control does"
          >
            <span aria-hidden="true">?</span>
            <span className="sr-only">What this control does</span>
          </button>
        </div>
        {explain && (
          <p className="pop-note">
            Everything else on the page is observed or derived from what was observed. The
            explanation is the one part a model writes, on the subscription you already have.
          </p>
        )}
        {/* Real radios in a real fieldset, as the depth control does: arrow keys, grouping and
              announcement all come from the platform. */}
        <fieldset className="opts">
          <legend className="sr-only">When Salidium explains</legend>
          {STOPS.map((s) => (
            <label className={`opt ${s.value === cadence ? 'is-on' : ''}`} key={s.value}>
              <input
                className="sr-only"
                type="radio"
                name="salidium-explainer"
                checked={s.value === cadence}
                // Inert until the daemon has answered. The stop is its state, not this window's,
                // and a radio that could be pressed before the current one is known would be
                // offering to change something it cannot yet show.
                disabled={cadence === undefined}
                // The depth control closes on a choice because the page behind it changes and you
                // want to see it. Nothing here changes behind the panel, and what is worth reading
                // next — what this has already cost — is inside it, so it stays open.
                onChange={() => setCadence(s.value)}
              />
              <span className="opt-mark" aria-hidden="true" />
              <span className="opt-text">
                <span className="opt-name">{s.name}</span>
                <span className="opt-adds">{s.adds}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {/*
         * A control that quietly does nothing is worse than no control. The kill switch in the
         * daemon's environment outranks whatever is chosen here, so when it is set the panel says
         * so — and still shows the stop that was chosen, because that is the one that comes back
         * when the variable goes away.
         */}
        {explainer?.envOff && (
          <p className="pop-note">
            The daemon was started with the explainer switched off in its environment, so nothing is
            generated whichever stop is chosen here.
          </p>
        )}
        {/*
         * What it has cost, when Salidium has seen it cost anything — never a heading over
         * nothing. Tokens only: they were observed and are printed as fact, whereas a figure in
         * dollars is arithmetic over a price table and, on a subscription, no dollar is charged
         * at all. Neither of those two sentences fits in 236 px, so the money does not go here.
         *
         * The whole section is omitted when nothing was observed, but a zero inside it is kept:
         * these four are read against each other, and a list whose rows come and go with the data
         * makes "none of this kind" indistinguishable from "this kind was not counted". Zero
         * cache reads is a real and interesting thing to have measured.
         */}
        {usage && (
          <>
            <div className="pop-head">
              <span>Consumed</span>
            </div>
            <dl className="usage">
              <div>
                <dt>responses</dt>
                <dd className="mono">{usage.messages.toLocaleString()}</dd>
              </div>
              {TOKENS.map((t) => (
                <div key={t.key}>
                  <dt>{t.label}</dt>
                  <dd className="mono">{usage[t.key].toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </div>
  );
}
