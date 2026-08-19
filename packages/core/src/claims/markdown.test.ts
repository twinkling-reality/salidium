import { describe, expect, it } from 'vitest';
import { extractClaims } from './classifyAgentMessage.ts';
import { isRenderedFurniture, markdownShape, plainText } from './markdown.ts';

/**
 * Synthetic agent prose that preserves the markdown shapes the claims layer must flatten.
 */
describe('plainText', () => {
  it('flattens the markers a reader should never have seen', () => {
    expect(
      plainText(
        '**Continue the sample app — validation and hardening pass.** Repo: `~/dev/sample-app`',
      ),
    ).toBe('Continue the sample app — validation and hardening pass. Repo: ~/dev/sample-app');
  });

  it('keeps a link’s words and drops its address, which the record still has', () => {
    expect(plainText('See [agent_access.rs:28](/Users/g/x/agent_access.rs) for the check.')).toBe(
      'See agent_access.rs:28 for the check.',
    );
  });

  it('removes fenced code, which is evidence rather than explanation', () => {
    expect(plainText('Fixed:\n```ts\nconst x = 1;\n```\nand it builds.')).toBe(
      'Fixed: and it builds.',
    );
    // An unterminated fence takes the rest of the text with it.
    expect(plainText('Here is the output:\n```\nstill going')).toBe('Here is the output:');
  });

  /*
   * Emphasis is stripped only where it is paired and not hugging whitespace. A blanket strip of
   * `*` and `_` would rewrite arithmetic and identifiers, and a claim is relayed verbatim.
   */
  it('leaves arithmetic and snake_case alone', () => {
    expect(plainText('The stride is 2 * 3 * 4 and the field is snake_case_name.')).toBe(
      'The stride is 2 * 3 * 4 and the field is snake_case_name.',
    );
  });

  it('strips heading, quote and list furniture per line', () => {
    expect(plainText('## What died')).toBe('What died');
    expect(plainText('> the tailer re-read the bytes')).toBe('the tailer re-read the bytes');
    expect(plainText('- one\n- two')).toBe('one two');
  });
});

describe('markdownShape', () => {
  /*
   * A Codex reasoning record is the model's own thought header and arrives wrapped whole in `**`.
   * It is not a statement to a reader. The reason is structural, not a per-provider exception.
   */
  it('recognises a line that is entirely bold as a header', () => {
    expect(markdownShape('**Evaluating guest draft persistence gaps**').wholeBold).toBe(true);
    expect(isRenderedFurniture(markdownShape('**Hardening socket placement**'))).toBe(true);
  });

  it('does not call a sentence with a bold phrase in it a header', () => {
    expect(
      markdownShape('The **widening-interval** story does not work, and **the graph** is short.')
        .wholeBold,
    ).toBe(false);
  });

  it('recognises a tool record that reached a text field', () => {
    expect(
      markdownShape('visualize{"path":"/Users/g/.codex/visualizations/2026/08/15/x.html"}')
        .artifact,
    ).toBe(true);
    expect(markdownShape('packages/core/src/state/reducer.ts').artifact).toBe(true);
  });

  it('recognises headings, fences and tables', () => {
    expect(markdownShape('## What died').heading).toBe(true);
    expect(markdownShape('```json\n{}\n```').fence).toBe(true);
    expect(markdownShape('| method | outcome |').table).toBe(true);
  });
});

describe('segmentation does not orphan a marker', () => {
  /*
   * The sentence splitter once treated the full stop in a numbered list marker as the end of a
   * sentence, so "**1. The cache-warming theory — my first guess — doesn't work.**" split after
   * the ordinal and left the closing `**` with nothing to
   * pair against. List markers come off before anything is split.
   */
  it('keeps a bold numbered item in one piece', () => {
    const claims = extractClaims(
      "## What failed\n\n**1. The cache-warming theory — my first guess — doesn't work.** The trace is too short. Window 5; 92.6% of samples finish within 3 hops.",
      'commentary',
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.text).not.toContain('*');
    expect(claims[0]?.text.startsWith('The cache-warming theory')).toBe(true);
  });

  it('drops a marker left dangling at the edge of a clipped segment', () => {
    const claims = extractClaims('App crashed on launch with `ReferenceError', 'commentary');
    expect(claims[0]?.text).toBe('App crashed on launch with ReferenceError');
  });
});
