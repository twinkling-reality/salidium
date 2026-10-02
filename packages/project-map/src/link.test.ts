import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  type ChangedFile,
  EXECUTION_LINKS_LIMITS,
  type ExecutionLinks,
  ExecutionLinksSchema,
  linkExecution,
  type MapEdge,
  type MapNode,
  type ProjectMap,
  type ProjectMapService,
  type RepositoryResolution,
  repositoriesOf,
  resolveRepository,
  type SessionAnchors,
} from './index.ts';

const REPO = '/work/repo';
const WORKTREE = '/work/repo-feature';
const OTHER = '/work/other';
const START = '1'.repeat(40);
const END = '2'.repeat(40);
const GENERATED_AT = '2026-10-02T12:00:00.000Z';

const edgeId = (from: string, kind: string, to: string) =>
  `e:${createHash('sha256').update(`${from}\0${kind}\0${to}`).digest('hex').slice(0, 16)}`;

function file(path: string, test = false): MapNode {
  return {
    id: `file:${path}`,
    kind: 'file',
    path,
    entry: 'file',
    language: path.endsWith('.md') ? 'markdown' : 'typescript',
    bytes: 10,
    blob: 'a'.repeat(40),
    role: test
      ? { value: 'test', provenance: 'inferred', rule: 'name matches *.test.* or *.spec.*' }
      : null,
  };
}

function module(dir: string, name: string): MapNode {
  return {
    id: `module:package.json:${dir}`,
    kind: 'module',
    manifest: dir === '.' ? 'package.json' : `${dir}/package.json`,
    name,
    ecosystem: 'npm',
  };
}

function edge(
  from: string,
  kind: MapEdge['kind'],
  to: string,
  rule: string,
  line?: number,
): MapEdge {
  return {
    id: edgeId(from, kind, to),
    from,
    to,
    kind,
    provenance: 'observed',
    rule,
    evidence: line === undefined ? [] : [{ path: from.replace(/^file:/, ''), line }],
    count: 1,
  };
}

/**
 * Two workspace packages: `core` with a source file, its test and a helper, and `app`, which
 * depends on core and imports its source file. One README nobody imports.
 */
function sampleMap(commit = END): ProjectMap {
  const nodes: MapNode[] = [
    module('packages/core', '@x/core'),
    module('packages/app', '@x/app'),
    file('packages/core/src/a.ts'),
    file('packages/core/src/b.ts'),
    file('packages/core/src/a.test.ts', true),
    file('packages/app/src/main.ts'),
    file('README.md'),
    { id: 'package:zod', kind: 'external-package', name: 'zod' },
  ];
  const edges: MapEdge[] = [
    edge(
      'module:package.json:packages/core',
      'contains',
      'file:packages/core/src/a.ts',
      'nearest package.json',
    ),
    edge(
      'module:package.json:packages/core',
      'contains',
      'file:packages/core/src/b.ts',
      'nearest package.json',
    ),
    edge(
      'module:package.json:packages/core',
      'contains',
      'file:packages/core/src/a.test.ts',
      'nearest package.json',
    ),
    edge(
      'module:package.json:packages/app',
      'contains',
      'file:packages/app/src/main.ts',
      'nearest package.json',
    ),
    edge('file:packages/core/src/a.ts', 'imports', 'file:packages/core/src/b.ts', 'probe', 1),
    edge('file:packages/core/src/a.ts', 'imports', 'package:zod', 'external', 2),
    edge(
      'file:packages/core/src/a.test.ts',
      'imports',
      'file:packages/core/src/a.ts',
      'ts-extension',
      1,
    ),
    edge(
      'file:packages/app/src/main.ts',
      'imports',
      'file:packages/core/src/a.ts',
      'exports:development',
      3,
    ),
    edge(
      'module:package.json:packages/app',
      'depends-on',
      'module:package.json:packages/core',
      'package.json dependency on a package in this tree',
    ),
  ];
  return {
    format: 'salidium.project-map',
    version: 0,
    experimental: true,
    generatedAt: GENERATED_AT,
    indexer: { name: 'salidium-project-map', version: '0.1.0' },
    repository: {
      root: REPO,
      commit,
      tree: 'c'.repeat(40),
      commitTime: '2026-10-01T09:00:00.000Z',
    },
    coverage: {
      complete: true,
      bounds: {
        files: 20000,
        blobBytes: 1048576,
        totalBytes: 67108864,
        nodes: 50000,
        edges: 250000,
      },
      boundsReached: [],
      files: 5,
      bytes: 50,
      omittedFiles: [],
      submodules: { count: 0, paths: [] },
      languages: [],
      specifierKinds: {
        import: 4,
        importType: 0,
        sideEffect: 0,
        exportFrom: 0,
        exportTypeFrom: 0,
        dynamic: 0,
        require: 0,
      },
      dynamicImportsWithoutLiteral: 0,
      internalFileEdges: 3,
      unresolved: { total: 0, byReason: [], items: [], truncated: false },
      manifestErrors: { count: 0, paths: [] },
      notAnalyzed: [{ subject: 'CSS imports', reason: 'not read in version 0' }],
    },
    nodes,
    edges,
  };
}

const anchors = (overrides: Partial<SessionAnchors> = {}): SessionAnchors => ({
  repository: REPO,
  atStart: { head: START, branch: 'main', at: '2026-10-02T10:00:00.000Z', provenance: 'observed' },
  atLatestTurnEnd: {
    head: END,
    branch: 'main',
    at: '2026-10-02T11:00:00.000Z',
    provenance: 'observed',
  },
  ...overrides,
});

const at = (root: string, path: string, mainRoot?: string): ChangedFile['location'] => ({
  root,
  path,
  ...(mainRoot ? { mainRoot } : {}),
});

function link(
  files: ChangedFile[],
  repositories: Array<[string, RepositoryResolution]>,
  sessionAnchors = anchors(),
): ExecutionLinks {
  const doc = linkExecution({
    sessionId: 'claude-code:s1',
    generatedAt: GENERATED_AT,
    anchors: sessionAnchors,
    files,
    repositories: new Map(repositories),
  });
  // The producer holds itself to the closed form: nothing undeclared, everything in bounds.
  expect(ExecutionLinksSchema.parse(doc)).toEqual(doc);
  return doc;
}

const mapped = (map = sampleMap()): RepositoryResolution => ({
  status: 'mapped',
  commit: map.repository.commit,
  chosen: 'latest-turn-end',
  map,
});

describe('linkExecution', () => {
  test('links a changed file by path equality and gives its whole ring 1 with rules', () => {
    const doc = link(
      [{ path: `${REPO}/packages/core/src/a.ts`, location: at(REPO, 'packages/core/src/a.ts') }],
      [[REPO, mapped()]],
    );
    const [a] = doc.files;
    expect(a).toMatchObject({
      status: 'linked',
      repository: REPO,
      worktree: REPO,
      relativePath: 'packages/core/src/a.ts',
      node: 'file:packages/core/src/a.ts',
      role: null,
      neighboursTotal: 4,
      neighboursTruncated: false,
    });
    expect(a?.modules).toEqual([
      {
        module: {
          id: 'module:package.json:packages/core',
          name: '@x/core',
          manifest: 'packages/core/package.json',
          ecosystem: 'npm',
        },
        kind: 'contains',
        provenance: 'observed',
        rule: 'nearest package.json',
      },
    ]);
    expect(
      a?.neighbours.map((n) => [n.direction, n.nodeKind, n.path ?? n.name, n.kind, n.rule]),
    ).toEqual([
      ['imports', 'file', 'packages/core/src/b.ts', 'imports', 'probe'],
      ['imports', 'external-package', 'zod', 'imports', 'external'],
      ['imported-by', 'file', 'packages/app/src/main.ts', 'imports', 'exports:development'],
      ['imported-by', 'file', 'packages/core/src/a.test.ts', 'imports', 'ts-extension'],
    ]);
    // The test role is the map's inference and stays labelled as one.
    expect(a?.neighbours.find((n) => n.path === 'packages/core/src/a.test.ts')?.role).toEqual({
      value: 'test',
      provenance: 'inferred',
      rule: 'name matches *.test.* or *.spec.*',
    });
    expect(a?.neighbours.every((n) => n.provenance === 'observed')).toBe(true);
    expect(a?.neighbours[0]?.evidence).toEqual([{ path: 'packages/core/src/a.ts', line: 1 }]);
    expect(doc.repositories).toEqual([
      {
        root: REPO,
        worktrees: [REPO],
        status: 'mapped',
        commit: { id: END, chosen: 'latest-turn-end', provenance: 'observed' },
        unavailable: null,
        commitTime: '2026-10-01T09:00:00.000Z',
        mapComplete: true,
      },
    ]);
  });

  test('gives ring 2: the containing module and the modules that depend on it', () => {
    const doc = link(
      [
        { path: `${REPO}/packages/core/src/a.ts`, location: at(REPO, 'packages/core/src/a.ts') },
        { path: `${REPO}/packages/core/src/b.ts`, location: at(REPO, 'packages/core/src/b.ts') },
      ],
      [[REPO, mapped()]],
    );
    expect(doc.modules).toEqual([
      {
        repository: REPO,
        module: {
          id: 'module:package.json:packages/core',
          name: '@x/core',
          manifest: 'packages/core/package.json',
          ecosystem: 'npm',
        },
        changedFiles: ['packages/core/src/a.ts', 'packages/core/src/b.ts'],
        dependents: [
          {
            module: {
              id: 'module:package.json:packages/app',
              name: '@x/app',
              manifest: 'packages/app/package.json',
              ecosystem: 'npm',
            },
            edge: edgeId(
              'module:package.json:packages/app',
              'depends-on',
              'module:package.json:packages/core',
            ),
            provenance: 'observed',
            rule: 'package.json dependency on a package in this tree',
          },
        ],
        dependentsTotal: 1,
        dependentsTruncated: false,
      },
    ]);
    // A neighbour the session also changed says so.
    expect(doc.files[0]?.neighbours.find((n) => n.path === 'packages/core/src/b.ts')?.changed).toBe(
      true,
    );
  });

  test('a file the map commit does not track is not-in-map, and nothing links by name', () => {
    const doc = link(
      [
        // Added after the map commit.
        {
          path: `${REPO}/packages/core/src/new.ts`,
          location: at(REPO, 'packages/core/src/new.ts'),
        },
        // Same file name as a node, different directory: no similarity matching.
        { path: `${REPO}/docs/a.ts`, location: at(REPO, 'docs/a.ts') },
        // Same name as the root README, in a subdirectory.
        { path: `${REPO}/packages/README.md`, location: at(REPO, 'packages/README.md') },
      ],
      [[REPO, mapped()]],
    );
    expect(doc.files.map((f) => [f.status, f.node])).toEqual([
      ['not-in-map', null],
      ['not-in-map', null],
      ['not-in-map', null],
    ]);
    expect(doc.modules).toEqual([]);
  });

  test('says when Salidium found no repository, and when it never looked', () => {
    const doc = link(
      [
        { path: '/tmp/scratch/notes.md', location: null },
        { path: `${REPO}/packages/core/src/a.ts`, location: undefined },
      ],
      [],
    );
    expect(doc.files.map((f) => [f.status, f.repository, f.relativePath])).toEqual([
      ['outside-repository', null, null],
      ['repository-unknown', null, null],
    ]);
    expect(doc.repositories).toEqual([]);
  });

  test('a file in a linked worktree maps to its main repository', () => {
    const files: ChangedFile[] = [
      {
        path: `${WORKTREE}/packages/core/src/a.ts`,
        location: at(WORKTREE, 'packages/core/src/a.ts', REPO),
      },
      { path: `${REPO}/packages/core/src/b.ts`, location: at(REPO, 'packages/core/src/b.ts') },
    ];
    expect(repositoriesOf(files)).toEqual([REPO]);
    const doc = link(files, [[REPO, mapped()]]);
    expect(doc.files[0]).toMatchObject({
      status: 'linked',
      repository: REPO,
      worktree: WORKTREE,
      node: 'file:packages/core/src/a.ts',
    });
    expect(doc.repositories[0]?.worktrees).toEqual([WORKTREE, REPO]);
  });

  test('files of a repository with no map carry repository-not-mapped and its reason', () => {
    const doc = link(
      [
        { path: `${REPO}/packages/core/src/a.ts`, location: at(REPO, 'packages/core/src/a.ts') },
        { path: `${OTHER}/index.ts`, location: at(OTHER, 'index.ts') },
      ],
      [
        [REPO, { status: 'revision-gone' }],
        [OTHER, { status: 'not-opted-in' }],
      ],
    );
    expect(doc.files.map((f) => f.status)).toEqual([
      'repository-not-mapped',
      'repository-not-mapped',
    ]);
    expect(doc.repositories.map((r) => [r.root, r.status, r.commit])).toEqual([
      [REPO, 'revision-gone', null],
      [OTHER, 'not-opted-in', null],
    ]);
  });

  test('a session imported from history has no anchors and no locations', () => {
    const none: SessionAnchors = { repository: null, atStart: null, atLatestTurnEnd: null };
    const files: ChangedFile[] = [
      { path: `${REPO}/packages/core/src/a.ts`, location: undefined },
      { path: `${REPO}/README.md`, location: undefined },
    ];
    expect(repositoriesOf(files)).toEqual([]);
    const doc = link(files, [], none);
    expect(doc.anchors).toEqual(none);
    expect(doc.files.every((f) => f.status === 'repository-unknown')).toBe(true);
  });

  test('counts paths it cannot carry instead of dropping them silently', () => {
    const doc = link(
      [
        { path: `${REPO}/bad\nname.ts`, location: at(REPO, 'bad\nname.ts') },
        { path: 'relative/path.ts', location: null },
        { path: `${REPO}/README.md`, location: at(REPO, 'README.md') },
      ],
      [[REPO, mapped()]],
    );
    expect(doc.filesTotal).toBe(3);
    expect(doc.filesOmitted).toBe(2);
    expect(doc.files.map((f) => f.status)).toEqual(['linked']);
  });

  test('bounds ring 1 and says when it did', () => {
    const map = sampleMap();
    const hub = 'file:packages/core/src/a.ts';
    for (let i = 0; i < EXECUTION_LINKS_LIMITS.neighboursPerFile + 5; i++) {
      const path = `packages/core/src/n${String(i).padStart(3, '0')}.ts`;
      map.nodes.push(file(path));
      map.edges.push(edge(`file:${path}`, 'imports', hub, 'probe', 1));
    }
    const doc = link(
      [{ path: `${REPO}/packages/core/src/a.ts`, location: at(REPO, 'packages/core/src/a.ts') }],
      [[REPO, mapped(map)]],
    );
    expect(doc.files[0]?.neighbours).toHaveLength(EXECUTION_LINKS_LIMITS.neighboursPerFile);
    expect(doc.files[0]?.neighboursTotal).toBe(EXECUTION_LINKS_LIMITS.neighboursPerFile + 9);
    expect(doc.files[0]?.neighboursTruncated).toBe(true);
  });

  test('is deterministic', () => {
    const files: ChangedFile[] = [
      { path: `${REPO}/packages/core/src/a.ts`, location: at(REPO, 'packages/core/src/a.ts') },
    ];
    expect(link(files, [[REPO, mapped()]])).toEqual(link(files, [[REPO, mapped()]]));
  });
});

/** A map service over a fixed set of commits, recording every call. */
function fakeService(options: {
  optedIn?: string[];
  commits?: Record<string, string[]>;
  refuse?: 'over-bound' | 'busy' | 'repository-unsupported';
  refuseExists?: 'busy' | 'repository-unsupported';
}): ProjectMapService & { calls: string[] } {
  const calls: string[] = [];
  const optedIn = new Set(options.optedIn ?? [REPO]);
  return {
    calls,
    isOptedIn: (root) => {
      calls.push(`isOptedIn ${root}`);
      return optedIn.has(root);
    },
    repositories: () => [],
    commitExists: async (root, commit) => {
      calls.push(`commitExists ${root} ${commit.slice(0, 1)}`);
      if (!optedIn.has(root))
        return { ok: false, refusal: { error: 'not-opted-in', message: 'no', bound: null } };
      if (options.refuseExists)
        return { ok: false, refusal: { error: options.refuseExists, message: 'no', bound: null } };
      return { ok: true, exists: (options.commits?.[root] ?? []).includes(commit) };
    },
    getMap: async (root, commit) => {
      calls.push(`getMap ${root} ${commit.slice(0, 1)}`);
      if (options.refuse)
        return {
          ok: false,
          refusal: {
            error: options.refuse,
            message: 'refused',
            bound: options.refuse === 'over-bound' ? 'files' : null,
          },
        };
      return { ok: true, map: sampleMap(commit) };
    },
  };
}

describe('resolveRepository', () => {
  test('uses the latest turn-end HEAD when it still exists', async () => {
    const maps = fakeService({ commits: { [REPO]: [START, END] } });
    const resolved = await resolveRepository(maps, anchors(), REPO);
    expect(resolved).toMatchObject({ status: 'mapped', commit: END, chosen: 'latest-turn-end' });
  });

  test('falls back to the start HEAD when the turn-end HEAD is gone', async () => {
    const maps = fakeService({ commits: { [REPO]: [START] } });
    const resolved = await resolveRepository(maps, anchors(), REPO);
    expect(resolved).toMatchObject({ status: 'mapped', commit: START, chosen: 'session-start' });
    expect(maps.calls).toEqual([
      `isOptedIn ${REPO}`,
      `commitExists ${REPO} 2`,
      `commitExists ${REPO} 1`,
      `getMap ${REPO} 1`,
    ]);
  });

  test('says revision-gone when no observed HEAD exists any more', async () => {
    const maps = fakeService({ commits: { [REPO]: [] } });
    expect(await resolveRepository(maps, anchors(), REPO)).toEqual({ status: 'revision-gone' });
    expect(maps.calls.some((c) => c.startsWith('getMap'))).toBe(false);
  });

  test('never reads a repository that is not opted in', async () => {
    const maps = fakeService({ optedIn: [], commits: { [REPO]: [END] } });
    expect(await resolveRepository(maps, anchors(), REPO)).toEqual({ status: 'not-opted-in' });
    expect(maps.calls).toEqual([`isOptedIn ${REPO}`]);
  });

  test('claims no revision for a repository the anchors were not read in', async () => {
    const maps = fakeService({ optedIn: [REPO, OTHER], commits: { [OTHER]: [END] } });
    expect(await resolveRepository(maps, anchors(), OTHER)).toEqual({ status: 'no-revision' });
    expect(maps.calls).toEqual([`isOptedIn ${OTHER}`]);
  });

  test('claims no revision for a session with no anchors', async () => {
    const maps = fakeService({ commits: { [REPO]: [END] } });
    const none: SessionAnchors = { repository: REPO, atStart: null, atLatestTurnEnd: null };
    expect(await resolveRepository(maps, none, REPO)).toEqual({ status: 'no-revision' });
  });

  test('an unborn branch anchors nothing', async () => {
    const maps = fakeService({ commits: { [REPO]: [END] } });
    const unborn = anchors({
      atStart: { head: null, branch: 'main', at: GENERATED_AT, provenance: 'observed' },
      atLatestTurnEnd: null,
    });
    expect(await resolveRepository(maps, unborn, REPO)).toEqual({ status: 'no-revision' });
  });

  test.each(['over-bound', 'busy', 'repository-unsupported'] as const)(
    'a %s refusal of the map is map-unavailable at the revision',
    async (refuse) => {
      const maps = fakeService({ commits: { [REPO]: [END] }, refuse });
      expect(await resolveRepository(maps, anchors(), REPO)).toEqual({
        status: 'map-unavailable',
        commit: END,
        chosen: 'latest-turn-end',
        unavailable: refuse,
      });
    },
  );

  test.each(['busy', 'repository-unsupported'] as const)(
    'a %s refusal before the revision is known claims no commit',
    async (refuseExists) => {
      const maps = fakeService({ commits: { [REPO]: [END] }, refuseExists });
      const resolved = await resolveRepository(maps, anchors(), REPO);
      expect(resolved).toEqual({
        status: 'map-unavailable',
        commit: null,
        chosen: null,
        unavailable: refuseExists,
      });
      const doc = link(
        [{ path: `${REPO}/README.md`, location: at(REPO, 'README.md') }],
        [[REPO, resolved]],
      );
      expect(doc.repositories[0]).toMatchObject({
        status: 'map-unavailable',
        commit: null,
        unavailable: refuseExists,
      });
      expect(doc.files[0]?.status).toBe('repository-not-mapped');
    },
  );

  test('resolves end to end into a document', async () => {
    const maps = fakeService({ optedIn: [REPO], commits: { [REPO]: [END] } });
    const files: ChangedFile[] = [
      {
        path: `${WORKTREE}/packages/core/src/a.ts`,
        location: at(WORKTREE, 'packages/core/src/a.ts', REPO),
      },
      { path: `${OTHER}/x.ts`, location: at(OTHER, 'x.ts') },
    ];
    const repositories = new Map<string, RepositoryResolution>();
    for (const root of repositoriesOf(files))
      repositories.set(root, await resolveRepository(maps, anchors(), root));
    const doc = link(files, [...repositories]);
    expect(doc.files.map((f) => f.status)).toEqual(['linked', 'repository-not-mapped']);
    expect(doc.repositories.map((r) => r.status)).toEqual(['mapped', 'not-opted-in']);
  });
});
