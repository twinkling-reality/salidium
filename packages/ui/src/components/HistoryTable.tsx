import type { SemanticChange } from '@salidium/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type RefCallback, useCallback, useMemo, useRef } from 'react';
import { timeOfDay } from '../lib/format.ts';
import { useScrollState } from '../lib/useScrollState.ts';
import { useAppStore } from '../store/appStore.ts';
import { ToolButton } from './Controls.tsx';
import { FACET_LABEL, HistoryFilter } from './HistoryFilter.tsx';
import { historyAriaRowCount, historyAriaRowIndex } from './historyAria.ts';
import { Icon } from './Icon.tsx';

/**
 * The change log as rows and columns, filling the page.
 *
 * The rail is right for glancing at while you read the session, and wrong for working through four
 * hundred entries: at 320 px every summary wraps to three lines and the time, the kind and the
 * provenance have nowhere to line up. Given the width, they become columns you can read down —
 * which is the whole reason a table exists.
 *
 * Same data, same filter, same scrub-on-click as the rail. Only the shape differs.
 */
export function HistoryTable({
  changes,
  scrubTs,
  onScrub,
  onLive,
  onRef,
}: {
  changes: SemanticChange[];
  scrubTs?: string;
  onScrub: (ts: string, seq: number) => void;
  onLive: () => void;
  onRef: (eventId: string) => void;
}) {
  const kinds = useAppStore((s) => s.historyKinds);
  const setHistoryMode = useAppStore((s) => s.setHistoryMode);
  const parentRef = useRef<HTMLDivElement>(null);
  const fadeRef = useScrollState<HTMLDivElement>();
  const scrollRef = useCallback<RefCallback<HTMLDivElement>>(
    (el) => {
      parentRef.current = el;
      return fadeRef(el);
    },
    [fadeRef],
  );
  const on = useMemo(() => new Set(kinds), [kinds]);
  const rows = useMemo(() => changes.filter((c) => on.has(c.facet)), [changes, on]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 16,
    // Same reason as the rail: see `HistoryRail.tsx`.
    useFlushSync: false,
  });

  return (
    <div className="htab">
      <header className="htab-head">
        <h1 className="htab-title">
          History <span className="num">{rows.length}</span>
        </h1>
        <div className="toolbar htab-tools">
          <HistoryFilter />
          {scrubTs !== undefined && (
            <ToolButton
              icon="latest"
              label="Back to live"
              title="Stop showing a past moment"
              onClick={onLive}
            />
          )}
          <ToolButton
            icon="panel"
            label="Show beside"
            title="Move the history back into the side rail"
            onClick={() => setHistoryMode('rail')}
          />
        </div>
      </header>

      {/*
       * Divs with explicit grid roles rather than real table markup. A virtualized list needs its
       * rows absolutely positioned inside a scrolling box, which means overriding `display` on the
       * table, the body and every row — and once `display` is not `table-*`, the browser drops the
       * table semantics anyway. Real `<table>` elements here would buy the appearance of
       * correctness and cost the accessibility tree the roles it actually needs.
       */}
      {/* biome-ignore-start lint/a11y/useSemanticElements: table display is overridden for virtualization, see above */}
      {/* biome-ignore-start lint/a11y/useFocusableInteractive: grid cells are static; the controls inside them take focus */}
      <div
        className="htab-grid"
        role="table"
        aria-label="History"
        aria-rowcount={historyAriaRowCount(rows.length)}
      >
        <div className="htab-row is-head" role="row" aria-rowindex={1}>
          <span role="columnheader">When</span>
          <span role="columnheader">Kind</span>
          <span role="columnheader">Change</span>
          <span role="columnheader">How we know</span>
          <span role="columnheader">
            <span className="sr-only">Record</span>
          </span>
        </div>
        <div className="htab-scroll scroll-fade" ref={scrollRef}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const c = rows[vi.index];
              if (!c) return null;
              const isScrub = scrubTs !== undefined && c.ts === scrubTs;
              const isFuture = scrubTs !== undefined && c.ts > scrubTs;
              return (
                <div
                  key={`${c.seq}:${c.ordinal}`}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  role="row"
                  aria-rowindex={historyAriaRowIndex(vi.index)}
                  className={`htab-row facet-${c.facet} ${isScrub ? 'is-scrub' : ''} ${isFuture ? 'is-future' : ''}`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <span role="cell">
                    <button
                      type="button"
                      className="htab-when mono"
                      onClick={() => onScrub(c.ts, c.seq)}
                      title="Show the session as of this moment"
                    >
                      {timeOfDay(c.ts)}
                    </button>
                  </span>
                  <span role="cell" className="htab-kind">
                    <span className="hist-dot" aria-hidden="true" />
                    {FACET_LABEL[c.facet]}
                  </span>
                  <span role="cell" className="htab-text">
                    {c.summary}
                  </span>
                  <span role="cell" className="htab-prov">
                    {c.epistemic === 'observed' ? '' : c.epistemic}
                  </span>
                  <span role="cell">
                    {c.refs[0] && (
                      <button
                        type="button"
                        className="tag-ev"
                        onClick={() => onRef(c.refs[0] ?? '')}
                        title="Open the raw record this came from"
                      >
                        <Icon name="record" />
                        record
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {/* biome-ignore-end lint/a11y/useFocusableInteractive: see above */}
      {/* biome-ignore-end lint/a11y/useSemanticElements: see above */}
      {rows.length === 0 && <p className="rp-empty">No history yet.</p>}
    </div>
  );
}
