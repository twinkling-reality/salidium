import { describe, expect, test } from 'vitest';
import {
  type ProjectMap,
  ProjectMapErrorSchema,
  ProjectMapSchema,
  projectMapContractEntry,
  RepositoryPathSchema,
  RepositoryRootSchema,
} from './index.ts';

const blob = 'a'.repeat(40);

function sample(): ProjectMap {
  return {
    format: 'salidium.project-map',
    version: 0,
    experimental: true,
    generatedAt: '2026-10-02T00:00:00.000Z',
    indexer: { name: 'salidium-project-map', version: '0.1.0' },
    repository: {
      root: '/work/repo',
      commit: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      commitTime: '2026-01-01T00:00:00.000Z',
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
      files: 2,
      bytes: 20,
      omittedFiles: [],
      submodules: { count: 0, paths: [] },
      languages: [
        {
          language: 'typescript',
          analysis: 'file-edges',
          files: 2,
          bytes: 20,
          parsed: 2,
          notParsed: { tooLarge: 0, overBudget: 0, declaration: 0, symlink: 0 },
          withModule: 0,
        },
      ],
      specifierKinds: {
        import: 1,
        importType: 0,
        sideEffect: 0,
        exportFrom: 0,
        exportTypeFrom: 0,
        dynamic: 0,
        require: 0,
      },
      dynamicImportsWithoutLiteral: 0,
      internalFileEdges: 1,
      unresolved: { total: 0, byReason: [], items: [], truncated: false },
      manifestErrors: { count: 0, paths: [] },
      notAnalyzed: [{ subject: 'CSS imports', reason: 'not read in version 0' }],
    },
    nodes: [
      {
        id: 'file:src/a.ts',
        kind: 'file',
        path: 'src/a.ts',
        entry: 'file',
        language: 'typescript',
        bytes: 10,
        blob,
        role: null,
      },
      {
        id: 'file:src/a.test.ts',
        kind: 'file',
        path: 'src/a.test.ts',
        entry: 'file',
        language: 'typescript',
        bytes: 10,
        blob,
        role: { value: 'test', provenance: 'inferred', rule: 'name matches *.test.*' },
      },
    ],
    edges: [
      {
        id: 'e:0123456789abcdef',
        from: 'file:src/a.test.ts',
        to: 'file:src/a.ts',
        kind: 'imports',
        provenance: 'observed',
        rule: 'exact',
        evidence: [{ path: 'src/a.test.ts', line: 1 }],
        count: 1,
      },
    ],
  };
}

describe('salidium.project-map v0', () => {
  test('a map parses to exactly itself', () => {
    const map = sample();
    expect(ProjectMapSchema.parse(map)).toEqual(map);
  });

  test('says it is experimental', () => {
    expect(ProjectMapSchema.safeParse({ ...sample(), experimental: false }).success).toBe(false);
  });

  test('refuses paths that could escape or confuse a reader', () => {
    for (const path of ['/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a\nb', ''])
      expect(RepositoryPathSchema.safeParse(path).success, path).toBe(false);
    expect(RepositoryPathSchema.safeParse('a/b.c/d.ts').success).toBe(true);
    expect(RepositoryRootSchema.safeParse('relative').success).toBe(false);
    expect(RepositoryRootSchema.safeParse('/work/repo/').success).toBe(false);
  });

  test('holds evidence and object ids to their bounds', () => {
    const map = sample();
    const edge = map.edges[0];
    if (!edge) throw new Error('sample has an edge');
    edge.evidence = Array.from({ length: 9 }, () => ({ path: 'src/a.ts', line: 1 }));
    expect(ProjectMapSchema.safeParse(map).success).toBe(false);
    const short = sample();
    const node = short.nodes[0];
    if (node?.kind !== 'file') throw new Error('sample starts with a file');
    node.blob = 'abc1234';
    expect(ProjectMapSchema.safeParse(short).success).toBe(false);
  });

  test('errors and the discovery entry have their own names', () => {
    expect(
      ProjectMapErrorSchema.parse({
        format: 'salidium.project-map-error',
        version: 0,
        error: 'not-opted-in',
        message: 'not opted in',
      }).error,
    ).toBe('not-opted-in');
    expect(projectMapContractEntry(47822)).toEqual({
      name: 'salidium.project-map',
      major: 0,
      minor: 0,
      baseUrl: 'http://127.0.0.1:47822/project-map/v0',
    });
  });
});
