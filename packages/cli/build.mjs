import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Builds the one thing that gets published.
 *
 * `salidium` is the only public package; `@salidium/core`, `protocol`, `daemon`, `adapter-kit` and
 * the adapters stay private and are bundled into it here. That is a deliberate choice about what
 * is promised: publishing them separately would make every export a public API to keep stable,
 * and none of them is designed to be depended on from outside yet. A single self-contained file
 * with no runtime dependencies is also the whole install for the user, which for a local-first
 * tool that watches your own machine is the right amount of supply chain.
 *
 * The built UI ships beside the bundle rather than inside it: it is static files the daemon
 * serves, and `defaultUiDist()` looks for `ui/` next to the running script.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const out = join(here, 'bundle');
const uiDist = join(here, '..', 'ui', 'dist');

if (!existsSync(join(uiDist, 'index.html')))
  throw new Error(`UI is not built (${uiDist}); run \`pnpm build\` first`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: [join(here, 'src', 'main.ts')],
  outfile: join(out, 'salidium.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Node built-ins only. Everything else — the workspace packages and zod — goes in the file.
  external: ['node:*'],
  legalComments: 'inline',
  metafile: true,
  // Type stripping is a development convenience; the published artifact is plain JS.
  loader: { '.ts': 'ts' },
});

/*
 * The entry keeps its own shebang, so esbuild emits it wherever that module lands in the bundle —
 * which is not line 1, and a `#!` anywhere else is a syntax error. Strip every one, then put a
 * single one back at the top. Done here rather than by deleting the shebang from `main.ts`,
 * because `dist/main.js` is still directly runnable in the workspace and should stay that way.
 */
const bundlePath = join(out, 'salidium.mjs');
const js = readFileSync(bundlePath, 'utf8').replace(/^#!.*\n/gm, '');
writeFileSync(bundlePath, `#!/usr/bin/env node\n${js}`, { mode: 0o755 });

cpSync(uiDist, join(out, 'ui'), { recursive: true });

/*
 * npm picks up README and LICENSE from the package directory only, and both live at the repo root
 * where they belong. Copied in at pack time and gitignored, so there is one copy under version
 * control and the published tarball still carries the licence it claims in its metadata.
 */
cpSync(join(repoRoot, 'LICENSE'), join(here, 'LICENSE'));

/*
 * The README's screenshots, made absolute on the way into the tarball.
 *
 * They are written as repository-relative paths because that is the form that works everywhere the
 * file is actually read as a file: on the repository page, in an editor's preview, on a branch, and
 * in a fork. npm resolves a relative path against `repository.directory`, which is `packages/cli`,
 * so the same paths there point at a directory that does not exist and every image is broken.
 */
const RAW = 'https://raw.githubusercontent.com/twinkling-reality/salidium/main/';
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
const absolute = readme.replaceAll(/(src|srcset)="(apps\/site\/public\/)/g, `$1="${RAW}$2`);
if (absolute === readme) throw new Error('README.md has no relative image paths left to rewrite');
writeFileSync(join(here, 'README.md'), absolute);

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
process.stdout.write(`salidium bundle: ${(bytes / 1024).toFixed(0)} KB + ui\n`);
