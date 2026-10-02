import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  type BoundName,
  type Coverage,
  type EdgeKind,
  FILE_EDGE_KINDS,
  type FileNode,
  fileNodeId,
  hasUnprintable,
  type MapEdge,
  type MapNode,
  PROJECT_MAP_LIMITS,
  type ProjectMap,
  printable,
} from '@salidium/project-map';
import { createResolver, type WorkspacePackage } from './resolve.ts';
import { type SpecifierKind, scanSpecifiers } from './scan.ts';

/*
 * Builds a `salidium.project-map` v0 document from one commit's tree: every tracked file, the
 * modules its manifests declare, and the dependency edges sources and manifests state.
 *
 * Observed means "the tree at this commit says so": an import statement, a manifest dependency, a
 * project reference, the directory a manifest governs. Anything decided by a naming convention is
 * labelled inferred and carries its rule. Nothing here calls a model or reads a file system; the
 * caller supplies the tree and a reader for blob contents, so the same function serves the daemon,
 * the CLI and the tests. Ported from the validation prototype in scripts/project-map/.
 */

export const INDEXER_VERSION = '0.1.0';

export interface MapBounds {
  /** Tree entries. Over this the map is refused. */
  files: number;
  /** A blob larger than this is listed and not read. */
  blobBytes: number;
  /** Bytes read in total. Past it, remaining files are listed and not read. */
  totalBytes: number;
  nodes: number;
  edges: number;
}

export const DEFAULT_BOUNDS: MapBounds = {
  files: 20_000,
  blobBytes: 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  nodes: PROJECT_MAP_LIMITS.nodes,
  edges: PROJECT_MAP_LIMITS.edges,
};

/** A build that would exceed a bound this version refuses rather than truncates. */
export class MapOverBound extends Error {
  readonly bound: BoundName;
  constructor(bound: BoundName, message: string) {
    super(message);
    this.bound = bound;
  }
}

export interface BlobEntry {
  path: string;
  mode: string;
  oid: string;
  /** From the object header; null when the store does not hold the blob. */
  bytes: number | null;
}

export interface BuildInput {
  root: string;
  commit: string;
  tree: string;
  commitTime: string;
  git: string;
  /** Blob entries of the tree, in tree order. */
  blobs: readonly BlobEntry[];
  /** Paths of submodule entries (gitlinks). */
  submodules: readonly string[];
  /** Reads blobs whose sizes are known. Objects it cannot read are simply absent. */
  read: (objects: readonly { oid: string; bytes: number }[]) => Promise<Map<string, Buffer>>;
  bounds?: MapBounds;
  now?: () => number;
  /** Wall-clock budget for the build after its reads; past it the map is refused. */
  deadlineMs?: number;
}

const SCRIPT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const SYMLINK_MODE = '120000';
const MAX_SPECIFIER = 512;
const MAX_INCLUDES_PER_PROJECT = 64;
const MAX_REFERENCES = 256;
const MAX_GLOB_SEGMENTS = 16;
/** Work between two yields to the event loop, and the default wall-clock budget of a build. */
const SLICE_MS = 10;
export const DEFAULT_BUILD_DEADLINE_MS = 30_000;

const LANGUAGES: Record<string, string> = {
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

const TEST_RULES: { rule: string; test: (path: string) => boolean }[] = [
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

const NOT_ANALYZED: Coverage['notAnalyzed'] = [
  {
    subject: 'C# references between files',
    reason:
      'Version 0 reads C# at assembly level only: which .asmdef or .csproj holds a file, and which assemblies depend on which.',
  },
  {
    subject: 'Unity scene, prefab and asset references',
    reason: 'They are GUID references in serialized assets, which this version does not read.',
  },
  {
    subject: 'Shader includes, CSS imports and Markdown links',
    reason: 'Only JavaScript and TypeScript sources are scanned for references.',
  },
  {
    subject: 'package.json "imports" (#specifiers) and tsconfig "paths"',
    reason: 'Specifiers that need them are listed as unresolved, never guessed.',
  },
  {
    subject: 'Dynamic imports whose specifier is not a literal',
    reason: 'They are counted in dynamicImportsWithoutLiteral, not resolved.',
  },
  {
    subject: 'Submodule contents',
    reason: 'A submodule is another repository; its commit is listed, not mapped.',
  },
  {
    subject: 'Components, responsibilities and data flow',
    reason: 'They are not in the tree; producing them would need a model, which a map never calls.',
  },
];

export function edgeId(from: string, kind: EdgeKind, to: string): string {
  return `e:${createHash('sha256').update(`${from}\0${kind}\0${to}`).digest('hex').slice(0, 16)}`;
}

const languageOf = (path: string): string =>
  LANGUAGES[posix.extname(path).slice(1).toLowerCase()] ?? 'other';
const dirOf = (path: string): string => {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
};
const canonical = (path: string): boolean =>
  path.length > 0 && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
const clip = (text: string, max: number): string => printable(text).slice(0, max);

/** Nearest ancestor directory (including dir itself) that is a key of owners. */
function nearest<T>(dir: string, owners: ReadonlyMap<string, T>): T | undefined {
  let current = dir;
  for (;;) {
    const owner = owners.get(current);
    if (owner !== undefined) return owner;
    if (current === '') return undefined;
    current = dirOf(current);
  }
}

/**
 * Minimal MSBuild glob match, `**` any number of segments and `*` within one, without regular
 * expressions: globs come from the repository, and a crafted pattern must not be able to make the
 * daemon backtrack. Segment matching is linear and the segment walk is memoized.
 */
export function globMatches(glob: readonly string[], path: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const walk = (g: number, p: number): boolean => {
    const key = g * (path.length + 1) + p;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (g === glob.length) result = p === path.length;
    else if (glob[g] === '**') result = walk(g + 1, p) || (p < path.length && walk(g, p + 1));
    else
      result =
        p < path.length && segmentMatches(glob[g] ?? '', path[p] ?? '') && walk(g + 1, p + 1);
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
}

/** `*` within one segment, by the standard greedy algorithm with one backtrack point. */
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      mark = t;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

function edgeKindOf(kind: SpecifierKind): EdgeKind {
  if (kind === 'import-type' || kind === 'export-type-from') return 'imports-type';
  if (kind === 'export-from') return 're-exports';
  if (kind === 'dynamic') return 'imports-dynamic';
  if (kind === 'require') return 'requires';
  return 'imports';
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.replace(/^﻿/, ''));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const cleanName = (value: unknown): string | null =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= PROJECT_MAP_LIMITS.nameLength &&
  !hasUnprintable(value)
    ? value
    : null;

export async function buildProjectMap(input: BuildInput): Promise<ProjectMap> {
  const bounds = input.bounds ?? DEFAULT_BOUNDS;
  const now = input.now ?? Date.now;
  const boundsReached = new Set<BoundName>();
  // Crafted input must not hold the daemon's thread: the build yields every few milliseconds and
  // is refused once its wall-clock budget is spent.
  const deadline = performance.now() + (input.deadlineMs ?? DEFAULT_BUILD_DEADLINE_MS);
  let slice = performance.now();
  const overTime = () =>
    new MapOverBound('build-time', 'building the map took longer than its time bound');
  const pace = async (): Promise<void> => {
    const at = performance.now();
    if (at - slice < SLICE_MS) return;
    if (at > deadline) throw overTime();
    await new Promise<void>((resolve) => setImmediate(resolve));
    slice = performance.now();
  };

  // Which entries become nodes.
  const omitted = { 'path-too-long': 0, 'path-control-characters': 0, 'path-not-canonical': 0 };
  const entries: BlobEntry[] = [];
  for (const blob of input.blobs) {
    if (hasUnprintable(blob.path)) omitted['path-control-characters'] += 1;
    else if (!canonical(blob.path)) omitted['path-not-canonical'] += 1;
    else if (blob.path.length > PROJECT_MAP_LIMITS.pathLength) omitted['path-too-long'] += 1;
    else entries.push(blob);
  }
  if (omitted['path-too-long'] > 0) boundsReached.add('path-length');
  if (input.blobs.length + input.submodules.length > bounds.files)
    throw new MapOverBound('files', `the tree has more than ${bounds.files} entries`);

  const files = new Set(entries.map((e) => e.path));
  const isSymlink = (e: BlobEntry) => e.mode === SYMLINK_MODE;
  const readable = (e: BlobEntry) =>
    !isSymlink(e) && e.bytes !== null && e.bytes <= bounds.blobBytes;

  // What is read, in a deterministic order: manifests first, then scripts, by path.
  const manifests = entries.filter(
    (e) =>
      !isSymlink(e) &&
      (posix.basename(e.path) === 'package.json' || /\.(csproj|asmdef)$/.test(e.path)),
  );
  const scriptCandidates = entries.filter((e) => SCRIPT.test(e.path) && !DECLARATION.test(e.path));
  const toRead: BlobEntry[] = [];
  const overBudget = new Set<string>();
  let budget = bounds.totalBytes;
  for (const entry of [...manifests, ...scriptCandidates.filter(readable)]) {
    if (!readable(entry)) continue;
    const bytes = entry.bytes ?? 0;
    if (bytes > budget) {
      overBudget.add(entry.path);
      boundsReached.add('total-bytes');
      continue;
    }
    budget -= bytes;
    toRead.push(entry);
  }
  if (scriptCandidates.some((e) => !isSymlink(e) && e.bytes !== null && e.bytes > bounds.blobBytes))
    boundsReached.add('blob-bytes');
  const blobs = await input.read(toRead.map((e) => ({ oid: e.oid, bytes: e.bytes ?? 0 })));
  const contentOf = (entry: BlobEntry): string | undefined =>
    blobs.get(entry.oid)?.toString('utf8');

  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();
  const unresolved: Coverage['unresolved']['items'] = [];
  let unresolvedTotal = 0;
  const unresolvedReasons = new Map<string, number>();
  const addUnresolved = (item: Coverage['unresolved']['items'][number]) => {
    unresolvedTotal += 1;
    unresolvedReasons.set(item.reason, (unresolvedReasons.get(item.reason) ?? 0) + 1);
    if (unresolved.length < PROJECT_MAP_LIMITS.unresolvedItems) unresolved.push(item);
    else boundsReached.add('unresolved-items');
  };
  const addNode = (node: MapNode) => {
    if (nodes.has(node.id)) return;
    if (nodes.size >= bounds.nodes)
      throw new MapOverBound('nodes', `the map would have more than ${bounds.nodes} nodes`);
    nodes.set(node.id, node);
  };
  const addEdge = (
    edge: Omit<MapEdge, 'id' | 'evidence' | 'count'>,
    evidence: MapEdge['evidence'][number],
  ) => {
    const id = edgeId(edge.from, edge.kind, edge.to);
    const existing = edges.get(id);
    if (existing) {
      if (existing.evidence.length < PROJECT_MAP_LIMITS.evidencePerEdge)
        existing.evidence.push(evidence);
      existing.count += 1;
      return;
    }
    if (edges.size >= bounds.edges)
      throw new MapOverBound('edges', `the map would have more than ${bounds.edges} edges`);
    edges.set(id, { id, ...edge, evidence: [evidence], count: 1 });
  };

  for (const entry of entries) {
    await pace();
    const test = TEST_RULES.find((r) => r.test(entry.path));
    const node: FileNode = {
      id: fileNodeId(entry.path),
      kind: 'file',
      path: entry.path,
      entry: isSymlink(entry) ? 'symlink' : entry.mode === '100755' ? 'executable' : 'file',
      language: languageOf(entry.path),
      bytes: entry.bytes,
      blob: entry.oid,
      role: test ? { value: 'test', provenance: 'inferred', rule: test.rule } : null,
    };
    addNode(node);
  }

  // Modules: what each manifest declares and the files it governs.
  const npmOwners = new Map<string, string>();
  const workspace = new Map<string, WorkspacePackage & { id: string; dependencies: Set<string> }>();
  const packageByModule = new Map<string, string>();
  const asmdefOwners = new Map<string, string>();
  const asmdefByName = new Map<string, { id: string; references: string[]; path: string }>();
  const csprojects: { id: string; dir: string; path: string; text: string }[] = [];
  const manifestErrors: string[] = [];
  for (const entry of manifests) {
    await pace();
    const dir = dirOf(entry.path);
    const text = contentOf(entry);
    if (text === undefined) {
      // Too large, over budget or missing: the module is unknown, so say so.
      manifestErrors.push(entry.path);
      continue;
    }
    if (entry.path.endsWith('package.json')) {
      const manifest = parseJson(text);
      if (!manifest) {
        manifestErrors.push(entry.path);
        continue;
      }
      const id = `module:package.json:${dir || '.'}`;
      const name = cleanName(manifest.name);
      addNode({
        id,
        kind: 'module',
        manifest: entry.path,
        name,
        ecosystem: manifest.unity ? 'unity-package' : 'npm',
      });
      npmOwners.set(dir, id);
      if (name) {
        const dependencies = new Set<string>();
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
          const value = manifest[field];
          if (value && typeof value === 'object' && !Array.isArray(value))
            for (const key of Object.keys(value)) dependencies.add(key);
        }
        workspace.set(name, {
          name,
          dir,
          exports: manifest.exports,
          main: typeof manifest.main === 'string' ? manifest.main : undefined,
          id,
          dependencies,
        });
        packageByModule.set(id, name);
      }
    } else if (entry.path.endsWith('.asmdef')) {
      const manifest = parseJson(text);
      const name = cleanName(manifest?.name);
      if (!manifest || !name) {
        manifestErrors.push(entry.path);
        continue;
      }
      const id = `module:asmdef:${name}`;
      addNode({ id, kind: 'module', manifest: entry.path, name, ecosystem: 'unity-assembly' });
      asmdefOwners.set(dir, id);
      const references = Array.isArray(manifest.references)
        ? manifest.references
            .filter((r): r is string => typeof r === 'string')
            .slice(0, MAX_REFERENCES)
        : [];
      asmdefByName.set(name, { id, references, path: entry.path });
    } else {
      const id = `module:csproj:${entry.path}`;
      const name = cleanName(posix.basename(entry.path, '.csproj'));
      addNode({ id, kind: 'module', manifest: entry.path, name, ecosystem: 'msbuild' });
      csprojects.push({ id, dir, path: entry.path, text });
    }
  }

  const manifestOf = new Map<string, string>();
  for (const node of nodes.values())
    if (node.kind === 'module') manifestOf.set(node.id, node.manifest);
  const manifestEvidence = (moduleId: string) => ({
    path: manifestOf.get(moduleId) ?? '',
    line: null,
  });

  for (const entry of entries) {
    await pace();
    const dir = dirOf(entry.path);
    if (entry.path.endsWith('.cs')) {
      const assembly = nearest(dir, asmdefOwners);
      if (assembly)
        addEdge(
          {
            from: assembly,
            to: fileNodeId(entry.path),
            kind: 'contains',
            provenance: 'observed',
            rule: 'nearest .asmdef (Unity)',
          },
          manifestEvidence(assembly),
        );
      continue;
    }
    const owner = nearest(dir, npmOwners);
    if (owner)
      addEdge(
        {
          from: owner,
          to: fileNodeId(entry.path),
          kind: 'contains',
          provenance: 'observed',
          rule: 'nearest package.json',
        },
        manifestEvidence(owner),
      );
  }

  for (const pkg of workspace.values()) {
    for (const dependency of pkg.dependencies) {
      const target = workspace.get(dependency);
      if (target)
        addEdge(
          {
            from: pkg.id,
            to: target.id,
            kind: 'depends-on',
            provenance: 'observed',
            rule: 'package.json dependency on a package in this tree',
          },
          manifestEvidence(pkg.id),
        );
    }
  }
  for (const assembly of asmdefByName.values()) {
    for (const reference of assembly.references) {
      const target = asmdefByName.get(reference);
      if (target)
        addEdge(
          {
            from: assembly.id,
            to: target.id,
            kind: 'depends-on',
            provenance: 'observed',
            rule: '.asmdef reference',
          },
          manifestEvidence(assembly.id),
        );
      else
        addUnresolved({
          from: assembly.id,
          line: null,
          reference: clip(reference, MAX_SPECIFIER),
          reason: reference.startsWith('GUID:') ? 'guid-reference' : 'assembly-not-in-tree',
          package: null,
          edgeTo: 'none',
        });
    }
  }
  const csFiles = entries
    .filter((e) => e.path.endsWith('.cs') && !/(^|\/)(bin|obj)\//.test(e.path))
    .map((e) => e.path);
  const csprojPaths = new Set(csprojects.map((p) => p.path));
  for (const project of csprojects) {
    const includes = [...project.text.matchAll(/<Compile\s+Include="([^"]{1,512})"/g)].map(
      (m) => m[1] ?? '',
    );
    for (const extra of includes.slice(MAX_INCLUDES_PER_PROJECT))
      addUnresolved({
        from: project.id,
        line: null,
        reference: clip(extra, MAX_SPECIFIER),
        reason: 'too-many-compile-includes',
        package: null,
        edgeTo: 'none',
      });
    const defaults = !/<EnableDefaultCompileItems>\s*false\s*</i.test(project.text);
    const patterns: string[][] = [];
    for (const glob of includes
      .slice(0, MAX_INCLUDES_PER_PROJECT)
      .map((include) => posix.normalize(posix.join(project.dir, include.replaceAll('\\', '/'))))
      .concat(defaults ? [posix.join(project.dir, '**/*.cs')] : [])) {
      // `**/**` means what `**` means; collapsing it keeps the match linear in practice.
      const segments = glob
        .split('/')
        .filter((part, i, all) => part !== '**' || all[i - 1] !== '**');
      if (segments.length > MAX_GLOB_SEGMENTS) {
        boundsReached.add('glob-complexity');
        addUnresolved({
          from: project.id,
          line: null,
          reference: clip(glob, MAX_SPECIFIER),
          reason: 'compile-include-too-complex',
          package: null,
          edgeTo: 'none',
        });
      } else patterns.push(segments);
    }
    for (const path of csFiles) {
      await pace();
      const segments = path.split('/');
      if (patterns.some((pattern) => globMatches(pattern, segments)))
        addEdge(
          {
            from: project.id,
            to: fileNodeId(path),
            kind: 'compiles',
            provenance: 'observed',
            rule: defaults ? 'SDK default items and <Compile Include>' : '<Compile Include>',
          },
          { path: project.path, line: null },
        );
    }
    for (const m of project.text.matchAll(/<ProjectReference\s+Include="([^"]{1,512})"/g)) {
      const reference = m[1] ?? '';
      const target = posix.normalize(posix.join(project.dir, reference.replaceAll('\\', '/')));
      if (csprojPaths.has(target))
        addEdge(
          {
            from: project.id,
            to: `module:csproj:${target}`,
            kind: 'depends-on',
            provenance: 'observed',
            rule: '<ProjectReference>',
          },
          { path: project.path, line: null },
        );
      else
        addUnresolved({
          from: project.id,
          line: null,
          reference: clip(reference, MAX_SPECIFIER),
          reason: 'project-not-in-tree',
          package: null,
          edgeTo: 'none',
        });
    }
  }

  // File edges from what each script imports.
  const resolve = createResolver(files, workspace);
  const specifierKinds: Coverage['specifierKinds'] = {
    import: 0,
    importType: 0,
    sideEffect: 0,
    exportFrom: 0,
    exportTypeFrom: 0,
    dynamic: 0,
    require: 0,
  };
  const kindKey: Record<SpecifierKind, keyof Coverage['specifierKinds']> = {
    import: 'import',
    'import-type': 'importType',
    'side-effect': 'sideEffect',
    'export-from': 'exportFrom',
    'export-type-from': 'exportTypeFrom',
    dynamic: 'dynamic',
    require: 'require',
  };
  let dynamicWithoutLiteral = 0;
  const parsed = new Set<string>();
  for (const entry of scriptCandidates) {
    await pace();
    if (!readable(entry) || overBudget.has(entry.path)) continue;
    const source = contentOf(entry);
    if (source === undefined) continue;
    parsed.add(entry.path);
    const from = fileNodeId(entry.path);
    const owner = workspace.get(
      packageByModule.get(nearest(dirOf(entry.path), npmOwners) ?? '') ?? '',
    );
    const scanned = scanSpecifiers(source);
    dynamicWithoutLiteral += scanned.dynamicWithoutLiteral;
    if (scanned.incomplete) {
      boundsReached.add('scan-steps');
      addUnresolved({
        from,
        line: null,
        reference: '',
        reason: 'scan-budget',
        package: null,
        edgeTo: 'none',
      });
    }
    for (const found of scanned.specifiers) {
      await pace();
      specifierKinds[kindKey[found.kind]] += 1;
      const kind = edgeKindOf(found.kind);
      const evidence = { path: entry.path, line: found.line };
      if (found.specifier.length > MAX_SPECIFIER || hasUnprintable(found.specifier)) {
        addUnresolved({
          from,
          line: found.line,
          reference: clip(found.specifier, MAX_SPECIFIER),
          reason: 'specifier-invalid',
          package: null,
          edgeTo: 'none',
        });
        continue;
      }
      const resolved = resolve(
        found.specifier,
        entry.path,
        kind === 'requires' ? 'require' : 'import',
      );
      if (resolved.class === 'file') {
        let rule = resolved.rule;
        // Node finds a workspace package only through a declared dependency (or itself).
        if (
          resolved.package &&
          owner &&
          owner.name !== resolved.package &&
          !owner.dependencies.has(resolved.package)
        )
          rule += ', undeclared';
        addEdge(
          { from, to: fileNodeId(resolved.target), kind, provenance: 'observed', rule },
          evidence,
        );
      } else if (resolved.class === 'external' || resolved.class === 'builtin') {
        const name = cleanName(resolved.package);
        if (!name) {
          addUnresolved({
            from,
            line: found.line,
            reference: clip(found.specifier, MAX_SPECIFIER),
            reason: 'specifier-invalid',
            package: null,
            edgeTo: 'none',
          });
          continue;
        }
        const builtin = resolved.class === 'builtin';
        const id = `${builtin ? 'builtin' : 'package'}:${name}`;
        addNode({ id, kind: builtin ? 'builtin' : 'external-package', name });
        addEdge({ from, to: id, kind, provenance: 'observed', rule: resolved.class }, evidence);
      } else {
        if (resolved.reason === 'exports-too-large') boundsReached.add('exports-size');
        const pkg = resolved.package ? workspace.get(resolved.package) : undefined;
        if (pkg)
          // A package of this tree whose entry is build output: the dependency is certain, the
          // file is not, so the edge stops at the module.
          addEdge(
            {
              from,
              to: pkg.id,
              kind,
              provenance: 'observed',
              rule: `workspace package, ${resolved.reason}`,
            },
            evidence,
          );
        addUnresolved({
          from,
          line: found.line,
          reference: clip(found.specifier, MAX_SPECIFIER),
          reason: resolved.reason,
          package: resolved.package ?? null,
          edgeTo: pkg ? 'module' : 'none',
        });
      }
    }
  }

  // A step between two yields that ran long still ends the build: the bound is the whole build.
  if (performance.now() > deadline) throw overTime();

  // Coverage.
  const edgeList = [...edges.values()];
  const fileEdgeKinds = new Set<EdgeKind>(FILE_EDGE_KINDS);
  const internalFileEdges = edgeList.filter(
    (e) => fileEdgeKinds.has(e.kind) && e.to.startsWith('file:'),
  ).length;
  const governed = new Set(
    edgeList.filter((e) => e.kind === 'contains' || e.kind === 'compiles').map((e) => e.to),
  );
  const languages = new Map<string, Coverage['languages'][number]>();
  let missing = 0;
  for (const entry of entries) {
    const language = languageOf(entry.path);
    let row = languages.get(language);
    if (!row) {
      row = {
        language,
        analysis:
          language === 'typescript' || language === 'javascript'
            ? 'file-edges'
            : language === 'csharp'
              ? 'assembly-membership'
              : 'none',
        files: 0,
        bytes: 0,
        parsed: 0,
        notParsed: { tooLarge: 0, overBudget: 0, declaration: 0, symlink: 0, missing: 0 },
        withModule: 0,
      };
      languages.set(language, row);
    }
    row.files += 1;
    row.bytes += entry.bytes ?? 0;
    if (entry.bytes === null) {
      row.notParsed.missing += 1;
      missing += 1;
    }
    if (governed.has(fileNodeId(entry.path))) row.withModule += 1;
    if (!SCRIPT.test(entry.path)) continue;
    if (DECLARATION.test(entry.path)) row.notParsed.declaration += 1;
    else if (isSymlink(entry)) row.notParsed.symlink += 1;
    else if (entry.bytes === null) continue;
    else if (entry.bytes > bounds.blobBytes) row.notParsed.tooLarge += 1;
    else if (overBudget.has(entry.path)) row.notParsed.overBudget += 1;
    else if (parsed.has(entry.path)) row.parsed += 1;
    else {
      // Listed with a size, yet the read returned nothing: the object vanished mid-build.
      row.notParsed.missing += 1;
      missing += 1;
    }
  }
  if (manifestErrors.length > PROJECT_MAP_LIMITS.listedPaths) boundsReached.add('listed-paths');
  if (input.submodules.length > PROJECT_MAP_LIMITS.listedPaths) boundsReached.add('listed-paths');
  const omittedFiles = Object.entries(omitted)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason: reason as keyof typeof omitted, count }));
  const reached = [...boundsReached].sort();

  return {
    format: 'salidium.project-map',
    version: 0,
    experimental: true,
    generatedAt: new Date(now()).toISOString(),
    indexer: { name: 'salidium-project-map', version: INDEXER_VERSION, git: clip(input.git, 64) },
    repository: {
      root: input.root,
      commit: input.commit,
      tree: input.tree,
      commitTime: input.commitTime,
    },
    coverage: {
      complete: reached.length === 0 && omittedFiles.length === 0 && missing === 0,
      bounds: { ...bounds },
      boundsReached: reached,
      files: entries.length,
      bytes: entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0),
      omittedFiles,
      submodules: {
        count: input.submodules.length,
        paths: input.submodules
          .filter(
            (p) => p.length <= PROJECT_MAP_LIMITS.pathLength && !hasUnprintable(p) && canonical(p),
          )
          .slice(0, PROJECT_MAP_LIMITS.listedPaths),
      },
      languages: [...languages.values()].sort((a, b) => b.files - a.files).slice(0, 128),
      specifierKinds,
      dynamicImportsWithoutLiteral: dynamicWithoutLiteral,
      internalFileEdges,
      unresolved: {
        total: unresolvedTotal,
        byReason: [...unresolvedReasons]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 64),
        items: unresolved,
        truncated: unresolvedTotal > unresolved.length,
      },
      manifestErrors: {
        count: manifestErrors.length,
        paths: manifestErrors.slice(0, PROJECT_MAP_LIMITS.listedPaths),
      },
      notAnalyzed: NOT_ANALYZED,
    },
    nodes: [...nodes.values()],
    edges: edgeList,
  };
}
