/*
 * Builds an experimental project map from one Git revision: every tracked file, the modules its
 * manifests declare, and the dependency edges the sources and manifests state.
 *
 * Observed means "the tree at this revision says so": an import statement, a manifest dependency,
 * a project reference, the directory a manifest governs. Anything decided by a naming convention is
 * labelled inferred and carries the rule. Nothing here calls a model, and component names, data flow
 * and intent are deliberately absent: they are not in the tree.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { createResolver } from './resolve.mjs';
import { scanSpecifiers } from './scan.mjs';
import { listTree, readBlobs, resolveRevision } from './tree.mjs';

export const INDEXER = { name: 'salidium-project-map-experiment', version: '0.1.0' };

const SCRIPT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
/** Files larger than this are listed but not parsed; the count is reported. */
const MAX_PARSE_BYTES = 1024 * 1024;

const LANGUAGES = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  cs: 'csharp',
  json: 'json',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  css: 'css',
  html: 'html',
  shader: 'shaderlab',
  cginc: 'hlsl',
  meta: 'unity-meta',
  asset: 'unity-asset',
  unity: 'unity-scene',
  prefab: 'unity-prefab',
  mat: 'unity-material',
  asmdef: 'unity-asmdef',
  csproj: 'msbuild',
  props: 'msbuild',
};

const TEST_RULES = [
  {
    rule: 'name matches *.test.* or *.spec.*',
    test: (p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p),
  },
  {
    rule: 'under a tests, __tests__ or e2e directory',
    test: (p) => /(^|\/)(tests?|__tests__|e2e)\//.test(p),
  },
  { rule: 'in a project or assembly whose name ends in .Tests', test: (p) => /\.Tests\//.test(p) },
];

const edgeId = (from, kind, to) =>
  `e:${createHash('sha256').update(`${from}\0${kind}\0${to}`).digest('hex').slice(0, 16)}`;
const fileId = (path) => `file:${path}`;
const languageOf = (path) => LANGUAGES[posix.extname(path).slice(1).toLowerCase()] ?? 'other';

/** Nearest ancestor directory (including dir itself) that is a key of owners. */
function nearest(dir, owners) {
  let current = dir;
  for (;;) {
    if (owners.has(current)) return owners.get(current);
    if (current === '') return undefined;
    const parent = posix.dirname(current);
    current = parent === '.' ? '' : parent;
  }
}

/** Minimal MSBuild glob: `**` any depth, `*` within a segment. */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '(?:.*/)?';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * @param {string} repo a local Git repository
 * @param {string} revision any revision Git can resolve
 */
export function buildProjectMap(repo, revision) {
  const started = performance.now();
  const rev = resolveRevision(repo, revision);
  const entries = listTree(repo, rev.commit);
  const files = new Set(entries.map((e) => e.path));
  const byPath = new Map(entries.map((e) => [e.path, e]));

  const manifests = entries.filter(
    (e) => posix.basename(e.path) === 'package.json' || /\.(csproj|asmdef)$/.test(e.path),
  );
  const scripts = entries.filter(
    (e) => SCRIPT.test(e.path) && !DECLARATION.test(e.path) && e.bytes <= MAX_PARSE_BYTES,
  );
  const skippedLarge = entries.filter(
    (e) => SCRIPT.test(e.path) && e.bytes > MAX_PARSE_BYTES,
  ).length;
  const contents = readBlobs(
    repo,
    [...manifests, ...scripts].map((e) => e.blob),
  );
  const readMs = performance.now() - started;

  const nodes = new Map();
  const edges = new Map();
  const unresolved = [];
  const addEdge = (edge) => {
    const id = edgeId(edge.from, edge.kind, edge.to);
    const existing = edges.get(id);
    if (existing) {
      if (edge.evidence && existing.evidence.length < 8) existing.evidence.push(...edge.evidence);
      existing.count += 1;
      return;
    }
    edges.set(id, { id, ...edge, evidence: edge.evidence ?? [], count: 1 });
  };

  for (const entry of entries) {
    const test = TEST_RULES.find((r) => r.test(entry.path));
    nodes.set(fileId(entry.path), {
      id: fileId(entry.path),
      kind: 'file',
      path: entry.path,
      language: languageOf(entry.path),
      bytes: entry.bytes,
      blob: entry.blob,
      role: test ? { value: 'test', provenance: 'inferred', rule: test.rule } : null,
    });
  }

  // Modules: what each manifest declares and the files it governs.
  const npmOwners = new Map();
  const workspace = new Map();
  const asmdefOwners = new Map();
  const asmdefByName = new Map();
  const csprojects = [];
  const manifestErrors = [];
  for (const entry of manifests) {
    const dir = posix.dirname(entry.path) === '.' ? '' : posix.dirname(entry.path);
    const text = contents.get(entry.blob) ?? '';
    if (entry.path.endsWith('package.json')) {
      let manifest;
      try {
        manifest = JSON.parse(text);
      } catch {
        manifestErrors.push(entry.path);
        continue;
      }
      const id = `module:package.json:${dir || '.'}`;
      nodes.set(id, {
        id,
        kind: 'module',
        manifest: entry.path,
        name: typeof manifest.name === 'string' ? manifest.name : null,
        ecosystem: manifest.unity ? 'unity-package' : 'npm',
      });
      npmOwners.set(dir, id);
      if (typeof manifest.name === 'string')
        workspace.set(manifest.name, {
          name: manifest.name,
          dir,
          exports: manifest.exports,
          main: manifest.main,
          id,
          dependencies: {
            ...manifest.dependencies,
            ...manifest.devDependencies,
            ...manifest.peerDependencies,
          },
        });
    } else if (entry.path.endsWith('.asmdef')) {
      let manifest;
      try {
        manifest = JSON.parse(text);
      } catch {
        manifestErrors.push(entry.path);
        continue;
      }
      const id = `module:asmdef:${manifest.name}`;
      nodes.set(id, {
        id,
        kind: 'module',
        manifest: entry.path,
        name: manifest.name,
        ecosystem: 'unity-assembly',
      });
      asmdefOwners.set(dir, id);
      asmdefByName.set(manifest.name, {
        id,
        references: manifest.references ?? [],
        path: entry.path,
      });
    } else {
      const id = `module:csproj:${entry.path}`;
      const name = posix.basename(entry.path, '.csproj');
      nodes.set(id, { id, kind: 'module', manifest: entry.path, name, ecosystem: 'msbuild' });
      csprojects.push({ id, dir, path: entry.path, text, name });
    }
  }

  for (const entry of entries) {
    const dir = posix.dirname(entry.path) === '.' ? '' : posix.dirname(entry.path);
    const owner = nearest(dir, npmOwners);
    if (owner && !entry.path.endsWith('.cs'))
      addEdge({
        from: owner,
        to: fileId(entry.path),
        kind: 'contains',
        provenance: 'observed',
        rule: 'nearest package.json',
      });
    if (entry.path.endsWith('.cs')) {
      const assembly = nearest(dir, asmdefOwners);
      if (assembly)
        addEdge({
          from: assembly,
          to: fileId(entry.path),
          kind: 'contains',
          provenance: 'observed',
          rule: 'nearest .asmdef (Unity)',
        });
    }
  }

  for (const pkg of workspace.values()) {
    for (const dependency of Object.keys(pkg.dependencies)) {
      const target = workspace.get(dependency);
      if (target)
        addEdge({
          from: pkg.id,
          to: target.id,
          kind: 'depends-on',
          provenance: 'observed',
          rule: 'package.json dependency on a package in this tree',
        });
    }
  }
  for (const assembly of asmdefByName.values()) {
    for (const reference of assembly.references) {
      const target = asmdefByName.get(reference);
      if (target)
        addEdge({
          from: assembly.id,
          to: target.id,
          kind: 'depends-on',
          provenance: 'observed',
          rule: '.asmdef reference',
        });
      else
        unresolved.push({
          from: assembly.id,
          reference,
          reason: reference.startsWith('GUID:') ? 'guid-reference' : 'assembly-not-in-tree',
        });
    }
  }
  for (const project of csprojects) {
    const includes = [...project.text.matchAll(/<Compile\s+Include="([^"]+)"/g)].map((m) => m[1]);
    const defaults = !/<EnableDefaultCompileItems>\s*false\s*</i.test(project.text);
    const patterns = [
      ...includes.map((glob) =>
        globToRegExp(posix.normalize(posix.join(project.dir, glob.replaceAll('\\', '/')))),
      ),
      ...(defaults ? [globToRegExp(posix.join(project.dir, '**/*.cs'))] : []),
    ];
    for (const path of files) {
      if (!path.endsWith('.cs') || /(^|\/)(bin|obj)\//.test(path)) continue;
      if (patterns.some((p) => p.test(path)))
        addEdge({
          from: project.id,
          to: fileId(path),
          kind: 'compiles',
          provenance: 'observed',
          rule: defaults ? 'SDK default items and <Compile Include>' : '<Compile Include>',
        });
    }
    for (const m of project.text.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
      const target = posix.normalize(posix.join(project.dir, m[1].replaceAll('\\', '/')));
      if (byPath.has(target))
        addEdge({
          from: project.id,
          to: `module:csproj:${target}`,
          kind: 'depends-on',
          provenance: 'observed',
          rule: '<ProjectReference>',
        });
      else unresolved.push({ from: project.id, reference: m[1], reason: 'project-not-in-tree' });
    }
  }

  // File edges from what each script imports.
  const resolve = createResolver(files, workspace);
  const specifierKinds = {};
  let dynamicWithoutLiteral = 0;
  let parsedFiles = 0;
  const externals = new Map();
  for (const entry of scripts) {
    const source = contents.get(entry.blob);
    if (source === undefined) continue;
    parsedFiles += 1;
    const scanned = scanSpecifiers(source);
    dynamicWithoutLiteral += scanned.dynamicWithoutLiteral;
    for (const found of scanned.specifiers) {
      specifierKinds[found.kind] = (specifierKinds[found.kind] ?? 0) + 1;
      const resolved = resolve(found.specifier, entry.path);
      const evidence = [{ path: entry.path, line: found.line, specifier: found.specifier }];
      const kind =
        found.kind === 'import-type' || found.kind === 'export-type-from'
          ? 'imports-type'
          : found.kind === 'export-from'
            ? 're-exports'
            : found.kind === 'dynamic'
              ? 'imports-dynamic'
              : found.kind === 'require'
                ? 'requires'
                : 'imports';
      if (resolved.class === 'file') {
        let rule = resolved.rule;
        if (resolved.package) {
          // Node finds a workspace package only through a declared dependency (or itself).
          const own = [...workspace.values()].find(
            (p) =>
              p.id ===
              nearest(
                posix.dirname(entry.path) === '.' ? '' : posix.dirname(entry.path),
                npmOwners,
              ),
          );
          if (own && own.name !== resolved.package && !(resolved.package in own.dependencies))
            rule += ', undeclared';
        }
        addEdge({
          from: fileId(entry.path),
          to: fileId(resolved.target),
          kind,
          provenance: 'observed',
          rule,
          evidence,
        });
      } else if (resolved.class === 'external' || resolved.class === 'builtin') {
        const id = `${resolved.class === 'builtin' ? 'builtin' : 'package'}:${resolved.package}`;
        if (!nodes.has(id))
          nodes.set(id, {
            id,
            kind: resolved.class === 'builtin' ? 'builtin' : 'external-package',
            name: resolved.package,
          });
        externals.set(id, (externals.get(id) ?? 0) + 1);
        addEdge({
          from: fileId(entry.path),
          to: id,
          kind,
          provenance: 'observed',
          rule: resolved.class,
          evidence,
        });
      } else if (resolved.package && workspace.has(resolved.package)) {
        // A package of this tree whose entry is build output: the dependency is certain, the file
        // is not, so the edge stops at the module.
        addEdge({
          from: fileId(entry.path),
          to: workspace.get(resolved.package).id,
          kind,
          provenance: 'observed',
          rule: `workspace package, ${resolved.reason}`,
          evidence,
        });
        unresolved.push({
          from: fileId(entry.path),
          line: found.line,
          specifier: found.specifier,
          reason: resolved.reason,
          package: resolved.package,
          edgeTo: 'module',
        });
      } else {
        unresolved.push({
          from: fileId(entry.path),
          line: found.line,
          specifier: found.specifier,
          reason: resolved.reason,
          package: resolved.package,
        });
      }
    }
  }

  const edgeList = [...edges.values()];
  const fileEdgeKinds = new Set([
    'imports',
    'imports-type',
    're-exports',
    'imports-dynamic',
    'requires',
  ]);
  const internalFileEdges = edgeList.filter(
    (e) => fileEdgeKinds.has(e.kind) && e.to.startsWith('file:'),
  );
  const byLanguage = {};
  for (const entry of entries) {
    const language = languageOf(entry.path);
    byLanguage[language] ??= { files: 0, bytes: 0, parsed: 0, withModule: 0 };
    const row = byLanguage[language];
    row.files += 1;
    row.bytes += entry.bytes;
  }
  for (const entry of scripts) byLanguage[languageOf(entry.path)].parsed += 1;
  const governed = new Set(
    edgeList.filter((e) => e.kind === 'contains' || e.kind === 'compiles').map((e) => e.to),
  );
  for (const entry of entries)
    if (governed.has(fileId(entry.path))) byLanguage[languageOf(entry.path)].withModule += 1;
  const rules = {};
  for (const e of internalFileEdges) rules[e.rule] = (rules[e.rule] ?? 0) + 1;
  const reasons = {};
  for (const u of unresolved) reasons[u.reason] = (reasons[u.reason] ?? 0) + 1;

  const totalMs = performance.now() - started;
  return {
    format: 'salidium.project-map-experiment',
    version: 0,
    indexer: INDEXER,
    repository: { commit: rev.commit, tree: rev.tree, committedAt: rev.committedAt },
    coverage: {
      files: entries.length,
      bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
      byLanguage,
      scriptsParsed: parsedFiles,
      scriptsSkippedLarge: skippedLarge,
      specifierKinds,
      dynamicImportsWithoutLiteral: dynamicWithoutLiteral,
      internalFileEdges: internalFileEdges.length,
      internalFileEdgesByRule: rules,
      filesWithAnInternalEdge: new Set(internalFileEdges.flatMap((e) => [e.from, e.to])).size,
      externalPackages: [...externals.keys()].filter((k) => k.startsWith('package:')).length,
      unresolved: unresolved.length,
      unresolvedByReason: reasons,
      manifestErrors,
      notAnalyzed: [
        'C# type and namespace references between files (needs a compiler; only assembly and project membership are read)',
        'Unity scene, prefab and asset references by GUID',
        'shader includes, CSS imports, Markdown links',
        'package.json "imports" (#specifiers) and tsconfig "paths"',
        'dynamic imports whose specifier is not a literal',
      ],
    },
    cost: { readMs: Math.round(readMs), totalMs: Math.round(totalMs) },
    nodes: [...nodes.values()],
    edges: edgeList,
    unresolved,
  };
}
