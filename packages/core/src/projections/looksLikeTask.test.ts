import { describe, expect, it } from 'vitest';
import { looksLikeTask } from './projectSession.ts';

/**
 * Synthetic shapes that pin the difference between prose mentioning "remaining" and an actual
 * task.
 */
describe('looksLikeTask', () => {
  it('rejects a paragraph that merely uses the word "remaining"', () => {
    expect(
      looksLikeTask(
        'Two things I did not do, so you can decide: the table still fills over half the remaining page.',
      ),
    ).toBe(false);
  });

  it('rejects the sentence that introduces a list rather than being an item in it', () => {
    expect(looksLikeTask('Still to do:')).toBe(false);
    expect(looksLikeTask('Next steps, in order:')).toBe(false);
  });

  it('rejects prose written to be rendered as markdown', () => {
    expect(looksLikeTask('**Left to do** is the extraction threshold')).toBe(false);
    expect(looksLikeTask('## Remaining work')).toBe(false);
  });

  it('rejects more than one sentence', () => {
    expect(
      looksLikeTask('The parser still needs a threshold. That is the last remaining item.'),
    ).toBe(false);
  });

  it('rejects anything longer than a phrase', () => {
    expect(looksLikeTask(`still need to ${'x'.repeat(200)}`)).toBe(false);
  });

  it('keeps things that are actually tasks', () => {
    expect(looksLikeTask('Still need to wire the adapter for Codex hooks')).toBe(true);
    expect(looksLikeTask('TODO: drop the legacy checkpoint path')).toBe(true);
    expect(looksLikeTask('Not yet handled: Windows relay.')).toBe(true);
    expect(looksLikeTask('Follow-up: measure the p90 after the rewrite')).toBe(true);
  });
});
