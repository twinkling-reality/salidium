import { describe, expect, it } from 'vitest';
import { explanationMode, parseExplanationMode } from './explanationMode.ts';

describe('explanation mode copy', () => {
  it('uses user-facing names while accepting stable CLI aliases', () => {
    expect(explanationMode('off')).toEqual({
      value: 'off',
      label: 'Local only',
      detail: 'No model calls',
    });
    expect(parseExplanationMode('local-only')).toBe('off');
    expect(parseExplanationMode('when-done')).toBe('session');
    expect(parseExplanationMode('each-reply')).toBe('turn');
    expect(parseExplanationMode('occasionally')).toBeUndefined();
  });
});
