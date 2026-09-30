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
 */

import { builtinModules } from 'node:module';
import { posix } from 'node:path';

const BUILTINS = new Set(builtinModules);
const TS_FOR_JS = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };
const PROBE = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx', '.json'];
/** Source-first: the tree has no build output, so a source condition is the only one that can land. */
const CONDITIONS = [
  'development',
  'source',
  'types',
  'import',
  'node',
  'module',
  'default',
  'require',
];

/**
 * @typedef {{ name: string, dir: string, exports: unknown, main: string | undefined }} WorkspacePackage
 * @typedef {{
 *   class: 'file' | 'external' | 'builtin' | 'unresolved',
 *   target?: string,
 *   rule?: string,
 *   package?: string,
 *   reason?: string,
 * }} Resolution
 */

/** The package name part of a bare specifier: `@scope/name` or `name`. */
export function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/**
 * @param {Set<string>} files repository-relative paths in the tree
 * @param {Map<string, WorkspacePackage>} workspace packages declared by a package.json in the tree
 */
export function createResolver(files, workspace) {
  /** @returns {Resolution | undefined} */
  const fileAt = (candidate) => {
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

  /** A conditional exports value reduced to the first condition that names a tracked file. */
  const pick = (value, dir, trail = []) => {
    if (typeof value === 'string') {
      const target = posix.normalize(posix.join(dir, value));
      return files.has(target) ? { target, conditions: trail } : undefined;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = pick(item, dir, trail);
        if (found) return found;
      }
      return undefined;
    }
    if (value && typeof value === 'object') {
      for (const condition of CONDITIONS) {
        if (condition in value) {
          const found = pick(value[condition], dir, [...trail, condition]);
          if (found) return found;
        }
      }
    }
    return undefined;
  };

  /** @returns {Resolution} */
  const viaPackage = (pkg, specifier) => {
    const subpath = `.${specifier.slice(pkg.name.length)}`;
    const exportsField = pkg.exports;
    if (exportsField !== undefined && exportsField !== null) {
      const map =
        typeof exportsField === 'string' ||
        Array.isArray(exportsField) ||
        !Object.keys(exportsField).some((key) => key.startsWith('.'))
          ? { '.': exportsField }
          : exportsField;
      let entry = map[subpath];
      let star;
      if (entry === undefined) {
        for (const [key, value] of Object.entries(map)) {
          if (!key.includes('*')) continue;
          const [prefix, suffix] = key.split('*');
          if (subpath.startsWith(prefix) && subpath.endsWith(suffix ?? '')) {
            star = subpath.slice(prefix.length, subpath.length - (suffix ?? '').length);
            entry = JSON.parse(JSON.stringify(value).replaceAll('*', star));
            break;
          }
        }
      }
      if (entry === undefined)
        return { class: 'unresolved', package: pkg.name, reason: 'not-exported' };
      const found = pick(entry, pkg.dir);
      if (!found)
        return { class: 'unresolved', package: pkg.name, reason: 'export-target-not-tracked' };
      return {
        class: 'file',
        target: found.target,
        rule: `exports:${found.conditions.join('>') || 'string'}`,
        package: pkg.name,
      };
    }
    if (subpath === '.') {
      const main = pkg.main ? fileAt(posix.normalize(posix.join(pkg.dir, pkg.main))) : undefined;
      const fallback = main ?? fileAt(posix.join(pkg.dir, 'index'));
      if (fallback) return { ...fallback, rule: 'main', package: pkg.name };
      return { class: 'unresolved', package: pkg.name, reason: 'no-entry' };
    }
    const deep = fileAt(posix.normalize(posix.join(pkg.dir, subpath)));
    if (deep) return { ...deep, package: pkg.name };
    return { class: 'unresolved', package: pkg.name, reason: 'subpath-not-tracked' };
  };

  /**
   * @param {string} specifier
   * @param {string} importer repository-relative path of the importing file
   * @returns {Resolution}
   */
  return function resolve(specifier, importer) {
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
    if (pkg) return viaPackage(pkg, clean);
    return { class: 'external', package: name };
  };
}
