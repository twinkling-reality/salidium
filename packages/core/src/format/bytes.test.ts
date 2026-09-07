import { describe, expect, it } from 'vitest';
import { byteLabelVectors, formatBytes } from './bytes.ts';

describe('shared byte rendering', () => {
  /*
   * The loop that `macosService.test.ts` closes at the other end.
   *
   * That test checks the Swift menu bar against `byteLabelVectors`. Without this one the vectors
   * are only ever compared to Swift, so changing `formatBytes` and leaving them alone would leave
   * both tests passing while the app and the menu bar disagreed, which is the exact failure the
   * vectors exist to prevent.
   */
  it('produces the labels the menu bar is held to', () => {
    for (const [bytes, label] of byteLabelVectors) expect(formatBytes(bytes)).toBe(label);
  });

  it('switches unit at each boundary rather than one byte late', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.0 KB');
    expect(formatBytes(1000 * 1000 - 1)).toBe('1000.0 KB');
    expect(formatBytes(1000 * 1000)).toBe('1.0 MB');
    expect(formatBytes(1000 ** 3 - 1)).toBe('1000.0 MB');
    expect(formatBytes(1000 ** 3)).toBe('1.00 GB');
  });

  /* Finder is what a reader compares this against, so the agreement is worth asserting. */
  it('agrees with what Get Info reports for the same file', () => {
    expect(formatBytes(2_720_022_528)).toBe('2.72 GB');
  });

  /*
   * Sub-byte values reach this from a rate, not from a file size: `storageGrowth` is bytes per
   * minute and divides by a sample window, so a nearly idle store yields fractions.
   */
  it('keeps a fractional rate visible instead of rounding it to nothing', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(0.4)).toBe('0.4 B');
  });
});
