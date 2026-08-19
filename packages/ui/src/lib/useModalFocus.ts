import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const modalStack: symbol[] = [];

function focusableChildren(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    return element.getClientRects().length > 0;
  });
}

/**
 * Complete keyboard containment for a modal surface.
 *
 * The stack matters when the source-record drawer is opened from another panel: only the topmost
 * modal handles Escape, Tab, or an escaped programmatic focus. Closing it restores the trigger in
 * the panel beneath it, which then resumes containment.
 */
export function useModalFocus({
  active,
  containerRef,
  onClose,
  initialFocus,
  restoreFocus,
  shouldRestoreFocus,
}: {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  initialFocus?: (root: HTMLElement) => HTMLElement | null;
  restoreFocus?: () => HTMLElement | null;
  /** Responsive surfaces can deactivate while remaining open; those transitions return false. */
  shouldRestoreFocus?: () => boolean;
}): void {
  const activeRef = useRef(active);
  const closeRef = useRef(onClose);
  const initialRef = useRef(initialFocus);
  const restoreRef = useRef(restoreFocus);
  const shouldRestoreRef = useRef(shouldRestoreFocus);
  const pointerTriggerRef = useRef<HTMLElement | null>(null);
  activeRef.current = active;
  closeRef.current = onClose;
  initialRef.current = initialFocus;
  restoreRef.current = restoreFocus;
  shouldRestoreRef.current = shouldRestoreFocus;

  // Safari deliberately does not focus a button when it is clicked with a pointer. Remember the
  // actual opener before React mounts the modal so focus restoration is deterministic there too;
  // keyboard activation still uses document.activeElement below.
  useEffect(() => {
    if (active) return;
    const remember = (event: PointerEvent) => {
      const target =
        event.target instanceof Element ? event.target.closest<HTMLElement>(FOCUSABLE) : null;
      if (target) pointerTriggerRef.current = target;
    };
    document.addEventListener('pointerdown', remember, true);
    return () => document.removeEventListener('pointerdown', remember, true);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const root = containerRef.current;
    if (!root) return;

    const token = Symbol('modal');
    const pointerTrigger = pointerTriggerRef.current;
    pointerTriggerRef.current = null;
    const prior =
      pointerTrigger?.isConnected === true
        ? pointerTrigger
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    modalStack.push(token);

    const preferred = () => initialRef.current?.(root) ?? focusableChildren(root)[0] ?? root;
    const frame = requestAnimationFrame(() => preferred().focus());

    const onKey = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== token) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = focusableChildren(root);
      const first = focusables[0];
      const last = focusables.at(-1);
      if (!first || !last) {
        event.preventDefault();
        root.focus();
        return;
      }

      const focused = document.activeElement;
      if (!(focused instanceof Node) || !root.contains(focused)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (focused === first || focused === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && focused === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocus = (event: FocusEvent) => {
      if (modalStack.at(-1) !== token || root.contains(event.target as Node)) return;
      preferred().focus();
    };

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus, true);
      const index = modalStack.lastIndexOf(token);
      if (index >= 0) modalStack.splice(index, 1);

      // A responsive surface can stop being modal while remaining open. That transition should
      // not move focus; restoration belongs only to an actual close/unmount.
      if (activeRef.current || shouldRestoreRef.current?.() === false) return;
      requestAnimationFrame(() => {
        const target = restoreRef.current?.() ?? prior;
        if (target?.isConnected) target.focus();
      });
    };
  }, [active, containerRef]);
}
