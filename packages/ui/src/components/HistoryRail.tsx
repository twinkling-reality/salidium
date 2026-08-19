import type { SemanticChange } from '@salidium/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RefCallback } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { timeOfDay } from '../lib/format.ts';
import { useScrollState } from '../lib/useScrollState.ts';
import { useAppStore } from '../store/appStore.ts';
import { ToolButton } from './Controls.tsx';
import { FACET_LABEL, HistoryFilter } from './HistoryFilter.tsx';
import { epistemicClass } from './Provenance.tsx';

/**
 * The semantic history: every change to What/Why/How/Verified/Left/Review, in order. Selecting an
 * entry scrubs the whole view to the state as of that moment (replayed from the nearest checkpoint
 * by the daemon). This is history as Salidium's structured representation, not the raw transcript.
 *
 * An entry is two lines in a 320 px rail, not four columns squeezed into one. The four-column
 * version put the time, the facet, the summary and the provenance side by side and every one of
 * them wrapped: "02:54 PM" broke across two lines, the facet was an unstyled word floating in the
 * middle of the row, and the drill-through link read as a filename. Now the first line is the
 * entry's identity — a facet colour, its name, the time — and the second is what happened.
 */
export function HistoryRail({
  changes,
  scrubTs,
  focusSeq,
  onScrub,
  onLive,
  onClose,
  onRef,
}: {
  changes: SemanticChange[];
  scrubTs?: string;
  /** Opened from "N new": start showing only the changes the reader has not seen. */
  focusSeq?: number;
  onScrub: (ts: string, seq: number) => void;
  onLive: () => void;
  onClose: () => void;
  onRef: (eventId: string) => void;
}) {
  const kinds = useAppStore((s) => s.historyKinds);
  const setHistoryMode = useAppStore((s) => s.setHistoryMode);
  const parentRef = useRef<HTMLDivElement>(null);
  const fadeRef = useScrollState<HTMLDivElement>();
  // The virtualizer needs the node in an object ref; the fade needs it in a callback ref that
  // owns a cleanup. Both get it, and the cleanup is handed back so React can run it on detach.
  const listRef = useCallback<RefCallback<HTMLDivElement>>(
    (el) => {
      parentRef.current = el;
      return fadeRef(el);
    },
    [fadeRef],
  );
  /**
   * Opened from "N new", the rail shows those changes and nothing else.
   *
   * Scrolling to them was the obvious move and it was wrong: entries wrap to different heights, so
   * a virtualized `scrollToIndex` lands on estimates and misses by hundreds of pixels, dropping
   * the reader into the middle of a long history with nothing marked on screen.
   */
  const [onlyNew, setOnlyNew] = useState(focusSeq !== undefined);
  useEffect(() => setOnlyNew(focusSeq !== undefined), [focusSeq]);
  const showingOnlyNew = onlyNew && focusSeq !== undefined;
  const on = useMemo(() => new Set(kinds), [kinds]);
  const filtered = useMemo(
    () =>
      changes.filter((c) => on.has(c.facet) && (!showingOnlyNew || c.seq > (focusSeq as number))),
    [changes, on, showingOnlyNew, focusSeq],
  );
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 12,
    /*
     * React 19 refuses a `flushSync` from inside a lifecycle method, and that is exactly where
     * `measureElement` calls one: the console filled with "React cannot flush when React is
     * already rendering" and the re-render carrying the new offsets never ran. Rows recorded
     * their measured heights and kept the positions the 52 px estimate had given them, so every
     * entry taller than the estimate was drawn over the one below it — measured here at 57, 75,
     * 110 px against a 52 px pitch, which in a rail of wrapped prose is most of them.
     *
     * Without it the re-render is batched instead of synchronous. The cost is a possible one-frame
     * settle while scrolling fast; the alternative is text permanently printed on top of text.
     */
    useFlushSync: false,
    /*
     * The rail is a log: new entries arrive at the bottom and that is where the reader is. Saying
     * so is what keeps it correct while rows measure — `anchorTo: 'end'` compensates the scroll by
     * the size delta as each estimate is replaced by a real height, and `followOnAppend` does the
     * pinning the library is built to do rather than an effect racing it from outside.
     *
     * Left to an effect calling `scrollToIndex`, the last rows to arrive were the ones never
     * measured: pinning to the tail is itself a scroll, and `virtual-core` skips measuring a row
     * that mounts during one. They stayed at the 52 px estimate while standing 57 to 110 px tall,
     * drawn over each other at the foot of the rail, and did not settle until the reader happened
     * to scroll. Deferring the observer to a frame (`useAnimationFrameWithResizeObserver`) was
     * tried first and measured no different.
     */
    anchorTo: 'end',
    followOnAppend: true,
  });
  const [followTail, setFollowTail] = useState(true);
  /*
   * Re-pinned when the measured total changes, not only when an entry arrives. Rows are measured
   * after they mount, so the first scroll to the end can land on the estimate and stop short of the
   * newest entries. The total size is the signal that the list has re-measured, and
   * with `anchorTo: 'end'` above the measurements now land, so this converges instead of chasing.
   */
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    if (followTail && scrubTs === undefined && filtered.length > 0 && totalSize > 0)
      virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' });
  }, [filtered.length, followTail, scrubTs, virtualizer, totalSize]);

  return (
    <aside className="inspector history" aria-label="History">
      {/*
       * Mirrors the session list: that panel puts its name at the outer edge and its fold control
       * at the inner one, so this panel does the same in reverse.
       */}
      <div className="inspector-head">
        <ToolButton icon="panel" title="Hide history (h)" onClick={onClose} />
        <HistoryFilter />
        <ToolButton
          icon="table"
          title="Open the history as a table across the page"
          onClick={() => setHistoryMode('table')}
        />
        <span className="inspector-title">
          {showingOnlyNew ? 'Since you looked' : 'History'}{' '}
          <span className="num">{filtered.length}</span>
        </span>
      </div>

      {/* Only while scrubbing: a contextual bar, not a control that is always on screen. */}
      {(scrubTs !== undefined || showingOnlyNew) && (
        <div className="history-scope">
          {scrubTs !== undefined && (
            <ToolButton
              icon="latest"
              label="Back to live"
              title="Stop showing a past moment"
              onClick={onLive}
            />
          )}
          {showingOnlyNew && (
            <button type="button" className="btn" onClick={() => setOnlyNew(false)}>
              Show all history
            </button>
          )}
        </div>
      )}

      <div
        className="history-list scroll-fade"
        ref={listRef}
        onScroll={() => {
          const el = parentRef.current;
          if (!el) return;
          setFollowTail(el.scrollTop + el.clientHeight >= el.scrollHeight - 40);
        }}
      >
        {filtered.length === 0 && <div className="side-empty muted">No history yet.</div>}
        <div style={{ height: totalSize, position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const c = filtered[vi.index];
            if (!c) return null;
            const isScrub = scrubTs !== undefined && c.ts === scrubTs;
            const isFuture = scrubTs !== undefined && c.ts > scrubTs;
            return (
              <div
                key={`${c.seq}:${c.ordinal}`}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className={`hist-item facet-${c.facet} ${isScrub ? 'is-scrub' : ''} ${isFuture ? 'is-future' : ''}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <button
                  type="button"
                  className="hist-main"
                  onClick={() => onScrub(c.ts, c.seq)}
                  title="Show the session as of this moment"
                >
                  <span className="hist-meta">
                    <span className="hist-dot" aria-hidden="true" />
                    <span className="hist-facet">{FACET_LABEL[c.facet]}</span>
                    {/* Only exceptions print: "observed" is the default and says nothing. */}
                    {c.epistemic !== 'observed' && (
                      <span
                        className={`hist-prov ${epistemicClass(c.epistemic)}`}
                        title={
                          c.epistemic === 'explained'
                            ? 'Generated by a model, not observed'
                            : c.epistemic === 'reported'
                              ? 'The agent said so; Salidium did not see it'
                              : 'Worked out by Salidium rather than seen directly'
                        }
                      >
                        {c.epistemic}
                      </span>
                    )}
                    {/* Last, so it holds the right edge whether or not provenance printed. */}
                    <span className="hist-time mono">{timeOfDay(c.ts)}</span>
                  </span>
                  <span className="hist-text">{c.summary}</span>
                </button>
                {c.refs[0] && (
                  <button
                    type="button"
                    className="link hist-record"
                    onClick={() => onRef(c.refs[0] ?? '')}
                    title="Open the raw record this came from"
                  >
                    record
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
