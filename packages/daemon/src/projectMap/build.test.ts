import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectMapSchema } from '@salidium/project-map';
import { afterAll, describe, expect, test } from 'vitest';
import { scratchRepository } from './__fixtures__/scratchRepository.ts';
import { DEFAULT_BOUNDS, globMatches } from './build.ts';
import { GitObjectReader, locateObjectStore } from './gitObjects.ts';
import { createResolver, type WorkspacePackage } from './resolve.ts';
import { scanSpecifiers } from './scan.ts';
import { trustedGit } from './service.ts';
import { mapFromObjectStore } from './source.ts';

const found = (source: string) =>
  scanSpecifiers(source).specifiers.map(({ specifier, kind }) => `${kind} ${specifier}`);

describe('scanSpecifiers', () => {
  test('reads every static form', () => {
    expect(
      found(`
        import a from './a.ts';
        import * as b from "./b.ts";
        import { c, d as e } from './c.ts';
        import './side.ts';
        export { f } from './f.ts';
        export * from './g.ts';
        export * as h from './h.ts';
        const i = await import('./i.ts');
        const j = require('./j.cjs');
        import data from './data.json' with { type: 'json' };
      `),
    ).toEqual([
      'import ./a.ts',
      'import ./b.ts',
      'import ./c.ts',
      'side-effect ./side.ts',
      'export-from ./f.ts',
      'export-from ./g.ts',
      'export-from ./h.ts',
      'dynamic ./i.ts',
      'require ./j.cjs',
      'import ./data.json',
    ]);
  });

  test('tells type-only imports apart', () => {
    expect(
      found(`
        import type { A } from './a.ts';
        import { type B, type C } from './b.ts';
        import { type D, e } from './d.ts';
        import type from './default-named-type.ts';
        export type { F } from './f.ts';
        let g: import('./g.ts').G;
        type H = typeof import('./h.ts');
        import('./i.ts').then((m) => m);
      `),
    ).toEqual([
      'import-type ./a.ts',
      'import-type ./b.ts',
      'import ./d.ts',
      'import ./default-named-type.ts',
      'export-type-from ./f.ts',
      'import-type ./g.ts',
      'import-type ./h.ts',
      'dynamic ./i.ts',
    ]);
  });

  test('ignores imports that are not code', () => {
    expect(
      found(`
        // import a from './comment.ts';
        /* import b from './block.ts'; */
        const s = "import c from './string.ts'";
        const t = \`import d from './template.ts' \${"x"} import e from './after.ts'\`;
        const r = /import f from '.\\/regex.ts'/g;
        const ratio = total / count; import g from './real.ts';
        const meta = import.meta.url;
        obj.import('./method.ts');
        export const local = 1;
        export { local as renamed };
      `),
    ).toEqual(['import ./real.ts']);
  });

  test('keeps code inside template substitutions', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source code under test.
    expect(found('const x = `${await import("./inner.ts")}`; import y from "./y.ts";')).toEqual([
      'dynamic ./inner.ts',
      'import ./y.ts',
    ]);
  });

  test('counts dynamic imports it cannot name', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source code under test.
    const result = scanSpecifiers('await import(name); await import(`./${name}.ts`);');
    expect(result.specifiers).toHaveLength(0);
    expect(result.dynamicWithoutLiteral).toBe(2);
  });
});

describe('createResolver', () => {
  const files = new Set([
    'src/a.ts',
    'src/b/index.ts',
    'packages/p/src/index.ts',
    'packages/p/src/extra.ts',
    'packages/q/package.json',
    'packages/r/src/index.ts',
    'packages/s/src/index.ts',
    'packages/s/src/index.cjs',
  ]);
  const pkg = (name: string, dir: string, exports: unknown): [string, WorkspacePackage] => [
    name,
    { name, dir, exports, main: undefined },
  ];
  const workspace = new Map([
    pkg('@x/p', 'packages/p', {
      '.': { development: './src/index.ts', default: './dist/index.js' },
      './*': { development: './src/*.ts' },
    }),
    pkg('@x/q', 'packages/q', { '.': './dist/index.js' }),
    // `default` first: Node takes it, so the development source is never reached.
    pkg('@x/r', 'packages/r', {
      '.': { default: './dist/index.js', development: './src/index.ts' },
    }),
    pkg('@x/s', 'packages/s', { '.': { require: './src/index.cjs', import: './src/index.ts' } }),
  ]);
  const resolve = createResolver(files, workspace);

  test('names the rule it used', () => {
    expect(resolve('./a.ts', 'src/main.ts')).toEqual({
      class: 'file',
      target: 'src/a.ts',
      rule: 'exact',
    });
    expect(resolve('./a.js', 'src/main.ts')).toMatchObject({ rule: 'ts-extension' });
    expect(resolve('./b', 'src/main.ts')).toMatchObject({
      target: 'src/b/index.ts',
      rule: 'probe',
    });
    expect(resolve('@x/p', 'src/main.ts')).toMatchObject({ rule: 'exports:development' });
    expect(resolve('@x/p/extra', 'src/main.ts')).toMatchObject({
      target: 'packages/p/src/extra.ts',
    });
  });

  test('reads exports conditions in the package key order, as Node does', () => {
    expect(resolve('@x/r', 'src/main.ts')).toEqual({
      class: 'unresolved',
      package: '@x/r',
      reason: 'export-target-not-tracked',
    });
    expect(resolve('@x/s', 'src/main.ts')).toMatchObject({
      target: 'packages/s/src/index.ts',
      rule: 'exports:import',
    });
    expect(resolve('@x/s', 'src/main.ts', 'require')).toMatchObject({
      target: 'packages/s/src/index.cjs',
      rule: 'exports:require',
    });
  });

  test('does not guess', () => {
    expect(resolve('./missing.ts', 'src/main.ts')).toMatchObject({ reason: 'no-tracked-file' });
    expect(resolve('../../outside.ts', 'src/main.ts')).toMatchObject({
      reason: 'outside-repository',
    });
    expect(resolve('@x/q', 'src/main.ts')).toMatchObject({ reason: 'export-target-not-tracked' });
    expect(resolve('node:fs', 'src/main.ts')).toEqual({ class: 'builtin', package: 'fs' });
    expect(resolve('@scope/pkg/deep', 'src/main.ts')).toEqual({
      class: 'external',
      package: '@scope/pkg',
    });
  });
});

describe('globMatches', () => {
  const match = (glob: string, path: string) => globMatches(glob.split('/'), path.split('/'));

  test('matches MSBuild-style globs', () => {
    expect(match('src/**/*.cs', 'src/a/b/C.cs')).toBe(true);
    expect(match('src/**/*.cs', 'src/C.cs')).toBe(true);
    expect(match('src/*.cs', 'src/a/C.cs')).toBe(false);
    expect(match('src/*Tests.cs', 'src/FooTests.cs')).toBe(true);
  });

  test('cannot be made to backtrack by a crafted pattern', () => {
    const started = performance.now();
    const glob = `${'**/'.repeat(30)}${'*a'.repeat(30)}b`;
    expect(match(glob, `${'x/'.repeat(60)}${'a'.repeat(200)}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('mapFromObjectStore', () => {
  const repo = scratchRepository();
  const scratch = mkdtempSync(join(tmpdir(), 'salidium-map-scratch-'));
  afterAll(() => {
    repo.remove();
    rmSync(scratch, { recursive: true, force: true });
  });
  repo.write('package.json', JSON.stringify({ name: 'root' }));
  repo.write(
    'packages/a/package.json',
    JSON.stringify({ name: '@t/a', exports: { '.': './src/index.ts' } }),
  );
  repo.write('packages/a/src/index.ts', "export { helper } from './helper.ts';\n");
  repo.write('packages/a/src/helper.ts', 'export const helper = 1;\n');
  repo.write('packages/a/src/helper.test.ts', "import { helper } from './helper.ts';\n");
  repo.write(
    'packages/b/package.json',
    JSON.stringify({ name: '@t/b', dependencies: { '@t/a': '*' } }),
  );
  repo.write('packages/b/src/main.ts', "import { helper } from '@t/a';\nimport './gone.ts';\n");
  repo.write('.gitignore', 'private/\n');
  repo.write('private/secret.ts', "import './packages/a/src/index.ts';\n");
  const first = repo.commit('first');

  const build = async (commit: string) => {
    const git = trustedGit(repo.dir);
    if (!git) throw new Error('git is required for these tests');
    const reader = new GitObjectReader({
      store: await locateObjectStore(repo.dir),
      scratch,
      git: git.command,
      path: git.path,
    });
    const map = await mapFromObjectStore({
      reader,
      root: repo.dir,
      commit,
      bounds: DEFAULT_BOUNDS,
    });
    if (!map) throw new Error('commit not found');
    return ProjectMapSchema.parse(map);
  };

  test('maps only the tracked tree, with observed edges and labelled inferences', async () => {
    const map = await build(first);
    expect(map.repository).toMatchObject({ root: repo.dir, commit: first });
    expect(map.repository.commitTime).toBe('2026-01-01T00:00:00.000Z');
    expect(map.indexer.git).toMatch(/^git version /);
    const paths = map.nodes.flatMap((n) => (n.kind === 'file' ? [n.path] : []));
    expect(paths.some((p) => p.startsWith('private/'))).toBe(false);
    const edge = (from: string, kind: string, to: string) =>
      map.edges.find((e) => e.from === from && e.kind === kind && e.to === to);
    expect(
      edge('file:packages/b/src/main.ts', 'imports', 'file:packages/a/src/index.ts'),
    ).toMatchObject({
      rule: 'exports:string',
      evidence: [{ path: 'packages/b/src/main.ts', line: 1 }],
    });
    expect(
      edge('file:packages/a/src/index.ts', 're-exports', 'file:packages/a/src/helper.ts'),
    ).toBeTruthy();
    expect(
      edge('module:package.json:packages/b', 'depends-on', 'module:package.json:packages/a'),
    ).toBeTruthy();
    expect(
      edge('module:package.json:packages/a', 'contains', 'file:packages/a/src/helper.ts'),
    ).toMatchObject({ evidence: [{ path: 'packages/a/package.json', line: null }] });
    expect(map.edges.every((e) => e.provenance === 'observed')).toBe(true);
    const testNode = map.nodes.find((n) => n.kind === 'file' && n.path.endsWith('helper.test.ts'));
    expect(testNode).toMatchObject({ role: { value: 'test', provenance: 'inferred' } });
    expect(map.coverage.unresolved.items.map((u) => [u.from, u.reference, u.reason])).toEqual([
      ['file:packages/b/src/main.ts', './gone.ts', 'no-tracked-file'],
    ]);
    expect(map.coverage.complete).toBe(true);
    expect(map.coverage.languages.find((l) => l.language === 'typescript')).toMatchObject({
      analysis: 'file-edges',
      parsed: 4,
    });
  });

  test('keeps node and edge ids stable across revisions', async () => {
    repo.write('packages/a/src/helper.ts', 'export const helper = 2;\n');
    const second = repo.commit('second');
    const before = await build(first);
    const after = await build(second);
    const ids = (m: typeof before) => m.edges.map((e) => e.id).sort();
    expect(ids(before)).toEqual(ids(after));
    const blob = (m: typeof before) =>
      m.nodes.find((n) => n.kind === 'file' && n.path === 'packages/a/src/helper.ts');
    expect(blob(before)).not.toEqual(blob(after));
  });
});
