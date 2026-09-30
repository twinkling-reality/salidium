/*
 * The experiment's own checks. Not part of the product suite:
 *
 *   node --test scripts/project-map/project-map.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { buildProjectMap } from './build.mjs';
import { createResolver } from './resolve.mjs';
import { scanSpecifiers } from './scan.mjs';

const found = (source) =>
  scanSpecifiers(source).specifiers.map(({ specifier, kind }) => `${kind} ${specifier}`);

describe('scanSpecifiers', () => {
  test('reads every static form', () => {
    assert.deepEqual(
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
      [
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
      ],
    );
  });

  test('tells type-only imports apart', () => {
    assert.deepEqual(
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
      [
        'import-type ./a.ts',
        'import-type ./b.ts',
        'import ./d.ts',
        'import ./default-named-type.ts',
        'export-type-from ./f.ts',
        'import-type ./g.ts',
        'import-type ./h.ts',
        'dynamic ./i.ts',
      ],
    );
  });

  test('ignores imports that are not code', () => {
    assert.deepEqual(
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
      ['import ./real.ts'],
    );
  });

  test('keeps code inside template substitutions', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source code under test.
    assert.deepEqual(found('const x = `${await import("./inner.ts")}`; import y from "./y.ts";'), [
      'dynamic ./inner.ts',
      'import ./y.ts',
    ]);
  });

  test('counts dynamic imports it cannot name', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source code under test.
    const result = scanSpecifiers('await import(name); await import(`./${name}.ts`);');
    assert.equal(result.specifiers.length, 0);
    assert.equal(result.dynamicWithoutLiteral, 2);
  });
});

describe('createResolver', () => {
  const files = new Set([
    'src/a.ts',
    'src/b/index.ts',
    'packages/p/src/index.ts',
    'packages/p/src/extra.ts',
    'packages/q/package.json',
  ]);
  const workspace = new Map([
    [
      '@x/p',
      {
        name: '@x/p',
        dir: 'packages/p',
        exports: {
          '.': { development: './src/index.ts', default: './dist/index.js' },
          './*': { development: './src/*.ts' },
        },
      },
    ],
    ['@x/q', { name: '@x/q', dir: 'packages/q', exports: { '.': './dist/index.js' } }],
  ]);
  const resolve = createResolver(files, workspace);

  test('names the rule it used', () => {
    assert.deepEqual(resolve('./a.ts', 'src/main.ts'), {
      class: 'file',
      target: 'src/a.ts',
      rule: 'exact',
    });
    assert.equal(resolve('./a.js', 'src/main.ts').rule, 'ts-extension');
    assert.equal(resolve('./b', 'src/main.ts').target, 'src/b/index.ts');
    assert.equal(resolve('./b', 'src/main.ts').rule, 'probe');
    assert.equal(resolve('@x/p', 'src/main.ts').rule, 'exports:development');
    assert.equal(resolve('@x/p/extra', 'src/main.ts').target, 'packages/p/src/extra.ts');
  });

  test('does not guess', () => {
    assert.equal(resolve('./missing.ts', 'src/main.ts').reason, 'no-tracked-file');
    assert.equal(resolve('../../outside.ts', 'src/main.ts').reason, 'outside-repository');
    assert.equal(resolve('@x/q', 'src/main.ts').reason, 'export-target-not-tracked');
    assert.deepEqual(resolve('node:fs', 'src/main.ts'), { class: 'builtin', package: 'fs' });
    assert.deepEqual(resolve('@scope/pkg/deep', 'src/main.ts'), {
      class: 'external',
      package: '@scope/pkg',
    });
  });
});

describe('buildProjectMap', () => {
  const repo = mkdtempSync(join(tmpdir(), 'project-map-test-'));
  after(() => rmSync(repo, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  write('package.json', JSON.stringify({ name: 'root' }));
  write(
    'packages/a/package.json',
    JSON.stringify({ name: '@t/a', exports: { '.': './src/index.ts' } }),
  );
  write('packages/a/src/index.ts', "export { helper } from './helper.ts';\n");
  write('packages/a/src/helper.ts', 'export const helper = 1;\n');
  write('packages/a/src/helper.test.ts', "import { helper } from './helper.ts';\n");
  write('packages/b/package.json', JSON.stringify({ name: '@t/b', dependencies: { '@t/a': '*' } }));
  write('packages/b/src/main.ts', "import { helper } from '@t/a';\nimport './gone.ts';\n");
  write('.gitignore', 'private/\n');
  write('private/secret.ts', "import './packages/a/src/index.ts';\n");
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const first = git('rev-parse', 'HEAD');

  test('maps only the tracked tree, with observed edges and labelled inferences', () => {
    const map = buildProjectMap(repo, first);
    assert.equal(map.repository.commit, first);
    const paths = map.nodes.filter((n) => n.kind === 'file').map((n) => n.path);
    assert.ok(!paths.some((p) => p.startsWith('private/')));
    const edge = (from, kind, to) =>
      map.edges.find((e) => e.from === from && e.kind === kind && e.to === to);
    assert.ok(edge('file:packages/b/src/main.ts', 'imports', 'file:packages/a/src/index.ts'));
    assert.ok(edge('file:packages/a/src/index.ts', 're-exports', 'file:packages/a/src/helper.ts'));
    assert.ok(
      edge('module:package.json:packages/b', 'depends-on', 'module:package.json:packages/a'),
    );
    assert.ok(edge('module:package.json:packages/a', 'contains', 'file:packages/a/src/helper.ts'));
    assert.ok(map.edges.every((e) => e.provenance === 'observed'));
    const test = map.nodes.find((n) => n.path === 'packages/a/src/helper.test.ts');
    assert.equal(test.role.provenance, 'inferred');
    assert.deepEqual(
      map.unresolved.map((u) => [u.from, u.specifier, u.reason]),
      [['file:packages/b/src/main.ts', './gone.ts', 'no-tracked-file']],
    );
  });

  test('keeps node and edge ids stable across revisions', () => {
    write('packages/a/src/helper.ts', 'export const helper = 2;\n');
    git('commit', '-q', '-am', 'second');
    const before = buildProjectMap(repo, first);
    const afterMap = buildProjectMap(repo, 'HEAD');
    const ids = (m) => m.edges.map((e) => e.id).sort();
    assert.deepEqual(ids(before), ids(afterMap));
    const blob = (m) => m.nodes.find((n) => n.path === 'packages/a/src/helper.ts').blob;
    assert.notEqual(blob(before), blob(afterMap));
  });
});
