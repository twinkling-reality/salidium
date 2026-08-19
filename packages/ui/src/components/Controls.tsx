import { useEffect, useRef, useState } from 'react';
import { type Detail, type Theme, useAppStore } from '../store/appStore.ts';
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
 * How deep the page goes. Three levels, each named for the section it reveals, so the name on the
 * control is the heading you will find on the page.
 *
 * A slider was the wrong instrument and had to go. A slider says "a scale with a cost at each end"
 * — Faster against Smarter — and it is read that way whether or not one exists. These levels are
 * not a trade: each one keeps everything the one before it showed and adds to it, so there is no
 * end to move away from, and labelling the extremes implied a pro and a con that a reader then
 * went looking for and could not find. A list of the actual choices, each saying what it adds,
 * makes the same decision without inventing an axis.
 */
/*
 * Named for what a reader wants, not for how Salidium classifies it. "Observed" and "Records" are
 * this codebase's provenance vocabulary — the epistemic classes every derived object carries — and
 * they were lifted straight onto the two headings a user reads first. Nobody arrives at a session
 * asking to see the observed. They ask whether it worked, and then they ask to be shown.
 */
const LEVELS: Array<{ name: string; adds: string }> = [
  { name: 'Explanation', adds: 'What the session was about, as a diagram.' },
  {
    name: 'Where it stands',
    adds: 'Adds whether the checks passed, what is left, and what needs you.',
  },
  {
    name: 'Evidence',
    adds: 'Adds the proof: coverage, checks over time, what changed, and what happened when.',
  },
];

export function DetailControl() {
  const detail = useAppStore((s) => s.detail);
  const setDetail = useAppStore((s) => s.setDetail);
  const [open, setOpen] = useState(false);
  const [explain, setExplain] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const level = LEVELS[detail] as (typeof LEVELS)[number];
  return (
    <div className="pop" ref={ref}>
      <button
        type="button"
        className={`btn ${open ? 'is-on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="How much of the page is shown"
      >
        <Icon name="sliders" />
        {/*
         * The icon carries the word "Detail" and the pill carries the level. Both are load-bearing:
         * an icon-only control leaves no way to tell how much of the page is currently there, which
         * is the one thing this control exists to report, and a level with no icon beside it is a
         * bare word in a row of controls.
         *
         * Printing the level here is only legible because the control no longer sits in the section
         * links: the level names are the section names by design, so beside the links the pill read
         * as a second, malformed copy of the link next to it.
         */}
        <span className="btn-pill">{level.name}</span>
      </button>
      {open && (
        <div className="pop-panel">
          <div className="pop-head">
            <span>Detail</span>
            <button
              type="button"
              className={`pop-help ${explain ? 'is-on' : ''}`}
              onClick={() => setExplain((e) => !e)}
              aria-expanded={explain}
              title="What this control does"
            >
              <span aria-hidden="true">?</span>
              <span className="sr-only">What this control does</span>
            </button>
          </div>
          {explain && (
            <p className="pop-note">
              Each level keeps everything the one above it shows and adds more of the page. Nothing
              is traded away by going deeper — it is only longer.
            </p>
          )}
          {/* Real radios in a real fieldset: arrow-key navigation, grouping and announcement all
              come from the platform, and none of it has to be reimplemented in ARIA. */}
          <fieldset className="opts">
            <legend className="sr-only">Detail</legend>
            {LEVELS.map((l, i) => (
              <label className={`opt ${i === detail ? 'is-on' : ''}`} key={l.name}>
                <input
                  className="sr-only"
                  type="radio"
                  name="salidium-detail"
                  checked={i === detail}
                  onChange={() => {
                    setDetail(i as Detail);
                    setOpen(false);
                  }}
                />
                <span className="opt-mark" aria-hidden="true" />
                <span className="opt-text">
                  <span className="opt-name">{l.name}</span>
                  <span className="opt-adds">{l.adds}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </div>
  );
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
