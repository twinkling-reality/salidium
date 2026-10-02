import { describe, expect, it } from 'vitest';
import { normalizeProviderTimestamp, pathArgumentMetadata } from './recordHelpers.ts';

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

describe('pathArgumentMetadata', () => {
  it('marks a path it had to shorten as truncated, since the cut can hide what it names', () => {
    const long = `/home/me/${'x/../'.repeat(97)}.aws/${'y/../'.repeat(98)}cli/cache/abc.json`;
    expect(long.length).toBeGreaterThan(1000);
    const metadata = pathArgumentMetadata({ path: long });
    expect(metadata.truncated).toBe(true);
    expect(metadata.paths[0]?.length).toBeLessThanOrEqual(1000);
    expect(pathArgumentMetadata({ path: '/repo/src/a.ts' })).toEqual({
      paths: ['/repo/src/a.ts'],
      truncated: false,
      undecodable: false,
    });
  });

  it('records a malformed escape under a URI key, and not under a path key', () => {
    expect(pathArgumentMetadata({ uri: '/repo/%ZZ/a.md' }).undecodable).toBe(true);
    expect(
      pathArgumentMetadata({ request: { hrefs: ['file:///repo/%E0%A4%A'] } }).undecodable,
    ).toBe(true);
    expect(pathArgumentMetadata({ path: '/repo/100%.md' }).undecodable).toBe(false);
    expect(pathArgumentMetadata({ uri: 'file:///repo/100%25.md' }).undecodable).toBe(false);
  });
});
