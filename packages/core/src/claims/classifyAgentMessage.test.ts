import { describe, expect, it } from 'vitest';
import { classifySegment, extractClaims, isAsserted } from './classifyAgentMessage.ts';

/**
 * These synthetic strings preserve the linguistic shapes that exposed false classifications in
 * corpus audits, without retaining user prompts, project names, or local paths.
 *
 * The assertion that matters throughout is `isAsserted`. A classification below the threshold is
 * not a weaker claim; the page states nothing at all.
 */

const kindOf = (t: string, phase: 'commentary' | 'final' = 'commentary') =>
  classifySegment(t, phase).kind;
const asserted = (t: string, phase: 'commentary' | 'final' = 'commentary') =>
  isAsserted(classifySegment(t, phase));

describe('a marker in the body is not a claim', () => {
  /* A bare "remaining" in prose is not enough to create a task. */
  it('does not read prose about what is left as a thing left to do', () => {
    expect(
      asserted(
        'Two things I did not do, so you can decide: the table still fills over half the remaining page.',
      ),
    ).toBe(false);
    expect(
      asserted(
        'The remaining blocker is incomplete process cleanup: `run_task()` and every `run_check()` use `runner.run_bounded()`.',
      ),
    ).toBe(false);
    expect(asserted('Work through the remaining tasks end to end.')).toBe(false);
    expect(
      asserted(
        'I’m making the remaining correction now: thinner controls, softer backgrounds, and less accent color.',
      ),
    ).toBe(false);
  });

  it('still reads a task that opens with its marker', () => {
    expect(kindOf('Still need to wire the adapter for Codex hooks')).toBe('remaining');
    expect(kindOf('TODO: drop the legacy checkpoint path')).toBe('remaining');
    expect(kindOf('Not yet handled: Windows relay.')).toBe('remaining');
  });

  /* A bare negation or the word "actually" is not enough to establish a discovery. */
  it('does not read a sentence that merely contains a negation as a finding', () => {
    expect(
      asserted(
        "Checking whether the package hook covers that, and researching registry rules for packages that don't exist yet.",
      ),
    ).toBe(false);
    expect(
      asserted(
        "I don't know what you have beyond sample-app, and I'd rather not guess at repositories I haven't looked at.",
      ),
    ).toBe(false);
    expect(
      asserted(
        "Wrote the analysis into docs/NOTES.md under a new section, including the failure, so the next session doesn't rediscover it.",
      ),
    ).toBe(false);
    expect(asserted('### 1a. What `decodeAsset` actually destroys and allocates')).toBe(false);
  });

  it('still reads a finding that opens with a reporting verb', () => {
    expect(
      kindOf(
        'Found it — the page paints correctly; the pane was serving a stale frame that only refreshed on style mutation.',
      ),
    ).toBe('discovery');
    expect(
      kindOf('The cause was mine: in the "collapse to one layout" pass I wrapped the charts.'),
    ).toBe('discovery');
    expect(kindOf('Turns out the tailer re-read the partial line bytes twice.')).toBe('discovery');
  });
});

describe('a trailing colon announces a list; it is not the claim', () => {
  /* A trailing colon can introduce a list without asserting an approach. */
  it('does not read a list header as a statement of approach', () => {
    expect(asserted('Key decisions and changes:')).toBe(false);
    expect(asserted('Worth stating plainly since both shaped decisions:')).toBe(false);
    expect(asserted('The account settings narrow the issue down:')).toBe(false);
    expect(
      asserted(
        'Agreed—the flat version overcorrected into sterile wireframe UI. The two rejected directions are now explicit:',
      ),
    ).toBe(false);
    expect(asserted('Now the traversal records what it declined:')).toBe(false);
  });

  it('reads an intent that happens to end in a colon, on the intent rather than the colon', () => {
    expect(kindOf('Now reproducing D1:')).toBe('approach');
    expect(
      kindOf('Now wiring it into the section — the mutation handlers and the project rows:'),
    ).toBe('approach');
  });
});

describe('approach is decided by modality, not by looking like work', () => {
  it('reads a first-person forward statement', () => {
    expect(kindOf("I'll start by reading the script and getting the actual CI failure logs.")).toBe(
      'approach',
    );
    expect(kindOf('Let me place the brace correctly rather than just appending one.')).toBe(
      'approach',
    );
  });

  /* Typographic apostrophes must behave like their ASCII equivalents. */
  it('is not defeated by a curly apostrophe', () => {
    expect(
      kindOf('I’ll fold this into the existing menu implementation as a keyboard overlay.'),
    ).toBe('approach');
    expect(kindOf('I’m going to reproduce it on the simulator first.')).toBe('approach');
  });

  /* A leading gerund can be an announcement or a noun phrase; sequencing corroborates intent. */
  it('does not read a gerund subject as an announcement', () => {
    expect(asserted('Making the least-data capture mode paid deserves reconsideration.')).toBe(
      false,
    );
    expect(asserted('Building that preflight surfaced a latent bug in the existing script.')).toBe(
      false,
    );
    expect(asserted('Writing help now opens explicit options for the reader.')).toBe(false);
  });

  it('reads a sequenced step', () => {
    expect(kindOf('Now rewriting the machine to the spec’s geometry and three phases')).toBe(
      'approach',
    );
    expect(kindOf('Now deleting DragHandle — the whole pull geometry goes')).toBe('approach');
  });

  /*
   * Deliberate silence. "Now the daemon entry point that wires everything" is very probably an
   * approach; "Now one day is one mark, stacked by tool" is the same shape and is a report of a
   * change already made. Nothing observed separates them.
   */
  it('says nothing about "Now <noun phrase>", which is two different things', () => {
    expect(
      asserted(
        'Now the daemon entry point (`startDaemon`) that wires everything, writes `daemon.json` (0600), and the relay script.',
      ),
    ).toBe(false);
    expect(
      asserted('Now one day is one mark, stacked by tool, so mark height is that day’s total.'),
    ).toBe(false);
  });
});

describe('a number is not a check', () => {
  /* A bare ratio can describe many things other than a verification run. */
  it('does not read a ratio out of a path, a token list or a timing line', () => {
    expect(
      asserted(
        'visualize{"path":"/Users/example/.codex/visualizations/2026/08/15/sample/report.html"}',
      ),
    ).toBe(false);
    expect(
      asserted('Now four tokens cover everything: `--radius-xs/sm/md/lg` (4/6/10/16px).'),
    ).toBe(false);
    expect(
      asserted(
        'Synthetic benchmark timing changes from p50/p95 `12.5/19.25 ms` to `13.0/20.0 ms`, consistent with run noise.',
      ),
    ).toBe(false);
    expect(
      asserted(
        'A synthetic evaluation changes precision/F1 from 70/75 to 72/76 while keeping all 8 sample matches.',
      ),
    ).toBe(false);
    expect(
      asserted(
        'The example application was [closed in 2018](https://example.test/cases/792/15/sample.html).',
      ),
    ).toBe(false);
  });

  it('reads a ratio that is standing next to a check', () => {
    expect(
      kindOf(
        'Corrected smoke audit passes 20/20 cells across both modes, five fonts, and both splits.',
      ),
    ).toBe('verification');
    expect(kindOf('Additional sync/remote tests: 23/23')).toBe('verification');
    expect(kindOf('All 36 E2E tests pass across desktop and mobile.')).toBe('verification');
  });

  /*
   * The `claim-without-evidence` review rule has always checked adjacency and the claims layer had
   * a looser rule of its own, so the two disagreed about what a verification claim is. They are
   * the same rule now.
   */
  it('does not read an intention to run checks as a report that they passed', () => {
    expect(kindOf('Let me run the tests to make sure they pass.')).not.toBe('verification');
    expect(kindOf('Run the suite to see if the tests pass.')).not.toBe('verification');
  });
});

describe('text that is not narration produces nothing at all', () => {
  /* Codex reasoning headers are wrapped whole in `**`; they are not statements to a reader. */
  it('drops a reasoning header', () => {
    expect(extractClaims('**Evaluating guest draft persistence gaps**', 'commentary')).toEqual([]);
    expect(extractClaims('**Assessing cache invalidation paths**', 'commentary')).toEqual([]);
  });

  it('drops a markdown heading, a tool artifact and a fenced block', () => {
    expect(
      extractClaims('## PART 1 — What comparable tools actually ship as', 'commentary'),
    ).toEqual([]);
    expect(extractClaims('```json\n{"a":1}\n```', 'commentary')).toEqual([]);
    expect(kindOf('|  method  |  outcome  |')).toBe('other');
  });
});

describe('a message that asserts nothing is recorded, not filed', () => {
  /* Unclassifiable prose stays recorded and reachable but carries no asserted kind. */
  it('returns one `other` claim rather than inventing a kind', () => {
    const claims = extractClaims(
      'I agree with the diagnosis: the current pricing copy is technically accurate but sits in the worst middle.',
      'commentary',
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe('other');
    expect(isAsserted(claims[0] as never)).toBe(false);
  });

  it('never returns a kind a caller could file, once the confidence is short', () => {
    // Reads exactly like a task, and is prose about one. The kind is withheld, the reason is kept.
    const c = classifySegment('Two things I did not do, so you can decide: what is remaining.');
    expect(c.kind).toBe('other');
    expect(c.rule).toBe('task-word-in-body');
  });
});

describe('waiting is a fact about the message, not about a sentence in it', () => {
  /*
   * Asked per segment, a rhetorical aside in the middle of a report becomes "needs you", which is
   * the loudest thing the session list can say. Asked once, of the whole message, and added to
   * what the message asserts rather than replacing it.
   */
  it('carries both the question and what the report actually said', () => {
    const claims = extractClaims(
      'All 36 E2E tests pass across desktop and mobile.\n\nWant me to take keyboard avoidance and Dynamic Type next?',
      'final',
    );
    expect(claims.map((c) => c.kind)).toEqual(['question', 'verification']);
    expect(claims[0]?.text).toBe('Want me to take keyboard avoidance and Dynamic Type next?');
  });

  it('takes the question the message ends on, not its opening line', () => {
    const claims = extractClaims(
      'Which of the two is right?\n\nI have measured both and the second is faster.\n\nShall I take the second one?',
      'final',
    );
    expect(claims[0]?.text).toBe('Shall I take the second one?');
  });
});

describe('the evidence for a classification has to be on the page', () => {
  /* Classification runs on the same clipped text the reader can see. */
  it('does not classify on a phrase past the clip', () => {
    const tail = `Your docs call this out by name at RELEASE_CHECKLIST.md:92, and the whole of that paragraph is about the legacy project staying as the local development backend, which is a long way of saying the same thing twice over, ${'and again '.repeat(6)}and the flag is never set.`;
    expect(asserted(tail)).toBe(false);
  });
});
