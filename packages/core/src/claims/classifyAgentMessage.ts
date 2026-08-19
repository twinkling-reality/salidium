import type { ClaimKind } from '../state/runState.ts';
import { isRenderedFurniture, markdownShape, plainText } from './markdown.ts';

/**
 * What the agent said, classified — with a confidence, and with the right to say "I do not know".
 *
 * The rule this file is built on is the one already stated for exit codes and verifications
 * (architecture.md, Principles 3): **unknown stays unknown**. A classification below the threshold
 * is not asserted anywhere — not under a quieter heading, not in a dimmer style. It is silence.
 * The page may say less than Salidium knows; it may not say something Salidium does not know.
 *
 * What this replaced, and why:
 *
 * - Every rule was "does this word appear anywhere in the sentence", with no threshold and no way
 *   to return nothing. Messages matching no rule were filed as a `status` claim built from their
 *   first line, because the layout had regions and regions must be filled.
 * - `approach` often matched *a trailing colon and nothing else*, presenting consecutive narration
 *   steps as abandoned approaches.
 * - `discovery` could be triggered by a bare negation: any sentence containing "doesn't", "isn't"
 *   or "never".
 * - `verification` could be triggered by a bare `\d+/\d+` anywhere in the text, which caught dates, F1 scores,
 *   file modes `(292/292)`, the token list `--radius-xs/sm/md/lg (4/6/10/16px)`, and five
 *   `visualize{"path":…}` tool artifacts.
 * - `remaining` matched the bare word anywhere in prose, turning descriptions into tasks.
 *
 * Three ideas replace it, all of them generalised from `looksLikeTask`, which was the one gate in
 * the app that already worked and existed for one facet only:
 *
 * 1. **A marker must lead.** A statement that happens to mention a word is a statement; a statement
 *    that begins with it is a commitment. Position is the strongest signal available to a lexical
 *    rule and it was being ignored.
 * 2. **Shape can veto.** Length, sentence count and markdown structure decide whether a segment is
 *    an assertion at all, before any keyword is consulted.
 * 3. **A weak signal needs corroboration.** A negation alone says nothing; a negation about a named
 *    identifier or file is a finding. Anything left over scores below the threshold and is kept as
 *    `other`: recorded, quoted, reachable by `record`, and filed under no heading.
 */

/** 0 is "no evidence", 1 is "the sentence is built out of the marker". */
export type Confidence = number;

export interface Classification {
  /**
   * `other` whenever `confidence` is below `CLAIM_THRESHOLD`, so a caller cannot read a kind that
   * was not asserted. The principle is enforced by the type rather than by everyone remembering
   * to check — which is how `looksLikeTask` came to gate one facet while the change log took the
   * same claims ungated.
   */
  kind: ClaimKind;
  confidence: Confidence;
  /**
   * Which signal decided it, including when the signal was not enough: a `discovery` that scored
   * 0.4 reports `kind: 'other'` and `rule: 'defect-uncorroborated'`. Named so a test asserts the
   * reason and not only the answer, and so the drill-through can say why nothing was claimed.
   */
  rule: string;
}

/**
 * The one number. Above it a claim is asserted under its heading and can reach Verified, Left,
 * Why, How and the change log; below it the claim is `other` and reaches none of them.
 *
 * It sits where it does because every rule below is scored on the same three-step ladder — a
 * lead-anchored marker is 0.9, a marker corroborated by a second independent feature is 0.75, and
 * an uncorroborated body match is 0.4. The threshold is the line between the second and the third,
 * which is the line between "two things agree" and "a word appeared".
 */
export const CLAIM_THRESHOLD = 0.7;

const LEAD_ANCHORED = 0.9;
const CORROBORATED = 0.75;
const BODY_ONLY = 0.4;

const NONE: Classification = { kind: 'other', confidence: 0, rule: 'none' };

// -------------------------------------------------------------------------------------------
// Shared gates
// -------------------------------------------------------------------------------------------

/**
 * A claim is one assertion. Beyond this it is a paragraph, and a paragraph is drill-through
 * reached by `record` rather than something the page states in its own voice.
 */
const CLAIM_MAX = 400;
const CLAIM_MIN = 16;

const QUESTION_LAST_LINE = /\?\s*$/;
const QUESTION_OPENER =
  /^(should|do you|would you|which|can you|could you|shall|is it ok|are you|want me|shall i|any preference)\b/i;

/** A message is a question when its last non-empty line ends with '?' or its first line opens like one. */
export function isQuestion(text: string): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const first = forMatching(lines[0] ?? '');
  const last = lines[lines.length - 1] ?? '';
  return QUESTION_LAST_LINE.test(last) || QUESTION_OPENER.test(first);
}

/** How many sentences the segment contains, counting a terminator followed by a break or the end. */
function sentenceCount(t: string): number {
  return (t.match(/[.!?](?:\s|$)/g) ?? []).length;
}

/**
 * A segment that ends in a colon announces something; the thing it announces is the next segment.
 * Treating it as the assertion itself is what made a list header ("Key decisions and changes:",
 * "Verification:", "Case counts:") into a statement of approach 4,551 times over.
 */
function announcesList(t: string): boolean {
  return /:\s*$/.test(t);
}

/**
 * Modality that puts the sentence somewhere other than "this is so": a hypothetical, an offer, a
 * question put to the reader, or a preference. Adjacent to the marker, not merely present, for
 * the same reason the verification rule checks adjacency — "run the tests to make sure they pass"
 * is not a claim that they passed.
 */
const HEDGE_BEFORE =
  /\b(if|unless|whether|would|could|should|might|maybe|perhaps|want me to|i'?d rather|in case|to see if|to make sure|so that|once|until|before)\b[^.\n]{0,40}$/i;

function hedgedAt(text: string, index: number): boolean {
  return HEDGE_BEFORE.test(text.slice(Math.max(0, index - 60), index));
}

/**
 * A named thing in the codebase: a backticked identifier, a path with an extension, or one of the
 * `[label](path:line)` references agents write. This is the corroboration a weak signal needs —
 * "the row never creates the marker" is a sentence, "`agent_access.rs:28` never creates the
 * durable marker" is a finding, and the difference is that the second one can be checked.
 */
const CODE_REFERENT =
  /`[^`\n]+`|\[[^\]]+\]\([^)\s]+\)|\b[\w@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|json|jsonl|md|rs|swift|py|go|rb|java|kt|sql|sh|toml|yml|yaml|html|astro)\b(?::\d+)?/;

function hasCodeReferent(t: string): boolean {
  return CODE_REFERENT.test(t);
}

/**
 * Typographic punctuation, normalised for matching only — the text shown to a reader keeps what
 * the agent wrote. Every rule in this file spells the contraction `i'?ll`, and 9.6% of real agent
 * messages use the curly apostrophe, so "I'll rewrite the pipeline" was a statement of approach
 * and "I’ll rewrite the pipeline" was unclassifiable prose. That is a rule failing on a font.
 */
function forMatching(t: string): string {
  return t.replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

// -------------------------------------------------------------------------------------------
// remaining — "a thing still to be done"
// -------------------------------------------------------------------------------------------

/**
 * Generalised from `looksLikeTask`, which lived in the projection and gated exactly one facet
 * while the change log took the same claims ungated: 381 `left` entries asserted from prose that
 * Left itself would have refused. The gate belongs where the classification is made.
 *
 * The marker has to open the sentence. That one change is what separates "Still need to wire the
 * Codex adapter" from "Two things I did not do, so you can decide: Records is still 2,730px — over
 * half the remaining page", which is 101 characters, one sentence, no markdown, and passes every
 * other gate here.
 */
const TASK_MAX = 140;

const LEADS_REMAINING =
  /^(?:todo\b|next steps?\b|still\s+(?:need|needs|to do|left)\b|not yet\b|not done\b|left to do\b|follow-?ups?\b|out of scope\b|remaining\b|i(?:'ve| have)? ?ha?ve ?n'?t\b|ha ?ve ?n'?t\b|did ?n'?t get to\b)/i;

/**
 * Whether a sentence the agent wrote is shaped like a thing still to be done. Kept as a named
 * export because it is the shape the rest of this file is built on and its regression suite names
 * it directly.
 */
export function looksLikeTask(text: string): boolean {
  const t = forMatching(text.trim());
  if (t.length === 0 || t.length > TASK_MAX) return false;
  if (!LEADS_REMAINING.test(t)) return false;
  if (announcesList(t)) return false; // announces a list; the items are elsewhere
  if (/\*\*|^#{1,6}\s|```/.test(t)) return false; // markdown: written to be rendered, not listed
  if (sentenceCount(t) > 1) return false; // more than one sentence is prose
  return true;
}

function scoreRemaining(t: string): Classification | undefined {
  if (looksLikeTask(t)) return { kind: 'remaining', confidence: LEAD_ANCHORED, rule: 'task-lead' };
  // The words appear constantly in prose *about* what is left. Recorded, never asserted.
  if (/\b(remaining|still need|not yet|left to do|follow-?up|todo)\b/i.test(t))
    return { kind: 'remaining', confidence: BODY_ONLY, rule: 'task-word-in-body' };
  return undefined;
}

// -------------------------------------------------------------------------------------------
// verification — "the agent says a check came out a particular way"
// -------------------------------------------------------------------------------------------

/**
 * The adjacency-checked form the `claim-without-evidence` review rule has always used. The claims
 * layer had a looser one of its own, so the two disagreed about what a verification claim is: the
 * review rule would not count "run the tests to make sure they pass" and the claims layer would.
 */
const VERIFICATION_CLAIM =
  /\b(?:all\s+)?(tests?|checks?|suites?|specs?|build|builds|typecheck|typechecks|lint|compile)\s+(?:are\s+|is\s+|now\s+|still\s+|all\s+)?(pass|passes|passed|passing|green|succeeds|succeeded|clean|fail|fails|failed|failing|red)\b/i;
const CLAIM_NEGATION =
  /\b(not|n't|never|should|will|would|until|once|need to|needs to|make sure|to see if|whether|if)\b[^.\n]{0,40}$/i;

/**
 * A count that is a check result rather than an arithmetic coincidence. The old rule was a bare
 * `\d+/\d+` anywhere, so it read a date out of a URL, the `0.604708/1.161958 ms` in a timing line
 * and the `4/6/10/16px` in a list of radius tokens as evidence that tests had run. A ratio counts
 * only when a check noun is next to it, and never when it is part of a decimal.
 */
const CHECK_NOUN = /(?:tests?|checks?|cases?|cells?|specs?|suites?|assertions?|examples?|green)/;
const RATIO_WITH_NOUN = new RegExp(
  `(?:${CHECK_NOUN.source}\\b[^.\\n]{0,16}(?<![\\d.])\\d{1,6}\\s*/\\s*\\d{1,6}(?![\\d.])` +
    `|(?<![\\d.])\\d{1,6}\\s*/\\s*\\d{1,6}(?![\\d.])[^.\\n]{0,16}\\b${CHECK_NOUN.source})`,
  'i',
);
const COUNT_WITH_OUTCOME = /\b\d{1,6}\s+(green|passing|failing|red)\b/i;

function scoreVerification(t: string): Classification | undefined {
  const m = VERIFICATION_CLAIM.exec(t);
  if (m && !CLAIM_NEGATION.test(t.slice(Math.max(0, m.index - 60), m.index)))
    return { kind: 'verification', confidence: LEAD_ANCHORED, rule: 'runner-outcome' };
  const c = COUNT_WITH_OUTCOME.exec(t);
  if (c && !hedgedAt(t, c.index))
    return { kind: 'verification', confidence: CORROBORATED, rule: 'count-with-outcome' };
  const r = RATIO_WITH_NOUN.exec(t);
  if (r && !hedgedAt(t, r.index))
    return { kind: 'verification', confidence: CORROBORATED, rule: 'ratio-beside-check-noun' };
  if (m) return { kind: 'verification', confidence: BODY_ONLY, rule: 'runner-outcome-hedged' };
  return undefined;
}

// -------------------------------------------------------------------------------------------
// approach — "what the agent says it is about to do"
// -------------------------------------------------------------------------------------------

/**
 * An approach is a statement about work not yet done, and the only deterministic evidence of that
 * is modality: a first-person forward form, or the bare gerund agents use as a step announcement
 * ("Now rewriting the pipeline"). Everything else is a guess dressed as a rule.
 *
 * What this deliberately refuses to claim: "Now the daemon entry point that wires everything".
 * It is very probably an approach — and "Now one day is one mark, stacked by tool" is the same
 * shape and is a report of a change already made. Nothing observed separates them, so neither is
 * asserted. That is the cost of the principle and it is the right price.
 */
const FILLER_PREFIX = /^(?:(?:so|ok|okay|right|good|and|but|well)[,:]?\s+)?/i;
const SEQUENCED_PREFIX = /^(?:now|next|then|first|finally|after that)[,:]?\s+/i;
const APPROACH_MODAL =
  /^(?:i'?ll|i will|let me|let's|i'?m going to|i'?m about to|i'?m now|i am going to|going to|i plan to|my plan is|the plan is|approach:)\b/i;
const APPROACH_GERUND =
  /^(?:adding|removing|deleting|dropping|fixing|updating|rewriting|writing|wiring|building|measuring|checking|testing|verifying|extracting|switching|replacing|moving|making|reproducing|implementing|refactoring|migrating|renaming|splitting|merging|porting|wrapping|converting|restoring|reverting|generating|instrumenting|profiling|benchmarking)\b/i;

function scoreApproach(t: string): Classification | undefined {
  const afterFiller = t.slice((FILLER_PREFIX.exec(t)?.[0] ?? '').length);
  const sequenced = SEQUENCED_PREFIX.exec(afterFiller)?.[0];
  const rest = sequenced ? afterFiller.slice(sequenced.length) : afterFiller;
  if (APPROACH_MODAL.test(rest))
    return { kind: 'approach', confidence: LEAD_ANCHORED, rule: 'intent-modal-lead' };
  /*
   * A leading gerund is ambiguous in English between an announcement and a noun phrase, and the
   * two are indistinguishable without parsing: "Now wiring it into the section" announces a step,
   * "Building that preflight surfaced a latent bug" is a finding whose subject is a gerund, and
   * "Making the least-data capture mode paid deserves reconsideration" is an opinion. Sampled,
   * the bare form was right about two times in three. Temporal sequencing is the corroboration —
   * an announcement is marked either by first-person modality or by its place in a sequence — and
   * with it required the rule stops guessing at the other two.
   */
  if (sequenced && APPROACH_GERUND.test(rest))
    return { kind: 'approach', confidence: CORROBORATED, rule: 'sequenced-step-lead' };
  if (APPROACH_GERUND.test(rest))
    return { kind: 'approach', confidence: BODY_ONLY, rule: 'bare-gerund' };
  // A colon used to be sufficient on its own. It is now not even evidence, only a reason to record.
  if (announcesList(t)) return { kind: 'approach', confidence: BODY_ONLY, rule: 'announces-list' };
  return undefined;
}

// -------------------------------------------------------------------------------------------
// discovery — "what the agent says it found"
// -------------------------------------------------------------------------------------------

/**
 * A finding is a report about the state of the world, in the past or present. Lead-anchored
 * reporting verbs are unambiguous. Everything else needs a second, independent feature: a named
 * identifier, path or file reference, which is what
 * makes the sentence checkable rather than merely negative.
 */
const DISCOVERY_LEAD =
  /^(?:(?:so|ok|okay|and|but|well)[,:]?\s+)?(?:found it|found that|found|i found|i'?ve found|discovered|i discovered|turns out|it turns out|the (?:root )?cause (?:is|was)|the (?:issue|problem|bug|defect|fault|regression) (?:is|was|turned out)|root cause:|cause:|the real (?:cause|problem|issue|reason|bug)|confirmed:)\b/i;

/** A defect reported about something, rather than a sentence that merely contains a negation. */
const DEFECT_PHRASE =
  /\b(?:(?:is|was|were|are)\s+(?:wrong|broken|stale|missing|empty|null|undefined|the problem|the cause)|(?:does ?n'?t|do ?n'?t|did ?n'?t|is ?n'?t|are ?n'?t|was ?n'?t|were ?n'?t|ca ?n'?t|could ?n'?t|never|no longer|not actually)\s+\w+)/i;

function scoreDiscovery(t: string): Classification | undefined {
  if (DISCOVERY_LEAD.test(t))
    return { kind: 'discovery', confidence: LEAD_ANCHORED, rule: 'finding-lead' };
  const d = DEFECT_PHRASE.exec(t);
  if (d) {
    /*
     * A negation about a named identifier reads like a finding but is still not knowledge. The rule
     * cannot tell "`x.ts` never runs the erase" from "I didn't make that
     * scope call for you": both are a negation beside a filename, and separating them is a
     * judgement about who the subject is. So it stays below the threshold. It is recorded with its
     * reason, and nothing prints it under a heading.
     *
     * Deliberately not solved by adding a first-person veto: that fits the sample rather than the
     * problem, and a rule tuned until one audit passes is the rule this file replaced.
     */
    const corroborated = !hedgedAt(t, d.index) && hasCodeReferent(t) && sentenceCount(t) <= 2;
    return {
      kind: 'discovery',
      confidence: BODY_ONLY,
      rule: corroborated ? 'defect-with-referent' : 'defect-uncorroborated',
    };
  }
  if (/\b(found|discovered|turns out|actually|noticed|the real \w+)\b/i.test(t))
    return { kind: 'discovery', confidence: BODY_ONLY, rule: 'finding-word-in-body' };
  return undefined;
}

// -------------------------------------------------------------------------------------------
// summary — "this message is the report at the end of the turn"
// -------------------------------------------------------------------------------------------

const SUMMARY_LEAD =
  /^(?:summary|in summary|to summari[sz]e|here'?s what|what i did|what changed|done\b|completed\b|finished\b|all done\b)/i;

function scoreSummary(t: string, phase: Phase): Classification | undefined {
  if (phase !== 'final') return undefined;
  if (SUMMARY_LEAD.test(t))
    return { kind: 'summary', confidence: LEAD_ANCHORED, rule: 'summary-lead' };
  return undefined;
}

// -------------------------------------------------------------------------------------------
// The classifier
// -------------------------------------------------------------------------------------------

export type Phase = 'commentary' | 'final';

/**
 * Classify one segment. Order is by strength of evidence, not by facet importance: whichever rule
 * scores highest wins, and ties go to the more specific facet. A segment that reports an outcome
 * and also announces the next step is one or the other here, and `extractClaims` splits messages
 * finely enough that the two usually arrive separately.
 */
export function classifySegment(raw: string, phase: Phase = 'commentary'): Classification {
  const shape = markdownShape(raw);
  if (isRenderedFurniture(shape)) return { kind: 'other', confidence: 0, rule: 'not-narration' };

  /*
   * Classified on the text the reader is shown, not on the whole segment. A claim is clipped for
   * display, and a rule that fires on a phrase past the clip point asserts a kind on evidence the
   * reader cannot see. If it is not on the page it does not count.
   */
  const shown = clipSegment(plainText(raw));
  if (shown.length < CLAIM_MIN || shown.length > CLAIM_MAX)
    return {
      kind: 'other',
      confidence: 0,
      rule: shown.length < CLAIM_MIN ? 'too-short' : 'too-long',
    };

  const t = forMatching(shown);
  const candidates = [
    scoreRemaining(t),
    scoreVerification(t),
    scoreSummary(t, phase),
    scoreDiscovery(t),
    scoreApproach(t),
  ].filter((c): c is Classification => c !== undefined);

  let best = NONE;
  for (const c of candidates) if (c.confidence > best.confidence) best = c;
  return isAsserted(best) ? best : { kind: 'other', confidence: best.confidence, rule: best.rule };
}

/** True when a classification may be stated on the page under its own heading. */
export function isAsserted(c: Classification): boolean {
  return c.confidence >= CLAIM_THRESHOLD && c.kind !== 'other';
}

/**
 * Splits narration into the units people actually assert in: paragraphs, and sentences within a
 * long paragraph. Fenced code blocks are removed first — they are evidence, not explanation.
 */
function segments(text: string): string[] {
  /*
   * List markers come off before anything is split, because a marker is not part of the sentence
   * and the sentence splitter cannot tell its full stop from a real one: "**1. The widening-
   * interval story doesn't work.** The graph is too short" split after the ordinal, which left the
   * closing `**` with nothing to pair against and put it on the page. The emphasis around a
   * numbered item is kept so its pair still closes.
   */
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/gm, '')
    .replace(/^(\s*(?:\*\*|__))\s*\d{1,3}[.)]\s+/gm, '$1');
  const out: string[] = [];
  for (const para of prose.split(/\n{2,}|\n(?=[A-Z\d#>*-])/)) {
    const t = para.trim();
    if (!t) continue;
    if (t.length <= 240) {
      out.push(t);
      continue;
    }
    for (const sentence of t.split(/(?<=[.!?:])\s+(?=[A-Z\d])/)) {
      const st = sentence.trim();
      if (st) out.push(st);
    }
  }
  return out;
}

/** Bound a segment for display without cutting mid-word. Markdown is already flattened. */
function clipSegment(s: string, max = 200): string {
  const t = trimDanglingMarker(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${trimDanglingMarker((space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd())}…`;
}

/**
 * A marker at the very edge whose partner is not in the text — an inline code span the segmenter
 * cut through, an emphasis run that opened in an earlier segment. Nothing follows it, so it can
 * only be noise; a marker in the middle of the text is left alone, because there it might be the
 * content ("Adding sample-app://**").
 */
function trimDanglingMarker(s: string): string {
  return s.replace(/^(?:`|\*{1,3}|_{1,3})+\s*/, '').replace(/\s*(?:`|\*{1,3}|_{1,3})+$/, '');
}

export interface ExtractedClaim {
  kind: ClaimKind;
  text: string;
  confidence: Confidence;
  rule: string;
}

/**
 * Every meaningful thing a message asserts, not just the first. One message routinely reports an
 * outcome and announces the next step ("235 green. Adding test targets for the new functions:"),
 * and collapsing that to a single label is why Why and How were starved.
 *
 * What changed: there is no longer a fallback. A message that asserts nothing recognisable used to
 * be given a `status` claim built from its first line, the "regions must be filled" defect in its
 * purest form. Prose that classifies as nothing is now returned as a
 * single `other` claim: recorded, quoted where the page shows the agent's latest statement,
 * reachable by `record`, and filed under no heading. Text that is not narration at all — a fenced
 * block, a tool artifact, a Codex reasoning header wrapped whole in `**` — returns nothing.
 *
 * Returns at most `max` claims, in the order stated, never rewritten beyond flattening markdown.
 */
export function extractClaims(text: string, phase: Phase, max = 5): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  let best: ExtractedClaim | undefined;

  /*
   * Whether the agent is waiting on an answer is a fact about the *message* — it handed control
   * back — not about a sentence inside it. Asked per segment, a rhetorical aside in the middle of
   * a report becomes "needs you", which is the loudest thing the session list can say. It is asked
   * once, of the whole message, and it is *added* to what the message asserts rather than
   * replacing it: a report that ends "Want me to take keyboard avoidance next?" still said its
   * tests passed, and that is the half a reader most needs.
   */
  if (isQuestion(text.trim())) {
    const q = clipSegment(plainText(headlineQuestion(text)));
    if (q) out.push({ kind: 'question', text: q, confidence: LEAD_ANCHORED, rule: 'question' });
  }

  for (const segment of segments(text)) {
    const c = classifySegment(segment, phase);
    const flat = clipSegment(plainText(segment));
    if (!flat) continue;
    if (c.rule === 'not-narration') continue;
    if (isQuestion(flat)) continue; // already carried once, for the message as a whole
    if (!isAsserted(c)) {
      // Keep the strongest near-miss so a message that says something unclassifiable is still
      // recorded once, as `other`, rather than disappearing from the record entirely.
      if (!best || c.confidence > best.confidence)
        best = { kind: c.kind, text: flat, confidence: c.confidence, rule: c.rule };
      continue;
    }
    const key = `${c.kind}:${flat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: c.kind, text: flat, confidence: c.confidence, rule: c.rule });
    if (out.length >= max) break;
  }

  if (out.length > 0) return out;
  return best ? [best] : [];
}

/**
 * The question the message ends on, which is the one being put to the reader. A long report that
 * closes with "Want me to take keyboard avoidance next?" is asking that, not its first line.
 */
function headlineQuestion(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] ?? '';
    if (/\?\s*$/.test(l)) return l;
  }
  return lines[0] ?? '';
}

/**
 * The whole-message kind, for the callers that need one label rather than a list. It carries the
 * same threshold: a message whose strongest segment is below it is `other`, and `other` means the
 * caller must not print a heading over it.
 */
export function classifyAgentMessage(text: string, phase: Phase): Classification {
  if (isQuestion(text.trim()))
    return { kind: 'question', confidence: LEAD_ANCHORED, rule: 'question' };
  let best = NONE;
  for (const segment of segments(text)) {
    const c = classifySegment(segment, phase);
    if (c.rule === 'not-narration') continue;
    if (c.confidence > best.confidence) best = c;
  }
  return best;
}

/**
 * First non-empty line as it renders, bounded. Used for turn headlines and log lines, where the
 * point is to name the message rather than to assert anything about it.
 */
export function headlineOf(text: string, max = 160): string {
  for (const raw of text.split('\n')) {
    const line = plainText(raw);
    if (line.length === 0) continue;
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
  }
  return '';
}
