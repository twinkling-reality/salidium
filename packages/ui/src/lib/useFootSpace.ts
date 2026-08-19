import { useLayoutEffect, useState } from 'react';

/**
 * How much room the pane's floating foot is taking, published to the pane as `--foot-space` so the
 * document can reserve exactly that much beneath itself and no more.
 *
 * It is measured because there is no number to write down: the scrubber is whatever its track,
 * labels and legend come to at the current width. The fixed reservation this replaced was too
 * small at some widths and too large at others.
 *
 * CSS cannot do it: the foot is out of flow, and a custom property set on it would only reach its
 * own descendants, never the scroller beside it. So the pane is written to directly rather than
 * held in state — the value is only ever read by the stylesheet, and a window drag that re-rendered
 * the whole session page on every frame to move a padding would be a poor trade.
 *
 * The two elements arrive as callback refs rather than `useRef`, because they arrive late. The
 * session page renders a placeholder until its snapshot lands, so on the first pass there is no
 * pane and no foot to measure; with `useRef` the effect ran once against two nulls, and — nothing
 * it depended on having changed — never ran again. Reloaded with the scrubber remembered, the page
 * came up with the foot drawn, `--foot-space` unset and the end of the document behind it. As a
 * callback ref the node itself is the dependency,
 * so the measurement happens when there is something to measure.
 *
 * Measured in a layout effect and then observed, for the reason `Timeline` gives: the mount-time
 * answer has to be right on the frame it mounts rather than whenever the first frame is painted.
 */
export function useFootSpace<P extends HTMLElement, F extends HTMLElement>(
  contents: string,
): [(node: P | null) => void, (node: F | null) => void] {
  const [pane, setPane] = useState<P | null>(null);
  const [foot, setFoot] = useState<F | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `contents` is not read in the effect; it is the signal that the foot's contents changed and it has to be measured again.
  useLayoutEffect(() => {
    if (!pane || !foot) return;
    // The border box, not the observer's content box: the clearance to the window's edge is the
    // foot's own padding, and it is part of the space the page has to keep clear.
    const write = () =>
      pane.style.setProperty('--foot-space', `${foot.getBoundingClientRect().height}px`);
    write();
    const ro = new ResizeObserver(write);
    ro.observe(foot);
    return () => ro.disconnect();
  }, [pane, foot, contents]);
  return [setPane, setFoot];
}
