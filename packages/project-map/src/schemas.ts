import { z } from 'zod';

/**
 * `salidium.project-map` version 0: an experimental, read-only map of one Git repository at one
 * commit.
 *
 * A map is built on request from the committed tree only: never the working tree, never a model.
 * Every node is something the tree contains, and every edge is something a source file or manifest
 * at that commit states, resolved by a named rule. The one inference, a test role from naming, is
 * labelled `inferred` with its rule. Components, responsibilities and data flow are absent on
 * purpose: they are not in the tree.
 *
 * Version 0 is experimental and carries no compatibility promise. It is served beside the consumer
 * contract, with its own base path and version, and it does not change `/consumer/v1`. A document
 * names `experimental: true` so no reader mistakes it for a stable contract.
 *
 * Identity, stated once:
 *
 * - A file node's id is `file:<path>`, where path is relative to the repository root with `/`
 *   separators, exactly as Git's tree records it. It survives revisions that do not rename the
 *   file; its `blob` changes when its content does.
 * - A module node's id names its manifest: `module:package.json:<directory or .>`,
 *   `module:asmdef:<assembly name>`, `module:csproj:<path>`.
 * - External packages are `package:<name>` and Node built-ins `builtin:<name>`.
 * - An edge id is `e:` and the first 16 hex digits of SHA-256 over `from`, NUL, `kind`, NUL, `to`,
 *   so it is stable for as long as both ends and the kind are.
 *
 * Every property is always present. A value the map does not have is `null`.
 */
export const PROJECT_MAP_CONTRACT = { name: 'salidium.project-map', major: 0, minor: 0 } as const;

/** Every URL of the map starts here. The major version is part of the path. */
export const PROJECT_MAP_BASE_PATH = '/project-map/v0';

/** Bounds every document of version 0 holds to. A build that would exceed one is refused. */
export const PROJECT_MAP_LIMITS = {
  /**
   * Paths longer than this are not mapped; the build counts them under `omittedFiles`, with paths
   * that hold control characters or an empty, `.` or `..` segment (which only a crafted tree can).
   */
  pathLength: 1024,
  nodes: 50_000,
  edges: 250_000,
  /** Evidence kept per edge. `count` says how many places state it. */
  evidencePerEdge: 8,
  unresolvedItems: 1000,
  listedPaths: 200,
  ruleLength: 200,
  nameLength: 256,
  /** Absolute repository roots. */
  rootLength: 4096,
} as const;

const Timestamp = z.iso
  .datetime({ offset: false, precision: 3 })
  .describe('UTC, millisecond precision, trailing Z.');
const Count = z.number().int().nonnegative();
const Text = (max: number) => z.string().max(max);
/**
 * No C0 or C1 control characters and no bidirectional overrides or isolates: a reader may print
 * these strings to a terminal or a page, and each of those can change what is displayed.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: excluding control characters is the point.
const NO_CONTROL = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/** Whether a string holds a character the map's strings never carry. */
export const hasUnprintable = (text: string): boolean => UNPRINTABLE.test(text);

/** The string with each such character replaced by `?`, for printing or clipping. */
export const printable = (text: string): string =>
  text.replace(new RegExp(UNPRINTABLE.source, 'g'), '?');
const Clean = (max: number) => z.string().max(max).regex(NO_CONTROL);

export const ObjectIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  .describe('A full Git object id: 40 hex digits (SHA-1) or 64 (SHA-256). Never abbreviated.');

export const RepositoryPathSchema = z
  .string()
  .min(1)
  .max(PROJECT_MAP_LIMITS.pathLength)
  .regex(NO_CONTROL)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
    'a repository path is relative, with no empty, `.` or `..` segment',
  )
  .describe('Relative to the repository root, `/` separators, as the Git tree records it.');

export const RepositoryRootSchema = z
  .string()
  .min(1)
  .max(PROJECT_MAP_LIMITS.rootLength)
  .regex(NO_CONTROL)
  .refine((root) => root.startsWith('/') && (root === '/' || !root.endsWith('/')), {
    message: 'a repository root is an absolute path without a trailing slash',
  })
  .describe(
    "Absolute path of the repository's main working tree, as the person opted it in, resolved through symbolic links.",
  );

export const NodeIdSchema = Clean(PROJECT_MAP_LIMITS.pathLength + 64)
  .regex(/^(?:file|module|package|builtin):./)
  .describe('file:<path>, module:<manifest kind>:<key>, package:<name> or builtin:<name>.');

export const EdgeIdSchema = z.string().regex(/^e:[0-9a-f]{16}$/);

/** Only two classes appear in a map: what the tree states, and what a naming rule suggests. */
export const MapProvenanceSchema = z
  .enum(['observed', 'inferred'])
  .describe(
    'observed: the tree at this commit states it. inferred: a deterministic rule, named in `rule`, suggests it.',
  );
export type MapProvenance = z.infer<typeof MapProvenanceSchema>;

const LanguageSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/)
  .describe('By file extension, for example typescript, javascript, csharp, json, other.');

export const FileEntrySchema = z
  .enum(['file', 'executable', 'symlink'])
  .describe(
    'The tree mode. A symbolic link is listed with its own blob (the link text) and is never followed or parsed.',
  );

export const RoleSchema = z.object({
  value: z.literal('test'),
  provenance: z.literal('inferred'),
  rule: Text(PROJECT_MAP_LIMITS.ruleLength),
});

export const FileNodeSchema = z.object({
  id: NodeIdSchema,
  kind: z.literal('file'),
  path: RepositoryPathSchema,
  entry: FileEntrySchema,
  language: LanguageSchema,
  bytes: Count.nullable().describe(
    'Null when the object store does not hold the blob, as in a partial clone; see coverage.',
  ),
  blob: ObjectIdSchema,
  role: RoleSchema.nullable().describe('Null when no rule suggests a role.'),
});
export type FileNode = z.infer<typeof FileNodeSchema>;

export const ModuleEcosystemSchema = z.enum(['npm', 'unity-package', 'unity-assembly', 'msbuild']);

export const ModuleNodeSchema = z.object({
  id: NodeIdSchema,
  kind: z.literal('module'),
  manifest: RepositoryPathSchema.describe('The manifest that declares the module.'),
  name: Clean(PROJECT_MAP_LIMITS.nameLength)
    .nullable()
    .describe('The name the manifest declares, or null when it declares none.'),
  ecosystem: ModuleEcosystemSchema,
});
export type ModuleNode = z.infer<typeof ModuleNodeSchema>;

export const PackageNodeSchema = z.object({
  id: NodeIdSchema,
  kind: z.enum(['external-package', 'builtin']),
  name: Clean(PROJECT_MAP_LIMITS.nameLength),
});
export type PackageNode = z.infer<typeof PackageNodeSchema>;

export const MapNodeSchema = z.discriminatedUnion('kind', [
  FileNodeSchema,
  ModuleNodeSchema,
  PackageNodeSchema,
]);
export type MapNode = z.infer<typeof MapNodeSchema>;

/**
 * - imports, imports-type, re-exports, imports-dynamic, requires: a JavaScript or TypeScript file
 *   names the target in a string literal, resolved in the same tree.
 * - contains: a module governs a file (nearest package.json; nearest .asmdef for C#).
 * - compiles: a .csproj compiles a C# file (SDK default items and `<Compile Include>`).
 * - depends-on: a module declares a dependency on another module of the same tree.
 */
export const EdgeKindSchema = z.enum([
  'imports',
  'imports-type',
  're-exports',
  'imports-dynamic',
  'requires',
  'contains',
  'compiles',
  'depends-on',
]);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const FILE_EDGE_KINDS: readonly EdgeKind[] = [
  'imports',
  'imports-type',
  're-exports',
  'imports-dynamic',
  'requires',
];

export const EvidenceSchema = z.object({
  path: RepositoryPathSchema,
  line: z.number().int().positive().nullable().describe('1-based; null for a manifest-level fact.'),
});

export const MapEdgeSchema = z.object({
  id: EdgeIdSchema,
  from: NodeIdSchema,
  to: NodeIdSchema,
  kind: EdgeKindSchema,
  provenance: MapProvenanceSchema,
  rule: Text(PROJECT_MAP_LIMITS.ruleLength).describe(
    'How the edge was established, for example exact, ts-extension, probe, exports:development, nearest package.json.',
  ),
  evidence: z.array(EvidenceSchema).max(PROJECT_MAP_LIMITS.evidencePerEdge),
  count: z.number().int().positive().describe('How many places in the tree state this edge.'),
});
export type MapEdge = z.infer<typeof MapEdgeSchema>;

/**
 * What a language's files received. JavaScript and TypeScript get file edges; C# gets assembly and
 * project membership only (owner decision D6); everything else is listed and not analyzed.
 */
export const LanguageAnalysisSchema = z.enum(['file-edges', 'assembly-membership', 'none']);

export const LanguageCoverageSchema = z.object({
  language: LanguageSchema,
  analysis: LanguageAnalysisSchema,
  files: Count,
  bytes: Count,
  parsed: Count.describe('Files whose content was read and scanned.'),
  notParsed: z.object({
    tooLarge: Count.describe('Over the per-file byte bound; listed, not scanned.'),
    overBudget: Count.describe('Not scanned because the build reached its total byte bound.'),
    declaration: Count.describe('TypeScript declaration files, which hold no runtime imports.'),
    symlink: Count,
    missing: Count.describe(
      'The blob is not in the object store (a partial clone, or a damaged repository).',
    ),
  }),
  withModule: Count.describe('Files a module contains or compiles.'),
});

export const BoundNameSchema = z.enum([
  'files',
  'blob-bytes',
  'total-bytes',
  'nodes',
  'edges',
  'path-length',
  'unresolved-items',
  'listed-paths',
  'build-time',
  'scan-steps',
  'exports-size',
  'glob-complexity',
]);
export type BoundName = z.infer<typeof BoundNameSchema>;

export const UnresolvedReasonSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/)
  .describe(
    'For example no-tracked-file, outside-repository, export-target-not-tracked, not-exported, assembly-not-in-tree, guid-reference, project-not-in-tree.',
  );

export const UnresolvedItemSchema = z.object({
  from: NodeIdSchema,
  line: z.number().int().positive().nullable(),
  reference: Clean(512).describe('The specifier or reference as the source wrote it, clipped.'),
  reason: UnresolvedReasonSchema,
  package: Clean(PROJECT_MAP_LIMITS.nameLength).nullable(),
  edgeTo: z
    .enum(['module', 'none'])
    .describe(
      'module: an edge to the workspace package module was kept although no file resolved.',
    ),
});

export const CoverageSchema = z.object({
  complete: z
    .boolean()
    .describe(
      'False when any bound was reached, any file was omitted, or any blob was missing. The fields below say which, so a partial map is never silent.',
    ),
  bounds: z.object({
    files: Count,
    blobBytes: Count,
    totalBytes: Count,
    nodes: Count,
    edges: Count,
  }),
  boundsReached: z.array(BoundNameSchema).max(16),
  files: Count.describe('Tracked file entries listed as nodes.'),
  bytes: Count,
  omittedFiles: z
    .array(
      z.object({
        reason: z.enum(['path-too-long', 'path-control-characters', 'path-not-canonical']),
        count: Count,
      }),
    )
    .max(8),
  submodules: z.object({
    count: Count,
    paths: z.array(RepositoryPathSchema).max(PROJECT_MAP_LIMITS.listedPaths),
  }),
  languages: z.array(LanguageCoverageSchema).max(128),
  specifierKinds: z.object({
    import: Count,
    importType: Count,
    sideEffect: Count,
    exportFrom: Count,
    exportTypeFrom: Count,
    dynamic: Count,
    require: Count,
  }),
  dynamicImportsWithoutLiteral: Count,
  internalFileEdges: Count,
  unresolved: z.object({
    total: Count,
    byReason: z.array(z.object({ reason: UnresolvedReasonSchema, count: Count })).max(64),
    items: z.array(UnresolvedItemSchema).max(PROJECT_MAP_LIMITS.unresolvedItems),
    truncated: z.boolean(),
  }),
  manifestErrors: z.object({
    count: Count,
    paths: z.array(RepositoryPathSchema).max(PROJECT_MAP_LIMITS.listedPaths),
  }),
  notAnalyzed: z
    .array(z.object({ subject: Text(120), reason: Text(300) }))
    .min(1)
    .max(32)
    .describe('What this map does not claim. Absence of an edge here is unknown, not "none".'),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const MapRepositorySchema = z.object({
  root: RepositoryRootSchema,
  commit: ObjectIdSchema,
  tree: ObjectIdSchema,
  commitTime: Timestamp.describe("The commit's committer time, from the commit object."),
});

export const ProjectMapSchema = z.object({
  format: z.literal('salidium.project-map'),
  version: z.literal(0),
  experimental: z.literal(true),
  generatedAt: Timestamp,
  indexer: z.object({
    name: z.literal('salidium-project-map'),
    version: Text(32),
    git: Clean(64).describe(
      'The first line `git --version` printed for the binary that read the objects.',
    ),
  }),
  repository: MapRepositorySchema,
  coverage: CoverageSchema,
  nodes: z.array(MapNodeSchema).max(PROJECT_MAP_LIMITS.nodes),
  edges: z.array(MapEdgeSchema).max(PROJECT_MAP_LIMITS.edges),
});
export type ProjectMap = z.infer<typeof ProjectMapSchema>;

/** `GET /project-map/v0/repositories`: the repositories the person has opted in. */
export const OptedInRepositorySchema = z.object({
  root: RepositoryRootSchema,
  allowedAt: Timestamp,
});
export type OptedInRepository = z.infer<typeof OptedInRepositorySchema>;

export const MAX_OPTED_IN_REPOSITORIES = 64;

export const RepositoryListSchema = z.object({
  format: z.literal('salidium.project-map-repositories'),
  version: z.literal(0),
  experimental: z.literal(true),
  generatedAt: Timestamp,
  repositories: z.array(OptedInRepositorySchema).max(MAX_OPTED_IN_REPOSITORIES),
});
export type RepositoryList = z.infer<typeof RepositoryListSchema>;

/**
 * Every response under `/project-map`, refusals included, is one of these or a document above.
 *
 * - not-opted-in (404): the repository is not opted in. The daemon has not read it.
 * - commit-unknown (404): the object store has no commit with that id.
 * - over-bound (413): the tree is over a bound this version refuses to map; `message` names it.
 * - busy (429): another build is running or the build rate was reached. Retry later.
 * - repository-unsupported (422): the repository cannot be read safely or at all, for example its
 *   object store borrows from another directory through alternates, or the commit's tree is gone.
 */
export const ProjectMapErrorCodeSchema = z.enum([
  'host-not-allowed',
  'origin-not-allowed',
  'unauthorized',
  'not-found',
  'method-not-allowed',
  'bad-request',
  'not-opted-in',
  'commit-unknown',
  'over-bound',
  'busy',
  'repository-unsupported',
  'internal',
]);
export type ProjectMapErrorCode = z.infer<typeof ProjectMapErrorCodeSchema>;

export const ProjectMapErrorSchema = z.object({
  format: z.literal('salidium.project-map-error'),
  version: z.literal(0),
  error: ProjectMapErrorCodeSchema,
  message: Text(300),
});
export type ProjectMapError = z.infer<typeof ProjectMapErrorSchema>;

/** The entry the daemon lists in discovery's `experimental` array while a repository is opted in. */
export interface ProjectMapContractEntry {
  name: typeof PROJECT_MAP_CONTRACT.name;
  major: typeof PROJECT_MAP_CONTRACT.major;
  minor: typeof PROJECT_MAP_CONTRACT.minor;
  baseUrl: string;
}

export function projectMapContractEntry(port: number): ProjectMapContractEntry {
  return { ...PROJECT_MAP_CONTRACT, baseUrl: `http://127.0.0.1:${port}${PROJECT_MAP_BASE_PATH}` };
}

export const fileNodeId = (path: string): string => `file:${path}`;
