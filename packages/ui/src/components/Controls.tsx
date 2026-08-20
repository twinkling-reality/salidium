import { useEffect, useRef, useState } from 'react';
import { type Theme, useAppStore } from '../store/appStore.ts';
import { Icon, type IconName } from './Icon.tsx';

/**
 * The toolbar controls. Every one of them is the same box — height, corner and hover come from
 * `.btn` in `primitives.css` — and every one of them carries an icon, so the row reads as a set
 * rather than as three unrelated widgets that happen to sit next to each other.
 */

export function ToolButton({
  icon,
  label,
  value,
  on,
  title,
  onClick,
}: {
  icon: IconName;
  /**
   * Present for anything that opens or hides content, absent for the chrome and the settings.
   *
   * That is the whole rule, and the toolbar broke it in one place: Evidence, Rewind and History
   * named themselves while the quantities bar — which is the same kind of thing, a body of content
   * it shows and hides — was a bar-chart glyph and a tooltip. The list fold and the theme are icons
   * because they act on the window rather than on the session, and because their glyphs are the
   * two everyone already knows.
   */
  label?: string;
  /** Current state the button reports, shown at full strength beside its label. */
  value?: string;
  on?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`btn ${label ? '' : 'btn-icon'} ${on ? 'is-on' : ''}`}
      onClick={onClick}
      aria-pressed={on}
      title={title}
    >
      <Icon name={icon} />
      {label && <span>{label}</span>}
      {value && <span className="btn-value">{value}</span>}
      {!label && <span className="sr-only">{title}</span>}
    </button>
  );
}

/** Closes on Escape and on a pointer landing anywhere outside, which is what a popover owes you. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/**
 * Light, dark, or whatever the system says. One button cycling three states rather than a menu:
 * there are only three, and the icon shows which one you are in.
 */
const THEMES: Array<{ value: Theme; icon: IconName; label: string }> = [
  { value: 'system', icon: 'auto', label: 'Match the system' },
  { value: 'light', icon: 'sun', label: 'Light' },
  { value: 'dark', icon: 'moon', label: 'Dark' },
];

export function ThemeToggle() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const i = Math.max(
    0,
    THEMES.findIndex((t) => t.value === theme),
  );
  const cur = THEMES[i] as (typeof THEMES)[number];
  const next = THEMES[(i + 1) % THEMES.length] as (typeof THEMES)[number];
  return (
    <ToolButton
      icon={cur.icon}
      title={`Theme: ${cur.label}. Switch to ${next.label.toLowerCase()}.`}
      onClick={() => setTheme(next.value)}
    />
  );
}

/**
 * A plain inline expander for a secondary list. Not a section: the page has no sections, and the
 * one place this is used is a list of delegated agents inside Evidence.
 */
export function Disclosure({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="disclosure">
      <button
        type="button"
        className="disclosure-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={`disc-${id}`}
      >
        <span className={`chev ${open ? 'is-open' : ''}`} aria-hidden="true">
          ›
        </span>
        {label}
      </button>
      <div id={`disc-${id}`} hidden={!open}>
        {open && children}
      </div>
    </div>
  );
}

/**
 * Whether Salidium is still receiving events, and nothing else.
 *
 * It printed "live" whenever the stream was open, which is to say on every session including ones
 * that ended days ago — the word read as a claim about the *session*, whose actual state is in the
 * masthead beside its title. A healthy connection is the expected case and says nothing worth a
 * slot on the toolbar, so only the exceptions print.
 *
 * Shared, because the session view and the session list both report this and only one of them was
 * doing it in words: the list printed the connection state's own name, so a reader was shown
 * `closed` with no tooltip and nothing to make of it, four lines of code away from a badge that
 * said "disconnected" and why.
 *
 * The advice is still a `title`, which a touch device never shows. Saying it in text costs a line
 * of the panel head, and the sentence a reader needs once the daemon has actually stopped is on
 * the session error screen, which is where they arrive next.
 */
export function ConnectionBadge({ status }: { status: string }) {
  if (status === 'connecting')
    return (
      <span className="conn conn-warn" title="Opening the connection to the daemon">
        connecting
      </span>
    );
  if (status === 'reconnecting')
    return (
      <span className="conn conn-warn" title="Lost contact with the daemon; retrying">
        reconnecting…
      </span>
    );
  if (status === 'closed')
    return (
      <span className="conn conn-bad" title="Not receiving updates; the daemon may have stopped">
        disconnected
      </span>
    );
  return null;
}
