import { useState } from 'react';

/**
 * Whether a surface that leaves with motion should be in the document at all yet.
 *
 * A surface cannot animate away after React has deleted it, so anything using `.arrives`
 * (`scale.css`) has to still be there while it leaves. Rendering every such surface always is the
 * simple answer and the wrong one here: a session carries four panels, each of them a column of
 * the report, so a reader looking at none of them would have four reports in the document.
 *
 * It is rendered from the first time it opens and never removed again. Nothing costs anything
 * until it is asked for, and once it has been asked for it can always see itself out.
 *
 * The `open` case is returned alongside so the first open still renders on the frame it is asked
 * for rather than one frame later; `@starting-style` supplies that frame's opening state either
 * way, so the entrance is the same whether it is the first or the fifth.
 */
export function useStaysMounted(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}
