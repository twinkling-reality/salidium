import { describe, expect, it } from 'vitest';
import { basename, commonDir, dirname, durationMs, shortHome, shortPath } from './format.ts';

describe('durationMs', () => {
  it('keeps the small units it always had', () => {
    expect(durationMs(undefined)).toBe('');
    expect(durationMs(500)).toBe('500ms');
    expect(durationMs(3200)).toBe('3.2s');
    expect(durationMs(45_000)).toBe('45s');
  });

  /*
   * The bug this pins: formatting stopped at minutes, making long spans needlessly hard to read.
   */
  it('rolls up through hours and days', () => {
    expect(durationMs(3_599_000)).toBe('59m 59s');
    expect(durationMs(3_600_000)).toBe('1h 0m');
    expect(durationMs(17_999_000)).toBe('4h 59m');
    expect(durationMs(86_399_000)).toBe('23h 59m');
    expect(durationMs(20948 * 60_000 + 6000)).toBe('14d 13h');
  });

  /* Two units, never three: at a scale where hours matter the seconds decide nothing. */
  it('never prints more than two units', () => {
    for (const ms of [999, 59_999, 3_599_999, 86_399_999, 9_999_999_999]) {
      expect(durationMs(ms).split(' ').length, String(ms)).toBeLessThanOrEqual(2);
    }
  });
});

describe('portable display paths', () => {
  it('shortens Windows paths relative to their working directory', () => {
    expect(shortPath('C:\\Users\\Alice\\repo\\src\\file.ts', 'C:\\Users\\Alice\\repo')).toBe(
      'src/file.ts',
    );
    expect(shortHome(shortPath('C:\\Users\\Alice\\repo'))).toBe('~/repo');
  });

  it('finds shared directories and names across separator styles', () => {
    expect(
      commonDir(['C:\\Users\\Alice\\repo\\src\\a.ts', 'C:\\Users\\Alice\\repo\\test\\a.test.ts']),
    ).toBe('C:/Users/Alice/repo/');
    expect(basename('C:\\Users\\Alice\\repo\\src\\a.ts')).toBe('a.ts');
    expect(dirname('src\\nested\\a.ts')).toBe('src/nested');
  });
});
