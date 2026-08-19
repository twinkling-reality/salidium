import { useEffect, useRef, useState } from 'react';

/**
 * Whether an element's content is taller than the box the stylesheet gives it — i.e. whether a
 * line clamp is actually hiding anything right now.
 *
 * Measured rather than guessed from the length of the string, because the same 300 characters are
 * four lines in one column and nine in another, and a "more" control that appears over text with
 * nothing behind it is worse than no control at all. Re-measures on resize, since the columns are
 * fluid and a window drag changes the answer.
 *
 * The measurement is skipped while the caller has the element expanded: an expanded element is not
 * clamped, so it would measure as fitting, the control would vanish, and there would be no way
 * back. Holding the last collapsed answer is what keeps the toggle reversible.
 */
export function useClamped<T extends HTMLElement>(
  expanded: boolean,
  text: string,
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [clamped, setClamped] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is not read in the effect; it is the signal that the content changed and the measurement has to be taken again.
  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight - el.clientHeight > 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, text]);
  return [ref, clamped];
}
