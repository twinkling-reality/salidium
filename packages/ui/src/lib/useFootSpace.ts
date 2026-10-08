import { useLayoutEffect, useState } from 'react';

/**
 * Publish the tray's measured height to its pane. The foreground surface reserves this space
 * while Rewind is open. Callback refs also handle a session that mounts after its snapshot loads.
 * Observe the untransformed foot, not its animated contents, to avoid animation feedback.
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
