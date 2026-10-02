import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_EDGE_KINDS, type ProjectMap } from '@salidium/project-map';
import { afterAll, describe, expect, it } from 'vitest';
import { allowRepository } from './optIn.ts';
import { DaemonProjectMapService } from './service.ts';

/*
 * The maps of two public repositories at the revisions docs/project-map-validation.md measured,
 * compared with that record's counts (and the research run's, for the later revisions). Read-only:
 * the repositories are opted in under a scratch home and read through the map service.
 *
 * Runs only where the repositories are checked out, named by environment variables:
 *
 *   SALIDIUM_MAP_SALIDIUM_REPO=<salidium checkout> SALIDIUM_MAP_HALCYONIC_REPO=<halcyonic checkout> \
 *     pnpm vitest run packages/daemon/src/projectMap/realRepositories.test.ts
 */
const salidium = process.env.SALIDIUM_MAP_SALIDIUM_REPO;
const halcyonic = process.env.SALIDIUM_MAP_HALCYONIC_REPO;
const home = mkdtempSync(join(tmpdir(), 'salidium-map-real-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function counts(map: ProjectMap) {
  const fileKinds = new Set<string>(FILE_EDGE_KINDS);
  const internal = map.edges.filter((e) => fileKinds.has(e.kind) && e.to.startsWith('file:'));
  const touched = new Set(internal.flatMap((e) => [e.from, e.to]));
  const scripts = map.nodes.filter(
    (n) =>
      n.kind === 'file' &&
      /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(n.path) &&
      !/\.d\.[cm]?ts$/.test(n.path),
  );
  const placed = new Set(
    map.edges.filter((e) => e.kind === 'contains' || e.kind === 'compiles').map((e) => e.to),
  );
  const csharp = map.nodes.filter((n) => n.kind === 'file' && n.path.endsWith('.cs'));
  return {
    files: map.coverage.files,
    nodes: map.nodes.length,
    edges: map.edges.length,
    scriptsParsed: map.coverage.languages
      .filter((l) => l.analysis === 'file-edges')
      .reduce((sum, l) => sum + l.parsed, 0),
    internalFileEdges: map.coverage.internalFileEdges,
    pairs: new Set(internal.map((e) => `${e.from}|${e.to}`)).size,
    scriptsInAnEdge: scripts.filter((n) => touched.has(n.id)).length,
    unresolvedImports: map.coverage.unresolved.items.filter((u) => u.from.startsWith('file:'))
      .length,
    unresolved: map.coverage.unresolved.total,
    modules: map.nodes.filter((n) => n.kind === 'module').length,
    csharpPlaced: csharp.filter((n) => placed.has(n.id)).length,
    csharp: csharp.length,
    complete: map.coverage.complete,
  };
}

async function mapOf(root: string, commit: string): Promise<ProjectMap> {
  allowRepository(home, root);
  const result = await new DaemonProjectMapService({ home }).getMap(root, commit);
  if (!result.ok) throw new Error(result.refusal.message);
  return result.map;
}

describe.runIf(salidium)('Salidium at the validation record revisions', () => {
  it('0e9269a matches the record', async () => {
    expect(
      counts(await mapOf(salidium ?? '', '0e9269ad6bc1ca4200534550ffcef24f3756f04e')),
    ).toMatchObject({
      files: 403,
      scriptsParsed: 279,
      internalFileEdges: 770,
      scriptsInAnEdge: 261,
      unresolvedImports: 15,
      modules: 13,
      csharp: 0,
      complete: true,
    });
  });

  it('9d58e56 matches the research run', async () => {
    expect(
      counts(await mapOf(salidium ?? '', '9d58e56b823260c8e0107f980a2d3019f33b249a')),
    ).toMatchObject({
      files: 417,
      scriptsParsed: 287,
      nodes: 472,
      edges: 1769,
      pairs: 734,
      unresolved: 15,
    });
  });
});

describe.runIf(halcyonic)('Halcyonic at the validation record revisions', () => {
  it('3cbe884 matches the record', async () => {
    expect(
      counts(await mapOf(halcyonic ?? '', '3cbe884dfaf53917b121f2ca3322f35a79a672ab')),
    ).toMatchObject({
      files: 690,
      scriptsParsed: 188,
      internalFileEdges: 601,
      scriptsInAnEdge: 184,
      unresolvedImports: 0,
      modules: 25,
      csharp: 122,
      csharpPlaced: 122,
      complete: true,
    });
  });

  it('99e9bf6 matches the research run', async () => {
    expect(
      counts(await mapOf(halcyonic ?? '', '99e9bf6a169df02280467cfeded62a389ca91386')),
    ).toMatchObject({
      files: 852,
      scriptsParsed: 208,
      nodes: 901,
      edges: 2152,
      pairs: 694,
      unresolved: 17,
      csharpPlaced: 179,
    });
  });
});
