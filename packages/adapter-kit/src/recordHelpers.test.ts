import { describe, expect, it } from 'vitest';
import { normalizeProviderTimestamp } from './recordHelpers.ts';

describe('normalizeProviderTimestamp', () => {
  it('normalizes explicit RFC 3339 offsets and precision to UTC milliseconds', () => {
    expect(normalizeProviderTimestamp('2026-08-19T08:34:56.7-04:00')).toBe(
      '2026-08-19T12:34:56.700Z',
    );
    expect(normalizeProviderTimestamp('2026-08-19T12:34:56.789123Z')).toBe(
      '2026-08-19T12:34:56.789Z',
    );
  });

  it('does not guess a timezone or accept JavaScript-only date syntax', () => {
    for (const value of [
      undefined,
      '',
      '2026-08-19T12:34:56.789',
      '08/19/2026 12:34:56',
      '2026-02-30T12:34:56Z',
      'invalid',
    ]) {
      expect(normalizeProviderTimestamp(value), String(value)).toBeUndefined();
    }
  });
});
