/**
 * The icon set. Inline SVG on a 16-unit grid, stroked with `currentColor` so an icon takes the
 * colour of whatever control holds it, and sized once by `.ico` in `primitives.css` so no caller
 * picks its own dimensions.
 *
 * Drawn rather than typed: the app loads no webfonts, and the glyphs that would stand in for these
 * (◐ ☾ ⟨) render at wildly different weights and baselines across the system stack, which is what
 * made the old toolbar look like a row of unrelated marks.
 */

export type IconName =
  | 'panel'
  | 'history'
  | 'sliders'
  | 'sun'
  | 'moon'
  | 'auto'
  | 'flag'
  | 'latest'
  | 'record'
  | 'stats'
  | 'filter'
  | 'search'
  | 'help'
  | 'reset'
  | 'table'
  | 'close'
  | 'prev'
  | 'next'
  | 'save'
  | 'copy'
  | 'check'
  | 'outbound';

const PATHS: Record<IconName, React.ReactNode> = {
  /* One sheet laid over another: take this text. */
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" />
      <path d="M10.5 2.5H4.2A1.7 1.7 0 0 0 2.5 4.2v6.3" />
    </>
  ),
  /* The same control a moment after it worked. */
  check: <path d="M3 8.4l3.4 3.2L13 4.8" />,
  /* A page with its side panel: the control that folds the session list. */
  panel: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M6.5 3v10" />
    </>
  ),
  history: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2 1.4" />
    </>
  ),
  sliders: (
    <>
      <path d="M2 5h8M12.5 5H14M2 11h2.5M7 11h7" />
      <circle cx="11" cy="5" r="1.5" />
      <circle cx="5.5" cy="11" r="1.5" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.2M8 13.3v1.2M2.4 2.4l.9.9M12.7 12.7l.9.9M1.5 8h1.2M13.3 8h1.2M2.4 13.6l.9-.9M12.7 3.3l.9-.9" />
    </>
  ),
  moon: <path d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6Z" />,
  /* Half light, half dark: following the system. */
  auto: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" stroke="none" />
    </>
  ),
  /* Skip to the end: leave a past moment and return to the session as it stands now. */
  latest: (
    <>
      <path d="M3 3.5 8 8l-5 4.5" />
      <path d="M12.5 3v10" />
    </>
  ),
  /* The raw record a claim was read from: a document with lines of text. */
  record: (
    <>
      <path d="M3.5 2.5h6L12.5 5.5v8h-9Z" />
      <path d="M5.5 7.5h5M5.5 10h3.5" />
    </>
  ),
  /* A funnel: which kinds of change get through. */
  filter: <path d="M2 3.5h12l-4.6 5.2v4.1l-2.8 1.7V8.7Z" />,
  /* What the marks mean. The only glyph here that stands for a question rather than an action. */
  help: (
    <>
      <path d="M5.9 6.2a2.2 2.2 0 1 1 2.9 2.1c-.6.2-1 .7-1 1.3v.4" />
      <path d="M7.8 12.4h.4" />
    </>
  ),
  /* A lens over a list: find the one you are after. Not the funnel — that one chooses kinds. */
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.2" />
      <path d="M10.3 10.3 13.5 13.5" />
    </>
  ),
  /* Back to everything. */
  reset: (
    <>
      <path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9" />
      <path d="M2.3 3.2v3.1h3.1" />
    </>
  ),
  /* The change log as rows and columns, in the middle of the screen. */
  table: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12M6.5 6.5v6.5" />
    </>
  ),
  /* The quantities, behind their own toggle. */
  stats: (
    <>
      <path d="M2.5 13.5h11" />
      <path d="M4.5 11V7M8 11V3.5M11.5 11V8.5" />
    </>
  ),
  /*
   * A box with a corner open and an arrow leaving through it: this one goes somewhere else.
   *
   * Not the page glyph `record` already draws. What separates the documentation from every other
   * control in the row is not that it is a document, it is that pressing it leaves the
   * application, and that is the thing the mark has to say.
   */
  outbound: (
    <>
      <path d="M8 3.5H3.5v9h9V8" />
      <path d="M10 2.5h3.5V6" />
      <path d="M13.5 2.5 8.5 7.5" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  /* One step back and one step on, through the log in the order it was stored. */
  prev: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  next: <path d="M6 3.5 10.5 8 6 12.5" />,
  /* Down onto a shelf: take this record away as a file. */
  save: (
    <>
      <path d="M8 2.5v7.5" />
      <path d="M4.8 7.2 8 10.4l3.2-3.2" />
      <path d="M3 12.5h10" />
    </>
  ),
  /* Sits inside the review count, so the number reads as "flagged" rather than as "unread". */
  flag: (
    <>
      <path d="M4 14.5V2.5" />
      <path d="M4 3.2h7.6l-1.6 2.9 1.6 2.9H4" />
    </>
  ),
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
