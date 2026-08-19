import type { RefCallback } from 'react';
import { useCallback } from 'react';

/**
 * Marks a scroll container with the two things its chrome needs to know: which of its edges has
 * content beyond it (`data-fade`), and whether it is being scrolled right now (`data-scrolling`).
 *
 * The alternative — a permanent fade at both ends — lies twice: it dims the first row of a list
 * that is already at its top, and it keeps dimming the last row after you have reached the bottom,
 * which reads as content still being hidden. `data-fade` is `none | top | bottom | both`, and the
 * mask in `primitives.css` is keyed to it.
 *
 * A callback ref that returns its own cleanup, for two reasons. Two of the three panes render a
 * placeholder on their first commit — the session list while sessions load, the session view while
 * its snapshot arrives — so an effect with an empty dependency list would run once against a
 * `null` element and never get another chance. And tearing down in a `useEffect` cleanup instead
 * breaks under StrictMode's double-invoke: the cleanup removes the listeners while the ref is
 * still attached, and nothing ever reattaches them. Ref cleanup is tied to the node's lifetime,
 * which is the thing that actually governs here.
 *
 * Scrollbars are drawn only while scrolling, the way the platform's own overlay scrollbars behave.
 * Styling `::-webkit-scrollbar` opts out of those overlays and pins the bar on screen permanently,
 * which is a stripe of chrome down the side of every pane at rest; this puts the behaviour back.
 *
 * Both the element and its content are watched: a virtualized list changes height without the
 * scroller resizing, and a pane can reach its own bottom because the content shrank rather than
 * because anyone scrolled.
 */
/** How long after the last scroll event the bar fades away again. */
const REST_MS = 900;

export function useScrollState<T extends HTMLElement>(): RefCallback<T> {
  return useCallback<RefCallback<T>>((el) => {
    if (!el) return;
    let frame = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      frame = 0;
      // A pixel of slack: sub-pixel layout leaves a fractional remainder at a true edge.
      const above = el.scrollTop > 1;
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      el.dataset.fade = above && below ? 'both' : above ? 'top' : below ? 'bottom' : 'none';
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const onScroll = () => {
      el.dataset.scrolling = 'true';
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        delete el.dataset.scrolling;
      }, REST_MS);
      schedule();
    };
    apply();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (idle) clearTimeout(idle);
    };
  }, []);
}
