/**
 * The one way this app says it is waiting.
 *
 * There were seven, each invented where it was needed: "Loading sessions…" in the side panel,
 * "Loading…" in the record drawer, "running…" on an activity and again on a command row, "—
 * loading…" spliced into the middle of the scrub sentence, "Loading session…" on the whole pane,
 * and one shimmering line under the explanation that was the only one with any craft in it. Seven
 * spellings of one idea is seven chances to look like a different application, and the seventh was
 * only found by grepping for the ellipsis after the other six were done.
 *
 * Drawn rather than imported, for the reason the icon set is: the orb strokes with `currentColor`,
 * so it takes the colour of whatever holds it — muted in the side panel, secondary in a drawer
 * head, the danger tone inside a failure. `thinking-orbs` was the obvious alternative and is a
 * good component (MIT, no dependencies, and it honours `data-theme` before `prefers-color-scheme`,
 * which is exactly this app's own resolution order). It draws to a canvas, though, and a canvas
 * cannot inherit the colour of the sentence it sits in; every caller would have to tell it what it
 * was standing next to, and five of the six places here are a line of text rather than a hero
 * slot. This is 40 lines and takes the colour for free.
 */
export type LoadingSize = 'sm' | 'md';

export function Loading({
  label,
  size = 'sm',
  className = '',
}: {
  /** What is being waited for, in words. A spinner with no sentence is a mystery. */
  label: string;
  size?: LoadingSize;
  className?: string;
}) {
  return (
    <span className={`loading is-${size} ${className}`.trim()} role="status">
      <ThinkingOrb />
      <span className="loading-label shimmer">{label}</span>
    </span>
  );
}

/**
 * Three dots around a centre, each fading on its own offset, so the mark reads as circulation
 * rather than as a spinner going nowhere. On a 16-unit grid like every other mark in the app.
 *
 * Under `prefers-reduced-motion` the animation stops and the three dots hold three different
 * opacities: still legible as "something is in progress", with nothing moving.
 */
function ThinkingOrb() {
  return (
    <svg className="orb" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle className="orb-dot" cx="8" cy="3.2" r="1.9" fill="currentColor" />
      <circle className="orb-dot" cx="12.2" cy="10.4" r="1.9" fill="currentColor" />
      <circle className="orb-dot" cx="3.8" cy="10.4" r="1.9" fill="currentColor" />
    </svg>
  );
}
