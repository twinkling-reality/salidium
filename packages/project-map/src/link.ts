import {
  EXECUTION_LINKS_FORMAT,
  EXECUTION_LINKS_LIMITS,
  type ExecutionLinks,
  type FileLink,
  type ModuleLink,
  type ModuleRef,
  type Neighbour,
  type RepositoryLink,
  type RevisionAnchor,
} from './executionLinks.ts';
import {
  type EdgeKind,
  FILE_EDGE_KINDS,
  fileNodeId,
  type MapEdge,
  type MapNode,
  type ModuleNode,
  type ProjectMap,
} from './schemas.ts';
import type { ProjectMapService } from './service.ts';

/**
 * Where Salidium found a changed file when the change was live: the working tree holding it, the
 * path relative to that tree, and for a linked worktree the repository it belongs to. `null` means
 * Salidium looked and no repository held the path; `undefined` means it never looked.
 */
export interface ObservedLocation {
  root: string;
  path: string;
  mainRoot?: string;
}

export interface ChangedFile {
  path: string;
  location: ObservedLocation | null | undefined;
}

export interface SessionAnchors {
  /** Each anchor names the main repository it was read in. */
  atStart: RevisionAnchor | null;
  atLatestTurnEnd: RevisionAnchor | null;
}

export type CommitChoice = 'latest-turn-end' | 'session-start';
export type MapUnavailable = 'over-bound' | 'busy' | 'repository-unsupported';

/** The service refusals that mean "a map cannot be had now", as opposed to "not this commit". */
const UNAVAILABLE = new Set<string>(['over-bound', 'busy', 'repository-unsupported']);

/** What the map service said about one repository, settled before linking. */
export type RepositoryResolution =
  | { status: 'mapped'; commit: string; chosen: CommitChoice; map: ProjectMap }
  | {
      status: 'map-unavailable';
      /** Null when the repository could not be read far enough to check the revision. */
      commit: string | null;
      chosen: CommitChoice | null;
      unavailable: MapUnavailable;
    }
  | { status: 'not-opted-in' | 'no-revision' | 'revision-gone' };

/** A file's repository is its main repository: a linked worktree shares its object store. */
export function repositoryOf(location: ObservedLocation): string {
  return location.mainRoot ?? location.root;
}

/**
 * The revisions that may anchor a repository's map, best first: HEAD at the latest turn end, then
 * HEAD at session start, each only if it was read in this repository. An anchor read anywhere else
 * says nothing about this one, even when its commit happens to exist here, as in a clone.
 */
export function revisionCandidates(
  anchors: SessionAnchors,
  repository: string,
): Array<{ commit: string; chosen: CommitChoice }> {
  const out: Array<{ commit: string; chosen: CommitChoice }> = [];
  const read = (a: RevisionAnchor | null) => (a?.repository === repository ? a.head : null);
  const end = read(anchors.atLatestTurnEnd);
  const start = read(anchors.atStart);
  if (end) out.push({ commit: end, chosen: 'latest-turn-end' });
  if (start && start !== end) out.push({ commit: start, chosen: 'session-start' });
  return out;
}

/**
 * Settles each repository through the map service, in the order the rule asks: opt-in first, so a
 * repository the person did not allow is never read, then the newest anchored revision that still
 * exists, then the map at it.
 */
export async function resolveRepository(
  maps: ProjectMapService,
  anchors: SessionAnchors,
  repository: string,
): Promise<RepositoryResolution> {
  if (!maps.isOptedIn(repository)) return { status: 'not-opted-in' };
  const candidates = revisionCandidates(anchors, repository);
  if (candidates.length === 0) return { status: 'no-revision' };
  for (const candidate of candidates) {
    const exists = await maps.commitExists(repository, candidate.commit);
    if (!exists.ok) {
      const code = exists.refusal.error;
      if (code === 'not-opted-in') return { status: 'not-opted-in' };
      // Whether the revision exists is not known, so no commit is claimed.
      if (UNAVAILABLE.has(code))
        return {
          status: 'map-unavailable',
          commit: null,
          chosen: null,
          unavailable: code as MapUnavailable,
        };
      continue;
    }
    if (!exists.exists) continue;
    const result = await maps.getMap(repository, candidate.commit);
    if (result.ok) return { status: 'mapped', ...candidate, map: result.map };
    const code = result.refusal.error;
    if (code === 'not-opted-in') return { status: 'not-opted-in' };
    if (UNAVAILABLE.has(code))
      return { status: 'map-unavailable', ...candidate, unavailable: code as MapUnavailable };
    // The commit vanished between the two reads, or the id was refused: try the next one.
  }
  return { status: 'revision-gone' };
}

/** Repositories the changed files were found in, in order of first appearance. */
export function repositoriesOf(files: readonly ChangedFile[]): string[] {
  const seen = new Set<string>();
  for (const file of files) if (file.location) seen.add(repositoryOf(file.location));
  return [...seen];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: excluding control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;

function carriable(path: string): boolean {
  return (
    path.startsWith('/') && path.length <= EXECUTION_LINKS_LIMITS.pathLength && !CONTROL.test(path)
  );
}

const FILE_EDGES = new Set<EdgeKind>(FILE_EDGE_KINDS);

/** One map, indexed for the questions a link asks of it. */
class MapIndex {
  readonly nodes = new Map<string, MapNode>();
  readonly outgoing = new Map<string, MapEdge[]>();
  readonly incoming = new Map<string, MapEdge[]>();

  constructor(map: ProjectMap) {
    for (const node of map.nodes) this.nodes.set(node.id, node);
    for (const edge of map.edges) {
      push(this.outgoing, edge.from, edge);
      push(this.incoming, edge.to, edge);
    }
  }

  file(path: string) {
    const node = this.nodes.get(fileNodeId(path));
    return node?.kind === 'file' ? node : undefined;
  }

  module(id: string): ModuleNode | undefined {
    const node = this.nodes.get(id);
    return node?.kind === 'module' ? node : undefined;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function moduleRef(node: ModuleNode): ModuleRef {
  return { id: node.id, name: node.name, manifest: node.manifest, ecosystem: node.ecosystem };
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Links one session's changed files to the maps of their repositories. Pure: every fact it needs
 * (where each file was found, the session's anchors, each repository's settled map) is an input,
 * and the same inputs give the same document.
 *
 * A file links only by path equality with a node the map's commit tracks. Ring 1 is its module
 * membership and the edges that touch it; ring 2 is each containing module and the modules that
 * depend on it. Every element keeps the map's provenance and rule.
 */
export function linkExecution(input: {
  sessionId: string;
  generatedAt: string;
  anchors: SessionAnchors;
  /** Newest change first. */
  files: readonly ChangedFile[];
  /** Changed files the caller did not pass, counted as omitted: for example ones redaction alters. */
  withheld?: number;
  /** Map nodes and edges the caller left out, for example ones redaction alters. */
  mapElementsWithheld?: number;
  repositories: ReadonlyMap<string, RepositoryResolution>;
}): ExecutionLinks {
  const indexes = new Map<string, MapIndex>();
  for (const [root, resolution] of input.repositories)
    if (resolution.status === 'mapped') indexes.set(root, new MapIndex(resolution.map));

  const carried = input.files.filter((file) => carriable(file.path));
  const kept = carried.slice(0, EXECUTION_LINKS_LIMITS.files);

  // Which repository paths the session changed, so a neighbour can say it was changed too.
  const changedPaths = new Map<string, Set<string>>();
  const worktrees = new Map<string, string[]>();
  for (const file of kept) {
    if (!file.location) continue;
    const repository = repositoryOf(file.location);
    const paths = changedPaths.get(repository) ?? new Set<string>();
    paths.add(file.location.path);
    changedPaths.set(repository, paths);
    const trees = worktrees.get(repository) ?? [];
    if (!trees.includes(file.location.root)) trees.push(file.location.root);
    worktrees.set(repository, trees);
  }

  const moduleFiles = new Map<
    string,
    { repository: string; module: ModuleNode; files: Set<string> }
  >();

  const files: FileLink[] = kept.map((file) => {
    const base = {
      path: file.path,
      repository: null,
      worktree: null,
      relativePath: null,
      node: null,
      role: null,
      modules: [],
      neighbours: [],
      neighboursTotal: 0,
      neighboursTruncated: false,
    } satisfies Omit<FileLink, 'status'>;
    if (file.location === undefined) return { ...base, status: 'repository-unknown' };
    if (file.location === null) return { ...base, status: 'outside-repository' };
    const repository = repositoryOf(file.location);
    const located = {
      ...base,
      repository,
      worktree: file.location.root,
      relativePath: file.location.path,
    };
    const index = indexes.get(repository);
    if (!index) return { ...located, status: 'repository-not-mapped' };
    const node = index.file(file.location.path);
    if (!node) return { ...located, status: 'not-in-map' };

    const modules: FileLink['modules'] = [];
    for (const edge of index.incoming.get(node.id) ?? []) {
      if (edge.kind !== 'contains' && edge.kind !== 'compiles') continue;
      const owner = index.module(edge.from);
      if (!owner) continue;
      modules.push({
        module: moduleRef(owner),
        kind: edge.kind,
        provenance: edge.provenance,
        rule: edge.rule,
      });
      const key = `${repository}\0${owner.id}`;
      const entry = moduleFiles.get(key) ?? { repository, module: owner, files: new Set() };
      entry.files.add(node.path);
      moduleFiles.set(key, entry);
    }
    modules.sort((a, b) => byText(a.module.id, b.module.id));

    const changed = changedPaths.get(repository) ?? new Set<string>();
    const neighbours: Neighbour[] = [];
    const add = (edge: MapEdge, direction: Neighbour['direction'], otherId: string) => {
      const other = index.nodes.get(otherId);
      if (!other) return;
      neighbours.push({
        direction,
        edge: edge.id,
        kind: edge.kind,
        provenance: edge.provenance,
        rule: edge.rule,
        node: other.id,
        nodeKind: other.kind,
        path: other.kind === 'file' ? other.path : null,
        name: other.kind === 'file' ? null : other.name,
        role: other.kind === 'file' ? other.role : null,
        changed: other.kind === 'file' && changed.has(other.path),
        evidence: edge.evidence.slice(0, EXECUTION_LINKS_LIMITS.evidencePerNeighbour),
      });
    };
    for (const edge of index.outgoing.get(node.id) ?? [])
      if (FILE_EDGES.has(edge.kind)) add(edge, 'imports', edge.to);
    for (const edge of index.incoming.get(node.id) ?? [])
      if (FILE_EDGES.has(edge.kind)) add(edge, 'imported-by', edge.from);
    neighbours.sort(compareNeighbours);

    return {
      ...located,
      status: 'linked',
      node: node.id,
      role: node.role,
      modules: modules.slice(0, EXECUTION_LINKS_LIMITS.modulesPerFile),
      neighbours: neighbours.slice(0, EXECUTION_LINKS_LIMITS.neighboursPerFile),
      neighboursTotal: neighbours.length,
      neighboursTruncated: neighbours.length > EXECUTION_LINKS_LIMITS.neighboursPerFile,
    };
  });

  const allModules: ModuleLink[] = [...moduleFiles.values()].map(
    ({ repository, module, files: paths }) => {
      const index = indexes.get(repository) as MapIndex;
      const dependents: ModuleLink['dependents'] = [];
      for (const edge of index.incoming.get(module.id) ?? []) {
        if (edge.kind !== 'depends-on') continue;
        const dependent = index.module(edge.from);
        if (!dependent) continue;
        dependents.push({
          module: moduleRef(dependent),
          edge: edge.id,
          provenance: edge.provenance,
          rule: edge.rule,
        });
      }
      dependents.sort((a, b) => byText(a.module.id, b.module.id));
      const changedFiles = [...paths].sort(byText);
      return {
        repository,
        module: moduleRef(module),
        changedFiles: changedFiles.slice(0, EXECUTION_LINKS_LIMITS.changedPerModule),
        dependents: dependents.slice(0, EXECUTION_LINKS_LIMITS.dependentsPerModule),
        dependentsTotal: dependents.length,
        dependentsTruncated: dependents.length > EXECUTION_LINKS_LIMITS.dependentsPerModule,
      };
    },
  );
  allModules.sort(
    (a, b) => b.changedFiles.length - a.changedFiles.length || byText(a.module.id, b.module.id),
  );

  const repositories: RepositoryLink[] = [];
  for (const [root, resolution] of input.repositories) {
    if (repositories.length >= EXECUTION_LINKS_LIMITS.repositories) break;
    repositories.push({
      root,
      worktrees: (worktrees.get(root) ?? []).slice(
        0,
        EXECUTION_LINKS_LIMITS.worktreesPerRepository,
      ),
      status: resolution.status,
      commit:
        (resolution.status === 'mapped' || resolution.status === 'map-unavailable') &&
        resolution.commit !== null &&
        resolution.chosen !== null
          ? { id: resolution.commit, chosen: resolution.chosen, provenance: 'observed' }
          : null,
      unavailable: resolution.status === 'map-unavailable' ? resolution.unavailable : null,
      commitTime: resolution.status === 'mapped' ? resolution.map.repository.commitTime : null,
      mapComplete: resolution.status === 'mapped' ? resolution.map.coverage.complete : null,
    });
  }

  return {
    format: EXECUTION_LINKS_FORMAT,
    version: 0,
    experimental: true,
    generatedAt: input.generatedAt,
    sessionId: input.sessionId,
    anchors: input.anchors,
    repositories,
    files,
    filesTotal: input.files.length + (input.withheld ?? 0),
    filesOmitted: input.files.length - carried.length + (input.withheld ?? 0),
    mapElementsWithheld: input.mapElementsWithheld ?? 0,
    modules: allModules.slice(0, EXECUTION_LINKS_LIMITS.modules),
    modulesTruncated: allModules.length > EXECUTION_LINKS_LIMITS.modules,
  };
}

const NODE_ORDER: Record<Neighbour['nodeKind'], number> = {
  file: 0,
  module: 1,
  'external-package': 2,
  builtin: 3,
};

/** Imports before importers, files before modules and packages, then by path or name. */
function compareNeighbours(a: Neighbour, b: Neighbour): number {
  if (a.direction !== b.direction) return a.direction === 'imports' ? -1 : 1;
  if (a.nodeKind !== b.nodeKind) return NODE_ORDER[a.nodeKind] - NODE_ORDER[b.nodeKind];
  return byText(a.path ?? a.name ?? a.node, b.path ?? b.name ?? b.node) || byText(a.kind, b.kind);
}
