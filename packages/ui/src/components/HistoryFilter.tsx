import type { Facet } from '@salidium/protocol';
import { useState } from 'react';
import { ALL_FACETS, useAppStore } from '../store/appStore.ts';
import { useDismiss } from './Controls.tsx';
import { Icon } from './Icon.tsx';

const FACET_LABEL: Record<Facet, string> = {
  status: 'status',
  what: 'what changed',
  why: 'why',
  how: 'how',
  verified: 'checks',
  left: 'left to do',
  review: 'needs review',
};

/**
 * Which kinds of change the history shows, shared by the rail and the table.
 *
 * It was called "Kinds" and looked like a label rather than a control. A filter icon and the word
 * "Filter" say what it is; the pill says what it is currently doing. The swatch in each row is
 * filled when that kind is included and hollow when it is not, so the selection is legible without
 * reading the labels — before, only the label's weight changed, and a multi-select whose state you
 * have to squint at is a multi-select nobody trusts.
 */
export function HistoryFilter() {
  const kinds = useAppStore((s) => s.historyKinds);
  const setKinds = useAppStore((s) => s.setHistoryKinds);
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const on = new Set(kinds);
  const allOn = on.size === ALL_FACETS.length;
  const toggle = (f: Facet) => setKinds(on.has(f) ? kinds.filter((k) => k !== f) : [...kinds, f]);
  return (
    <div className="pop" ref={ref}>
      <button
        type="button"
        className={`btn ${open ? 'is-on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Choose which kinds of change to show"
      >
        <Icon name="filter" />
        <span>Filter</span>
        <span className="btn-pill">{allOn ? 'All' : `${on.size}/${ALL_FACETS.length}`}</span>
      </button>
      <div className={`pop-panel is-left is-narrow arrives ${open ? 'is-open' : ''}`}>
        <div className="pop-head">
          <span>Show</span>
          {!allOn && (
            <button
              type="button"
              className="pop-help"
              onClick={() => setKinds([...ALL_FACETS])}
              title="Show every kind again"
            >
              <Icon name="reset" />
              <span className="sr-only">Show every kind again</span>
            </button>
          )}
        </div>
        <fieldset className="opts">
          <legend className="sr-only">Kinds of change to show</legend>
          {ALL_FACETS.map((f) => (
            <label className={`opt is-tight ${on.has(f) ? 'is-on' : ''}`} key={f}>
              <input
                className="sr-only"
                type="checkbox"
                checked={on.has(f)}
                onChange={() => toggle(f)}
              />
              <span className={`opt-swatch facet-${f}`} aria-hidden="true" />
              <span className="opt-name">{FACET_LABEL[f]}</span>
            </label>
          ))}
        </fieldset>
      </div>
    </div>
  );
}

export { FACET_LABEL };
