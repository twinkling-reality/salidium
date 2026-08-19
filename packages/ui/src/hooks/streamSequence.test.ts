import { describe, expect, it } from 'vitest';
import { classifyStreamSequence } from './streamSequence.ts';

describe('classifyStreamSequence', () => {
  it('accepts the next event, ignores replayed duplicates, and resnapshots on a gap', () => {
    expect(classifyStreamSequence(42, 42)).toBe('accept');
    expect(classifyStreamSequence(42, 41)).toBe('duplicate');
    expect(classifyStreamSequence(42, 43)).toBe('resnapshot');
  });
});
