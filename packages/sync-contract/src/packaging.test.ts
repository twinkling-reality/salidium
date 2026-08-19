import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * This is the only workspace package that gets published, so its manifest is a promise to people
 * outside this repository rather than a build convenience. An `exports` condition that resolves to
 * a path `files` does not ship installs cleanly and then fails at import time for whichever
 * consumer happens to request that condition, which is exactly how a `development` condition
 * pointing at `src/` survived review: the release workflow's consumer check resolves `default`.
 */
const packageRoot = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
  files: string[];
  exports: Record<string, unknown>;
};

/** npm ships these regardless of `files`. */
const ALWAYS_PACKED = ['package.json', 'README.md', 'README', 'LICENSE', 'LICENCE'];

function exportTargets(
  node: unknown,
  path: string[] = [],
): Array<{ condition: string; target: string }> {
  if (typeof node === 'string') return [{ condition: path.join('.') || '.', target: node }];
  if (Array.isArray(node)) return node.flatMap((entry) => exportTargets(entry, path));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => exportTargets(value, [...path, key]));
  }
  return [];
}

function isPacked(target: string): boolean {
  const relative = target.replace(/^\.\//, '');
  if (ALWAYS_PACKED.includes(relative)) return true;
  return manifest.files.some(
    (entry) => relative === entry || relative.startsWith(`${entry.replace(/\/$/, '')}/`),
  );
}

describe('published package manifest', () => {
  const targets = exportTargets(manifest.exports);

  it('resolves every export condition to a file the tarball actually contains', () => {
    expect(targets.length).toBeGreaterThan(0);
    const unpacked = targets.filter(({ target }) => !isPacked(target));
    expect(unpacked).toEqual([]);
  });

  it('never exposes workspace source, which npm does not ship and Node will not strip in node_modules', () => {
    expect(targets.filter(({ target }) => /^\.\/src\//.test(target))).toEqual([]);
  });

  it('ships the retained compatibility fixtures a consumer pins against', () => {
    expect(manifest.files).toContain('fixtures');
    expect(existsSync(fileURLToPath(new URL('fixtures/v1', packageRoot)))).toBe(true);
  });
});
