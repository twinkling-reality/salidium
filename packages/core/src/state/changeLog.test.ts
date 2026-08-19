import { describe, expect, it } from 'vitest';
import { basename } from './changeLog.ts';

describe('basename', () => {
  it.each([
    ['/Users/alice/repo/src/file.ts', 'file.ts'],
    ['C:\\Users\\Alice\\repo\\src\\file.ts', 'file.ts'],
    ['plain.txt', 'plain.txt'],
  ])('reads POSIX and Windows paths (%s)', (path, expected) => {
    expect(basename(path)).toBe(expected);
  });
});
