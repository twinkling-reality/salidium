import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  expandSourceEntry,
  expandSourceList,
  MAX_PATTERN_MATCHES,
  MAX_SOURCE_ENTRIES,
  parseSourceList,
} from './sourcePaths.ts';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'salidium-source-paths-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('extra source settings', () => {
  it('is empty when absent or blank', () => {
    expect(parseSourceList(undefined)).toEqual({ entries: [], refused: [] });
    expect(parseSourceList('')).toEqual({ entries: [], refused: [] });
    expect(parseSourceList(' : :')).toEqual({ entries: [], refused: [] });
  });

  it('keeps absolute paths in order, each once, without a trailing slash', () => {
    expect(parseSourceList('/a/b:/c/:/a/b').entries).toEqual([{ path: '/a/b' }, { path: '/c' }]);
  });

  it('refuses relative paths, dot components, and more than one *', () => {
    const { entries, refused } = parseSourceList(
      'relative:~/x:/a/../b:/a/./b:/a/*/b/*:/a/x*y*:/ok/*',
    );
    expect(entries).toEqual([{ path: '/ok/*', patternAt: 2 }]);
    expect(refused.map((r) => r.entry)).toEqual([
      'relative',
      '~/x',
      '/a/../b',
      '/a/./b',
      '/a/*/b/*',
      '/a/x*y*',
    ]);
  });

  it(`holds at most ${MAX_SOURCE_ENTRIES} entries`, () => {
    const raw = Array.from({ length: MAX_SOURCE_ENTRIES + 3 }, (_, i) => `/s/${i}`).join(':');
    const { entries, refused } = parseSourceList(raw);
    expect(entries).toHaveLength(MAX_SOURCE_ENTRIES);
    expect(refused).toHaveLength(3);
  });

  it('returns a plain entry as written, whether or not it exists', () => {
    expect(expandSourceList('/does/not/exist', 'directory')).toEqual(['/does/not/exist']);
  });

  it('expands * to real folders, skipping dot names, links and files', () => {
    const homes = join(root, 'homes');
    mkdirSync(join(homes, '0123456789abcdef'), { recursive: true });
    mkdirSync(join(homes, 'fedcba9876543210'));
    mkdirSync(join(homes, '.hidden'));
    writeFileSync(join(homes, 'a-file'), '');
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(homes, 'linked'));
    expect(expandSourceList(join(homes, '*'), 'directory')).toEqual([
      join(homes, '0123456789abcdef'),
      join(homes, 'fedcba9876543210'),
    ]);
    expect(expandSourceList(join(root, 'missing', '*'), 'directory')).toEqual([]);
  });

  it('requires every component after the match to be real, and the last of the right kind', () => {
    const tool = join(root, 'tool');
    mkdirSync(join(tool, 'box-a', 'data'), { recursive: true });
    writeFileSync(join(tool, 'box-a', 'data', 'store.db'), '');
    mkdirSync(join(tool, 'box-b', 'data', 'store.db'), { recursive: true });
    mkdirSync(join(tool, 'box-c'));
    mkdirSync(join(root, 'real-data'));
    writeFileSync(join(root, 'real-data', 'store.db'), '');
    symlinkSync(join(root, 'real-data'), join(tool, 'box-c', 'data'));
    expect(expandSourceList(join(tool, 'box-*', 'data', 'store.db'), 'file')).toEqual([
      join(tool, 'box-a', 'data', 'store.db'),
    ]);
  });

  it(`keeps the ${MAX_PATTERN_MATCHES} most recently modified matches`, () => {
    const homes = join(root, 'many');
    const old = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < MAX_PATTERN_MATCHES + 4; i++) {
      const path = join(homes, (i + 16).toString(16).padStart(4, '0'));
      mkdirSync(path, { recursive: true });
      utimesSync(path, old, old);
    }
    // Named to sort last, where a cut in name order would drop it.
    const newest = join(homes, 'ffff');
    mkdirSync(newest);
    const [entry] = parseSourceList(join(homes, '*')).entries;
    if (!entry) throw new Error('expected an entry');
    const found = expandSourceEntry(entry, 'directory');
    expect(found).toHaveLength(MAX_PATTERN_MATCHES);
    expect(found).toContain(newest);
    expect(found).toEqual([...found].sort());
  });
});
