/*
 * Checks the scanner against an independent parser. esbuild parses every script of the revision
 * from memory and reports each import it would resolve; the scanner must find every one of them,
 * and whatever the scanner finds beyond them must be type-only, which esbuild erases.
 *
 * With --worktree, it also compares resolutions: esbuild resolves every relative and workspace
 * import against that checkout, which must be at the same revision with its dependencies
 * installed, and the result must name the same file the tree-only resolver chose.
 *
 *   node scripts/project-map/crosscheck.mjs <repository> <revision> [--worktree <checkout>]
 */
import { join, posix, relative } from 'node:path';
import * as esbuild from 'esbuild';
import { createResolver, packageName } from './resolve.mjs';
import { scanSpecifiers } from './scan.mjs';
import { listTree, readBlobs, resolveRevision } from './tree.mjs';

const [repo, revision] = process.argv.slice(2);
const { commit } = resolveRevision(repo, revision);
const scripts = listTree(repo, commit).filter(
  (e) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.path) && !/\.d\.[cm]?ts$/.test(e.path),
);
const contents = readBlobs(
  repo,
  scripts.map((e) => e.blob),
);
const source = new Map(scripts.map((e) => [e.path, contents.get(e.blob) ?? '']));

const seen = new Map(scripts.map((e) => [e.path, []]));
const failures = [];
for (const entry of scripts) {
  try {
    await esbuild.build({
      entryPoints: [`repo:${entry.path}`],
      bundle: true,
      write: false,
      logLevel: 'silent',
      platform: 'node',
      format: 'esm',
      // Keep imports whose bindings are unused, as verbatimModuleSyntax does; only `type` goes.
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      plugins: [
        {
          name: 'record',
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
              if (args.kind === 'entry-point')
                return { path: args.path.slice(5), namespace: 'repo' };
              seen.get(entry.path)?.push({ specifier: args.path, kind: args.kind });
              return { path: args.path, external: true };
            });
            build.onLoad({ filter: /.*/, namespace: 'repo' }, (args) => {
              const ext = posix.extname(args.path).slice(1);
              const loader = { mts: 'ts', cts: 'ts', mjs: 'js', cjs: 'js' }[ext] ?? ext;
              return { contents: source.get(args.path), loader };
            });
          },
        },
      ],
    });
  } catch (error) {
    failures.push({ path: entry.path, error: String(error).slice(0, 200) });
  }
}

let esbuildTotal = 0;
let matched = 0;
const missedByScanner = [];
const extraByKind = {};
const extraNotType = [];
for (const entry of scripts) {
  // esbuild resolves each specifier once per file, so compare sets, not occurrences.
  const ours = scanSpecifiers(source.get(entry.path) ?? '').specifiers;
  const theirs = new Set((seen.get(entry.path) ?? []).map((s) => s.specifier));
  for (const specifier of theirs) {
    esbuildTotal += 1;
    if (ours.some((o) => o.specifier === specifier)) matched += 1;
    else missedByScanner.push({ path: entry.path, specifier });
  }
  const extras = new Map();
  for (const o of ours) {
    if (theirs.has(o.specifier)) continue;
    const kinds = extras.get(o.specifier) ?? new Set();
    kinds.add(o.kind);
    extras.set(o.specifier, kinds);
  }
  for (const [specifier, kinds] of extras) {
    const typeOnly = [...kinds].every((k) => k === 'import-type' || k === 'export-type-from');
    const key = typeOnly ? 'type-only' : [...kinds].sort().join('+');
    extraByKind[key] = (extraByKind[key] ?? 0) + 1;
    if (!typeOnly) extraNotType.push({ path: entry.path, specifier, kinds: [...kinds] });
  }
}
const worktreeFlag = process.argv.indexOf('--worktree');
let resolution;
if (worktreeFlag > 0) resolution = await compareResolutions(process.argv[worktreeFlag + 1]);

process.stdout.write(
  `${JSON.stringify(
    {
      resolution,
      commit,
      scripts: scripts.length,
      esbuildFailures: failures,
      esbuildImports: esbuildTotal,
      foundByScanner: matched,
      missedByScanner,
      scannerExtrasByKind: extraByKind,
      scannerExtrasNotTypeOnly: extraNotType,
    },
    null,
    1,
  )}\n`,
);

async function compareResolutions(worktree) {
  const tree = listTree(repo, commit);
  const files = new Set(tree.map((e) => e.path));
  const workspace = new Map();
  for (const entry of tree.filter((e) => posix.basename(e.path) === 'package.json')) {
    const manifest = JSON.parse(readBlobs(repo, [entry.blob]).get(entry.blob) ?? '{}');
    if (typeof manifest.name === 'string')
      workspace.set(manifest.name, {
        name: manifest.name,
        dir: posix.dirname(entry.path) === '.' ? '' : posix.dirname(entry.path),
        exports: manifest.exports,
        main: manifest.main,
      });
  }
  const resolve = createResolver(files, workspace);
  const counts = { compared: 0, same: 0 };
  const differ = [];
  for (const entry of scripts) {
    const specifiers = new Set(
      scanSpecifiers(source.get(entry.path) ?? '').specifiers.map((s) => s.specifier),
    );
    for (const specifier of specifiers) {
      const ours = resolve(specifier, entry.path);
      if (ours.class !== 'file' && !workspace.has(packageName(specifier))) continue;
      let theirs;
      try {
        const result = await esbuild.build({
          stdin: {
            contents: `import ${JSON.stringify(specifier)};`,
            resolveDir: join(worktree, posix.dirname(entry.path)),
            loader: 'js',
          },
          bundle: true,
          write: false,
          metafile: true,
          logLevel: 'silent',
          platform: 'node',
          format: 'esm',
          conditions: ['development'],
          plugins: [
            {
              name: 'stop',
              setup(build) {
                build.onLoad({ filter: /.*/ }, (args) =>
                  args.path.endsWith('<stdin>') ? undefined : { contents: '', loader: 'js' },
                );
              },
            },
          ],
        });
        const input = Object.keys(result.metafile.inputs).find((k) => k !== '<stdin>');
        theirs = input ? relative(worktree, join(worktree, input)).split('\\').join('/') : null;
      } catch {
        theirs = null;
      }
      counts.compared += 1;
      if (ours.class === 'file' && ours.target === theirs) counts.same += 1;
      else
        differ.push({
          importer: entry.path,
          specifier,
          ours: ours.target ?? ours.reason,
          esbuild: theirs,
        });
    }
  }
  return { ...counts, differ };
}
