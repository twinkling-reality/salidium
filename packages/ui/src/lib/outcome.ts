/**
 * The mark a check's outcome is drawn as, in one place.
 *
 * There were three copies, and two of them were wrong in the same way: `partial` had no mark and
 * fell through to `?`, which is also `unknown` — so the outcome that means "the output and the exit
 * code disagree" was drawn identically to the one that means "nothing came back". The report's own
 * copy was fixed when that was noticed; the Checks panel and the flow diagram were not, because
 * nothing could see them. No fixture in this repository produced a `partial` outcome, so the two
 * remaining copies had never once been asked to draw one.
 *
 * A shared map is not a tidiness argument here. It is the thing that makes "fixed when noticed"
 * mean fixed everywhere, rather than fixed wherever the person who noticed happened to be reading.
 *
 * The word is not shared, deliberately: the report names a run that has finished ("passed") and the
 * Checks panel names what a kind of check says now ("passing"), and those are different tenses
 * about different things.
 */
const OUTCOME_GLYPH: Record<string, string> = {
  pass: '✓',
  fail: '✕',
  partial: '◐',
  unknown: '?',
};

/** The mark for an outcome, falling back to the one that means nothing was established. */
export function outcomeGlyph(outcome: string): string {
  return OUTCOME_GLYPH[outcome] ?? '?';
}
