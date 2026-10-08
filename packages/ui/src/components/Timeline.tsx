import type { CommitRow, TurnRow, VerificationRow } from '@salidium/core';
import type { SemanticChange } from '@salidium/protocol';
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { timeOfDay } from '../lib/format.ts';
import { Icon } from './Icon.tsx';
import { timelineBadges, turnPalette } from './timelineAppearance.ts';
import { stopAt, timelineSegments, timelineStops } from './timelineStops.ts';

/**
 * The shape of the session, and the control for moving through it — one object, because they are
 * the same thing. The track is one step per moment something changed; marks show the steps that
 * decide whether to trust it (checks passing or failing, commits). Dragging the handle replays the
 * whole view as it stood at that step.
 *
 * The track used to span wall-clock time, which spent much of its width drawing gaps between bursts
 * of work and offered many handle positions that replayed the same state. One stop per moment
 * makes every position a state that exists. Only the selected historical timestamp is printed beside the track.
 *
 * The handle is a real range input rather than a div with mouse handlers, so it arrows, tabs and
 * announces itself without a pile of ARIA; the drawing behind it is decoration and is hidden from
 * assistive tech, which reads the value text instead.
 */

/** The handle past its last stop: following live rather than showing a past step. An ISO timestamp
 * never starts with a letter, so this cannot be mistaken for one. */
const LIVE = 'live';

/** The native thumb travels half its width inside each end of the track. */
const THUMB = 16;

const pos = (f: number, offsetPx = 0) =>
  `calc(${THUMB / 2 + offsetPx}px + (100% - ${THUMB}px) * ${f})`;

export function Timeline({
  endedAt,
  changes,
  checks,
  commits,
  turns,
  scrubTs,
  onScrub,
  onLive,
}: {
  endedAt: string | undefined;
  changes: SemanticChange[];
  checks: VerificationRow[];
  commits: CommitRow[];
  turns: TurnRow[];
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
  // History can select a moment while this input still has a debounced drag waiting. The external
  // selection wins; otherwise that old drag would overwrite the history click 90 ms later.
  useLayoutEffect(() => {
    void scrubTs;
    clearTimeout(timer.current);
    setDragAt(undefined);
  }, [scrubTs]);

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
  const [track, setTrack] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = track;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) =>
      setWidth(entry?.contentRect.width ?? el.getBoundingClientRect().width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [track]);

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
  const stops = useMemo(() => timelineStops(changes), [changes, changes.length]);
  const hasStops = stops.length > 0;
  const segments = useMemo(() => timelineSegments(turns, stops), [turns, stops]);
  const segmentStrip = useRef<HTMLDivElement>(null);
  const shown = dragAt ?? scrubTs;
  const selectedSegment =
    shown === undefined || shown === LIVE
      ? LIVE
      : segments.find(
          (segment) =>
            shown >= segment.startedAt && (segment.nextAt === undefined || shown < segment.nextAt),
        )?.id;

  useLayoutEffect(() => {
    // Scroll only this strip. scrollIntoView also scrolls the report and can move the document
    // away from what the reader was inspecting each time they press an arrow on the range.
    if (segments.length === 0 || !hasStops) return;
    void shown;
    void width; // Keep the selection visible when the pane narrows or an inspector opens.
    const strip = segmentStrip.current;
    const selected = strip?.querySelector<HTMLElement>('.tl-playhead');
    if (!strip || !selected) return;
    const viewport = strip.getBoundingClientRect();
    const button = selected.getBoundingClientRect();
    if (button.left < viewport.left) strip.scrollLeft += button.left - viewport.left;
    else if (button.right > viewport.right) strip.scrollLeft += button.right - viewport.right;
  }, [shown, segments.length, hasStops, width]);

  useLayoutEffect(() => {
    const strip = segmentStrip.current;
    if (!strip) return;
    void segments.length;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const edges = () => {
      const left = strip.scrollLeft > 1;
      const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
      strip.dataset.fade = left && right ? 'both' : left ? 'left' : right ? 'right' : 'none';
    };
    const scroll = () => {
      edges();
      strip.dataset.scrolling = 'true';
      clearTimeout(idle);
      idle = setTimeout(() => {
        delete strip.dataset.scrolling;
      }, 900);
    };
    const observer = new ResizeObserver(edges);
    observer.observe(strip);
    for (const child of strip.children) observer.observe(child);
    strip.addEventListener('scroll', scroll, { passive: true });
    edges();
    return () => {
      clearTimeout(idle);
      observer.disconnect();
      strip.removeEventListener('scroll', scroll);
    };
  }, [segments.length]);

  const badges = useMemo(
    () => timelineBadges(turns, checks, commits, stops, width, THUMB),
    [turns, checks, commits, stops, width],
  );
  const bands = segments
    .filter((segment) => segment.target !== undefined)
    .map((segment, i, available) => {
      const start = segment.target as number;
      const end = available[i + 1]?.target ?? stops.length;
      return { ...segment, start, end, palette: turnPalette(segment.id) };
    });

  /** A drag in flight wins over the scrub it is about to replace; neither means live. */
  const value =
    shown === undefined || shown === LIVE ? stops.length : Math.max(0, stopAt(stops, shown));
  const atTs = stops[value]?.ts;
  const f = hasStops ? value / stops.length : 1;
  const following = value === stops.length;

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
      <div className="tl-navigation">
        <div className="tl-segments" ref={segmentStrip}>
          <div
            className="tl-track"
            ref={setTrack}
            style={{ minWidth: Math.max(320, bands.length * 100) }}
          >
            <div
              className="tl-bands"
              aria-hidden="true"
              style={
                {
                  '--lead-width': `calc((100% - ${THUMB}px) * ${hasStops ? (bands[0]?.start ?? stops.length) / stops.length : 1} - 6px)`,
                } as CSSProperties
              }
            >
              {bands.map((band) => (
                <span
                  key={band.id}
                  className="tl-band"
                  data-palette={band.palette}
                  style={{
                    left: pos(band.start / stops.length),
                    width: `max(1px, calc((100% - ${THUMB}px) * ${(band.end - band.start) / stops.length} - 6px))`,
                  }}
                />
              ))}
            </div>
            {/* biome-ignore lint/a11y/useSemanticElements: these buttons navigate recorded turns. */}
            <div role="group" aria-label="Recorded turns">
              {bands.map((band) => (
                <button
                  key={band.id}
                  type="button"
                  className={`btn tl-segment ${selectedSegment === band.id ? 'is-on' : ''}`}
                  style={{
                    left: pos(band.start / stops.length),
                    width: `calc((100% - ${THUMB}px) * ${(band.end - band.start) / stops.length} - 6px)`,
                  }}
                  aria-pressed={selectedSegment === band.id}
                  aria-label={`Turn ${band.index + 1}: ${band.title}`}
                  title={`Turn ${band.index + 1}: ${band.title}`}
                  onClick={() => move(band.start)}
                >
                  <span className="tl-segment-number mono" aria-hidden="true">
                    {String(band.index + 1).padStart(2, '0')}
                  </span>
                  <span className="tl-segment-title">{band.title}</span>
                </button>
              ))}
            </div>
            {hasStops ? (
              <>
                <input
                  className="tl-range"
                  type="range"
                  min={0}
                  max={stops.length}
                  step={1}
                  value={value}
                  onChange={(e) => move(Number(e.target.value))}
                  aria-label="Show the session as it stood at a moment in time"
                  aria-describedby="rewind-track-description"
                  aria-valuetext={
                    atTs === undefined
                      ? endedAt
                        ? 'the whole session'
                        : 'now, following live'
                      : `${timeOfDay(atTs)}, moment ${value + 1} of ${stops.length}, later events hidden`
                  }
                />
                {badges.map((badge) => (
                  <button
                    key={badge.index}
                    type="button"
                    className="btn btn-marker tl-badge"
                    data-palette={badge.palette}
                    data-tone={badge.tone}
                    style={{ left: pos(badge.f) }}
                    title={badge.label}
                    aria-label={badge.label}
                    onClick={() => move(badge.target)}
                  >
                    <Icon name={badge.icon} />
                    {badge.count > 1 && (
                      <span className="btn-marker-count" aria-hidden="true">
                        {badge.count > 99 ? '99+' : badge.count}
                      </span>
                    )}
                  </button>
                ))}
                <span className="tl-playhead" style={{ left: pos(f) }} aria-hidden="true" />
              </>
            ) : (
              <span className="tl-empty">No recorded changes yet</span>
            )}
          </div>
        </div>
        <div className="tl-end">
          <button
            type="button"
            className={`btn tl-now ${following ? 'is-on' : ''}`}
            aria-pressed={following}
            disabled={!hasStops}
            onClick={() => move(stops.length)}
          >
            <Icon name="latest" />
            {endedAt ? 'Whole session' : 'Now'}
          </button>
          <time className="tl-readout mono" dateTime={atTs}>
            {following ? '' : timeOfDay(atTs)}
          </time>
        </div>
      </div>
      <p id="rewind-track-description" className="sr-only">
        Colored sections are recorded turns. Icons show recorded activity, passing checks, failed
        checks, and commits. A numbered badge groups nearby events; its label summarizes them and
        failures take priority. Step through recorded changes with the arrow keys, Home for the
        first and End for the whole session.
      </p>
    </section>
  );
}
