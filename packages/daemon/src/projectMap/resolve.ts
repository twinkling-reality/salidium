/*
 * Resolves a module specifier to a file of the same Git tree, or classifies why it cannot.
 *
 * It reads only the tree: no node_modules, no build output, no network. Each resolution records the
 * rule that produced it, so a consumer can see how strong the claim is:
 *
 *   exact              the specifier names a tracked file
 *   ts-extension       a `.js`, `.mjs` or `.cjs` specifier whose TypeScript source is tracked, as
 *                      TypeScript's own node16 and nodenext resolution maps it
 *   probe              an extensionless or directory specifier completed by bundler-style probing;
 *                      weaker, since Node itself would refuse it
 *   exports:<cond>     a workspace package's `exports` entry, under the named condition, pointing at
 *                      a tracked file
 *   main               a workspace package's `main` field
 *
 * Conditional exports are read as Node reads them: the first key, in the package's own order, that
 * is an active condition wins, and a target that is not tracked is not resolved rather than replaced
 * by a later key. The active conditions are Node's (`node`, `import` or `require`, `default`) plus
 * `development`, the custom condition this repository's TypeScript and test configuration use.
 *
 * Ported from the validation prototype, whose resolutions matched esbuild, enhanced-resolve and
 * oxc-resolver exactly on Salidium and Halcyonic; the key order is the one change, which the
 * research run asked for.
 */

import { builtinModules } from 'node:module';
import { posix } from 'node:path';

const BUILTINS = new Set(builtinModules);
const TS_FOR_JS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
  '.jsx': ['.tsx'],
};
const PROBE = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx', '.json'];
const IMPORT_CONDITIONS = new Set(['development', 'node', 'import', 'default']);
const REQUIRE_CONDITIONS = new Set(['development', 'node', 'require', 'default']);

export interface WorkspacePackage {
  name: string;
  dir: string;
  exports: unknown;
  main: string | undefined;
}

export type Resolution =
  | { class: 'file'; target: string; rule: string; package?: string }
  | { class: 'external'; package: string }
  | { class: 'builtin'; package: string }
  | { class: 'unresolved'; reason: string; package?: string };

/** The package name part of a bare specifier: `@scope/name` or `name`. */
export function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** The first active condition's target, in the object's own key order, as Node resolves it. */
function pickTarget(
  value: unknown,
  conditions: ReadonlySet<string>,
  trail: string[] = [],
): { target: string; conditions: string[] } | undefined {
  if (typeof value === 'string') return { target: value, conditions: trail };
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickTarget(item, conditions, trail);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (!conditions.has(key)) continue;
      const found = pickTarget(inner, conditions, [...trail, key]);
      if (found) return found;
    }
  }
  return undefined;
}

export function createResolver(
  files: ReadonlySet<string>,
  workspace: ReadonlyMap<string, WorkspacePackage>,
) {
  const fileAt = (candidate: string): Resolution | undefined => {
    if (files.has(candidate)) return { class: 'file', target: candidate, rule: 'exact' };
    const ext = posix.extname(candidate);
    for (const ts of TS_FOR_JS[ext] ?? []) {
      const swapped = candidate.slice(0, -ext.length) + ts;
      if (files.has(swapped)) return { class: 'file', target: swapped, rule: 'ts-extension' };
    }
    for (const probe of PROBE) {
      if (files.has(candidate + probe))
        return { class: 'file', target: candidate + probe, rule: 'probe' };
    }
    for (const probe of PROBE) {
      const index = posix.join(candidate, `index${probe}`);
      if (files.has(index)) return { class: 'file', target: index, rule: 'probe' };
    }
    return undefined;
  };

  const viaPackage = (
    pkg: WorkspacePackage,
    specifier: string,
    conditions: ReadonlySet<string>,
  ): Resolution => {
    const subpath = `.${specifier.slice(pkg.name.length)}`;
    const exportsField = pkg.exports;
    if (exportsField !== undefined && exportsField !== null) {
      const map: Record<string, unknown> =
        typeof exportsField === 'string' ||
        Array.isArray(exportsField) ||
        typeof exportsField !== 'object' ||
        !Object.keys(exportsField).some((key) => key.startsWith('.'))
          ? { '.': exportsField }
          : (exportsField as Record<string, unknown>);
      let entry = Object.hasOwn(map, subpath) ? map[subpath] : undefined;
      if (entry === undefined) {
        for (const [key, value] of Object.entries(map)) {
          const star = key.indexOf('*');
          if (star < 0) continue;
          const prefix = key.slice(0, star);
          const suffix = key.slice(star + 1);
          if (
            subpath.length >= prefix.length + suffix.length &&
            subpath.startsWith(prefix) &&
            subpath.endsWith(suffix)
          ) {
            const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
            entry = JSON.parse(JSON.stringify(value).replaceAll('*', matched)) as unknown;
            break;
          }
        }
      }
      if (entry === undefined || entry === null)
        return { class: 'unresolved', package: pkg.name, reason: 'not-exported' };
      const found = pickTarget(entry, conditions);
      if (!found) return { class: 'unresolved', package: pkg.name, reason: 'not-exported' };
      const target = posix.normalize(posix.join(pkg.dir, found.target));
      if (!files.has(target))
        return { class: 'unresolved', package: pkg.name, reason: 'export-target-not-tracked' };
      return {
        class: 'file',
        target,
        rule: `exports:${found.conditions.join('>') || 'string'}`,
        package: pkg.name,
      };
    }
    if (subpath === '.') {
      const main = pkg.main ? fileAt(posix.normalize(posix.join(pkg.dir, pkg.main))) : undefined;
      const fallback = main ?? fileAt(posix.join(pkg.dir, 'index'));
      if (fallback?.class === 'file') return { ...fallback, rule: 'main', package: pkg.name };
      return { class: 'unresolved', package: pkg.name, reason: 'no-entry' };
    }
    const deep = fileAt(posix.normalize(posix.join(pkg.dir, subpath)));
    if (deep?.class === 'file') return { ...deep, package: pkg.name };
    return { class: 'unresolved', package: pkg.name, reason: 'subpath-not-tracked' };
  };

  /**
   * @param specifier as the source wrote it
   * @param importer repository-relative path of the importing file
   * @param mode `require` for a require call, otherwise `import`
   */
  return function resolve(
    specifier: string,
    importer: string,
    mode: 'import' | 'require' = 'import',
  ): Resolution {
    const clean = specifier.split('?')[0] ?? specifier;
    if (clean.startsWith('.') || clean.startsWith('/')) {
      if (clean.startsWith('/')) return { class: 'unresolved', reason: 'absolute-path' };
      const candidate = posix.normalize(posix.join(posix.dirname(importer), clean));
      if (candidate.startsWith('..')) return { class: 'unresolved', reason: 'outside-repository' };
      return fileAt(candidate) ?? { class: 'unresolved', reason: 'no-tracked-file' };
    }
    if (clean.startsWith('node:') || BUILTINS.has(clean) || BUILTINS.has(packageName(clean)))
      return { class: 'builtin', package: clean.replace(/^node:/, '') };
    if (clean.startsWith('#'))
      return { class: 'unresolved', reason: 'package-imports-not-supported' };
    const name = packageName(clean);
    const pkg = workspace.get(name);
    if (pkg)
      return viaPackage(pkg, clean, mode === 'require' ? REQUIRE_CONDITIONS : IMPORT_CONDITIONS);
    return { class: 'external', package: name };
  };
}
