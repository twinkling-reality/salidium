import type { CommitRow, VerificationRow } from '@salidium/core';
import type { SemanticChange } from '@salidium/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { timeOfDay } from '../lib/format.ts';
import { useDismiss } from './Controls.tsx';
import { Icon } from './Icon.tsx';

/**
 * The shape of the session, and the control for moving through it — one object, because they are
 * the same thing. The track is one step per moment something changed; marks show the steps that
 * decide whether to trust it (checks passing or failing, commits). Dragging the handle replays the
 * whole view as it stood at that step.
 *
 * The track used to span wall-clock time, which spent much of its width drawing gaps between bursts
 * of work and offered many handle positions that replayed the same state. One stop per moment
 * makes every position a state that exists. The clock is not lost: it is in the two end labels and the
 * `showing 2:41 PM` readout, which is where a reader was reading it anyway.
 *
 * The handle is a real range input rather than a div with mouse handlers, so it arrows, tabs and
 * announces itself without a pile of ARIA; the drawing behind it is decoration and is hidden from
 * assistive tech, which reads the value text instead.
 */

/**
 * How much track one mark needs.
 *
 * With the bars gone the lane is no longer a compromise between pixels and volume — every stop is
 * a real step, so the only question left is how far apart two marks have to be to read as two. The
 * widest is the commit: a 5 px square turned 45°, so 7.07 px across. Eight gives it a pixel of air.
 *
 * This is a floor on the DISTANCE between marks, and it has to be enforced as one. It was enforced
 * as a cap on the column *count* — floor(width / 8) columns, one mark each — which bounds how many
 * marks are drawn and says nothing about where they land: a mark sits at its own stop, so two marks
 * either side of a column boundary can be a single stop apart. Measured in the running app on a
 * 828 px track carrying 57 marks, 31 of the 56 gaps were under 8 px, the tightest 2.47 px, and two
 * pairs overlapped outright. The lane is grouped by distance now, which is the property that was
 * being claimed all along.
 */
const MARK_PITCH = 8;

/** The handle past its last stop: following live rather than showing a past step. An ISO timestamp
 * never starts with a letter, so this cannot be mistaken for one. */
const LIVE = 'live';

type Stop = { ts: string; seq: number };

/**
 * The last stop at or before a moment, or -1 for a moment before the first one.
 *
 * A binary search rather than a lookup, because the moments this is asked about need not be stops.
 * A check's `at` is an event timestamp and a verification can be recorded without logging a change
 * — `recordVerification(..., changed = false)` when an exit code upgrades an outcome to what it
 * already was — while a commit always logs one. `scrubTs` likewise arrives from the history rail,
 * from the keyboard, and from a scrub taken while `changes` still held the 400-row snapshot.
 *
 * Compared as strings: adapter timestamps are expected to be canonical ISO with milliseconds and
 * a `Z`, so string order is time order. Timestamp validation remains an ingestion limitation.
 */
function stopAt(stops: Stop[], ts: string): number {
  let lo = 0;
  let hi = stops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const s = stops[mid];
    if (s !== undefined && s.ts <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Where a fraction of the axis lands.
 *
 * The thumb is 16 px wide and `box-sizing: border-box` is global, so its centre travels from 8 px
 * to `width - 8 px` rather than from 0 to the full width. The marks and the stem positioned by raw
 * percentage of the track, which put them up to 8 px from the handle meant to be landing on them —
 * about half a stop on a 62-stop session at 860 px. It did not matter while the marks were
 * decoration; it does the moment the handle is claimed to land on one.
 */
/**
 * The knob's own width. It is a border-box circle, so its centre stops half a width in from each
 * end and everything drawn against the handle travels `width - THUMB` rather than the full track.
 */
const THUMB = 16;

const pos = (f: number, offsetPx = 0) =>
  `calc(${THUMB / 2 + offsetPx}px + (100% - ${THUMB}px) * ${f})`;

export function Timeline({
  startedAt,
  endedAt,
  changes,
  checks,
  commits,
  scrubTs,
  onScrub,
  onLive,
}: {
  startedAt: string | undefined;
  endedAt: string | undefined;
  /**
   * The caller's shared clock. The axis no longer reads it — it read it only because `span` was
   * what the chart was made of — but the prop stays until the call site drops it.
   */
  now: number;
  changes: SemanticChange[];
  checks: VerificationRow[];
  commits: CommitRow[];
  scrubTs: string | undefined;
  onScrub: (ts: string, seq: number) => void;
  onLive: () => void;
}) {
  /**
   * Where the handle is while a drag is in flight, held as the timestamp it is over rather than as
   * an index. `changes` is replaced wholesale a moment after a session opens — the snapshot brings
   * 400 rows and the full log lands behind it — and an index taken before that swap names a
   * different event after it.
   */
  const [dragAt, setDragAt] = useState<string | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  /**
   * The track's real width decides how many mark columns fit, so a mark is the same size at every
   * window size.
   *
   * Measured on mount and then observed, rather than left to the observer alone. A scripted pane
   * may not paint immediately, so the initial observer callback can arrive later than the first
   * render that needs a width.
   *
   * So the observer is sound and the layout effect is still worth keeping: it makes the mount-time
   * answer independent of when the first frame lands, which is one synchronous measure.
   */
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) =>
      setWidth(entry?.contentRect.width ?? el.getBoundingClientRect().width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * The axis. One stop per distinct timestamp, not one per change row, because `stateAtTime`
   * replays every event with `e.ts <= ts`: the timestamp alone decides the state, so two rows
   * sharing one would be two positions showing the same thing.
   *
   * `seq` is the running maximum rather than the row's own, because the store's order is by
   * timestamp and `seq` is not monotone within it. Handing `onScrub` the row's own number could
   * send a sequence behind state the reader can already see.
   *
   * `changes.length` is in the dependencies beside `changes` because the store pushes into that
   * array in place (`appStore.applyEvents`), so its identity never changes and a memo keyed on it
   * alone would never see a new event. The chart this replaces got away with that by accident: it
   * depended on `span`, which moved every time the shared clock ticked.
   */
  const stops = useMemo<Stop[]>(() => {
    const out: Stop[] = [];
    let maxSeq = -1;
    for (const c of changes) {
      maxSeq = Math.max(maxSeq, c.seq);
      const last = out[out.length - 1];
      // Sorted by (ts, seq, ordinal) in the store, so rows sharing a timestamp are contiguous and
      // one look back is enough.
      if (last !== undefined && last.ts === c.ts) last.seq = maxSeq;
      else out.push({ ts: c.ts, seq: maxSeq });
    }
    return out;
  }, [changes, changes.length]);

  /**
   * Checks and commits gathered so that no two marks are drawn closer than `MARK_PITCH`. Dense
   * sessions can otherwise render many marks directly on top of one another. A group carries the
   * worst outcome in it, because a failure
   * hidden under a pass is the one mistake this app may not make.
   *
   * Grouped by walking the stops in order and opening a new group only once one is far enough from
   * the group it would otherwise join. Measured against its *anchor* rather than its last member,
   * so a long run of marks a few pixels apart cannot chain into one group spanning the track.
   *
   * A group is drawn at its anchor, which is a real stop, rather than at a column's centre, so
   * dragging the handle onto a mark still lands on the step that mark belongs to.
   */
  const marks = useMemo(() => {
    type Slot = { fail: boolean; pass: boolean; commit: boolean; n: number };
    const byStop = new Map<number, Slot>();
    const put = (at: string, kind: 'fail' | 'pass' | 'commit') => {
      const i = stopAt(stops, at);
      if (i < 0) return;
      const slot = byStop.get(i) ?? { fail: false, pass: false, commit: false, n: 0 };
      slot[kind] = true;
      slot.n += 1;
      byStop.set(i, slot);
    };
    for (const c of checks) {
      if (c.outcome === 'pass') put(c.at, 'pass');
      else if (c.outcome === 'fail') put(c.at, 'fail');
    }
    for (const c of commits) put(c.at, 'commit');

    /*
     * How many stops `MARK_PITCH` is worth, in the frame the marks are actually positioned in: the
     * thumb's, which travels `width - THUMB` because a 16 px border-box knob stops 8 px in at each
     * end. Before the first layout the width is 0 and nothing is merged; the observer re-runs this
     * on the frame that gives it one.
     */
    const travel = Math.max(0, width - THUMB);
    const perStop = travel > 0 && stops.length > 0 ? travel / stops.length : 0;
    const minStops = perStop > 0 ? Math.max(1, Math.ceil(MARK_PITCH / perStop)) : 1;

    const out: Array<{ at: number; fail: boolean; pass: boolean; commit: boolean; n: number }> = [];
    for (const i of [...byStop.keys()].sort((a, b) => a - b)) {
      const slot = byStop.get(i) as Slot;
      const open = out[out.length - 1];
      if (open && i - open.at < minStops) {
        open.fail ||= slot.fail;
        open.pass ||= slot.pass;
        open.commit ||= slot.commit;
        open.n += slot.n;
        continue;
      }
      out.push({ at: i, ...slot });
    }
    return out.map((g) => ({
      at: g.at,
      f: g.at / stops.length,
      tone: g.fail ? 'fail' : g.pass ? 'pass' : 'commit',
      n: g.n,
    }));
  }, [checks, commits, stops, width]);

  // Nothing has happened yet, so there is nothing to scrub through and no axis to draw.
  if (stops.length === 0) return null;

  /** A drag in flight wins over the scrub it is about to replace; neither means live. */
  const shown = dragAt ?? scrubTs;
  const value =
    shown === undefined || shown === LIVE ? stops.length : Math.max(0, stopAt(stops, shown));
  const atTs = stops[value]?.ts;
  const f = value / stops.length;

  /** Scrubbing hits the daemon, so the handle moves at once and the replay follows it. */
  const move = (v: number) => {
    // Undefined exactly at `v === stops.length`, which is the live end of the travel.
    const target = stops[v];
    setDragAt(target ? target.ts : LIVE);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      /*
       * Dropped as the scrub lands, not only at the live end, where it used to be dropped. Both
       * `onScrub` and `onLive` write the store synchronously, so `shown` falls through to the same
       * timestamp in the same render and the handle does not move; keeping it would freeze the
       * handle against a later scrub arriving from the history rail.
       */
      setDragAt(undefined);
      if (!target) onLive();
      else onScrub(target.ts, target.seq);
    }, 90);
  };

  return (
    <section className="timeline" aria-label="Session timeline">
      <div className="tl-track" ref={trackRef}>
        <div className="tl-marks" aria-hidden="true">
          {marks.map((m) => (
            <span
              key={m.at}
              className={`tl-mark tl-${m.tone}`}
              style={{ left: pos(m.f) }}
              title={`${m.n} ${m.n === 1 ? 'event' : 'events'} here`}
            />
          ))}
        </div>
        {value < stops.length && (
          <div className="tl-future" style={{ left: pos(f) }} aria-hidden="true" />
        )}
        {/* The stem under the knob, so the handle reads as a position on the track. */}
        <div className="tl-stem" style={{ left: pos(f, -1) }} aria-hidden="true" />
        <input
          className="tl-range"
          type="range"
          min={0}
          max={stops.length}
          step={1}
          value={value}
          onChange={(e) => move(Number(e.target.value))}
          aria-label="Show the session as it stood at a moment in time"
          aria-valuetext={
            atTs === undefined
              ? // Mirrors the legend rather than restating it: at the live end a session that has
                // ended is showing the whole of itself, not following anything, and the two
                // renderings of one state may not disagree about which.
                endedAt
                ? 'the whole session'
                : 'now, following live'
              : `${timeOfDay(atTs)}, change ${value + 1} of ${stops.length}, later events hidden`
          }
        />
      </div>
      <div className="tl-legend">
        {/*
         * The clock, at the ends where the axis no longer carries it. The left label is the
         * session start, which is the stable boundary even when the first step arrives later.
         */}
        <span className="mono">{timeOfDay(startedAt)}</span>
        <span className="tl-legend-mid">
          {value >= stops.length ? (
            endedAt ? (
              'whole session'
            ) : (
              'following live'
            )
          ) : (
            <>
              showing <strong className="mono">{timeOfDay(atTs)}</strong>
              <button type="button" className="link" onClick={() => move(stops.length)}>
                back to now
              </button>
            </>
          )}
        </span>
        <span className="mono">{endedAt ? timeOfDay(endedAt) : 'now'}</span>
      </div>
    </section>
  );
}

/**
 * What the track draws, asked for rather than printed under it.
 *
 * Equal distance along the axis is equal work and not equal time, and a reader who assumes the
 * clock reads every gap wrong, so it does have to be sayable. It does not have to be said every
 * time: it was two permanent lines of small grey type under a control that is already a strip of
 * marks and a knob, which is the same trade the session list refused when it moved its own key
 * behind a question mark rather than pay a row and a half of the list for it forever.
 *
 * It sits at the right of the card against the close button at the left, so the two pieces of
 * chrome balance rather than crowd one end. Both are iconic, because chrome is.
 */
export function TimelineKey() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="pop" ref={ref}>
      <button
        type="button"
        className={`btn btn-float ${open ? 'is-on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="What the track shows"
      >
        <Icon name="help" />
        <span className="sr-only">What the track shows</span>
      </button>
      {open && (
        <div className="pop-panel is-narrow is-up">
          <div className="pop-head">
            <span>On the track</span>
          </div>
          <p className="pop-note">
            One step per change, not per minute. The clock is in the two end labels and in the
            readout while you drag.
          </p>
          <p className="pop-note">
            A mark is a check or a commit, red where a check failed. Marks too close to draw apart
            are merged, and a merged mark takes the worst outcome in it.
          </p>
        </div>
      )}
    </div>
  );
}
