import { z } from 'zod';
import {
  EdgeIdSchema,
  EdgeKindSchema,
  EvidenceSchema,
  hasUnprintable,
  MapProvenanceSchema,
  ModuleEcosystemSchema,
  NodeIdSchema,
  ObjectIdSchema,
  PROJECT_MAP_LIMITS,
  RepositoryPathSchema,
  RoleSchema,
} from './schemas.ts';

/**
 * `salidium.execution-links` version 0: where one session's changed files sit in the codebase.
 *
 * Experimental, beside `salidium.project-map` version 0 and versioned with it. It joins two things
 * Salidium observed, the files a session changed (with the repository that held each one when the
 * change was live) and the revisions it saw at the session's boundaries, to a map of the committed
 * tree at one of those revisions. Nothing is matched by name or similarity: a file links only when
 * the map's commit tracks its exact repository path. Nothing here is written by a model, and no
 * component, responsibility or data flow is drawn, because the tree states none.
 *
 * Rings, from the session outward:
 *
 * - Ring 1, per changed file: the modules that contain it, and its direct neighbours, which are
 *   the files it imports and the files that import it, each with the edge kind and the rule.
 * - Ring 2, per module that contains a changed file: the module, and the modules that depend on it.
 *
 * Every property is always present. A value Salidium does not have is `null`.
 */
export const EXECUTION_LINKS_FORMAT = 'salidium.execution-links';

export const EXECUTION_LINKS_LIMITS = {
  files: 2000,
  repositories: 64,
  worktreesPerRepository: 32,
  modulesPerFile: 8,
  /** The validation record measured a median of 4 and a largest of 129 direct neighbours. */
  neighboursPerFile: 256,
  evidencePerNeighbour: 4,
  modules: 256,
  dependentsPerModule: 256,
  changedPerModule: 2000,
  /** Absolute paths as the session recorded them. */
  pathLength: 4096,
  branchLength: 256,
} as const;

const Timestamp = z.iso
  .datetime({ offset: false, precision: 3 })
  .describe('UTC, millisecond precision, trailing Z.');
const Count = z.number().int().nonnegative();
/**
 * The map's own rule for text a reader may print: no C0 or C1 controls, no bidirectional marks,
 * overrides or isolates, and no line or paragraph separators. A path shown in the panel, such as
 * the one in the copyable opt-in command, then displays as exactly what is copied.
 */
const printable = (text: string) => !hasUnprintable(text);
const UNPRINTABLE = 'no control, bidirectional or separator characters';

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(EXECUTION_LINKS_LIMITS.pathLength)
  .refine(printable, UNPRINTABLE)
  .refine((path) => path.startsWith('/'), 'an absolute path');

const RootSchema = AbsolutePathSchema.describe(
  'Absolute path of a working tree, resolved through symbolic links, without a trailing slash.',
);

export const RevisionAnchorSchema = z
  .object({
    root: RootSchema.nullable().describe(
      'The working tree the snapshot read, as Git reported its top level. Null when withheld because the redactor would alter it.',
    ),
    repository: RootSchema.nullable().describe(
      "That working tree's main repository: the tree itself, or for a linked worktree the repository Salidium observed it belongs to while the session ran. A revision is offered only to this repository. Null when withheld.",
    ),
    head: ObjectIdSchema.nullable().describe(
      'HEAD when Salidium looked; null on an unborn branch.',
    ),
    branch: z
      .string()
      .max(EXECUTION_LINKS_LIMITS.branchLength)
      .refine(printable, UNPRINTABLE)
      .nullable()
      .describe('The branch HEAD named, or null when detached, unknown or withheld.'),
    at: Timestamp,
    provenance: z.literal('observed'),
  })
  .describe(
    "Salidium's own read of a repository at one session boundary, while the session was live. A session can move between repositories, so each anchor names the one it read.",
  );
export type RevisionAnchor = z.infer<typeof RevisionAnchorSchema>;

/**
 * Why a repository has a map in this document or does not.
 */
export const RepositoryLinkStatusSchema = z
  .enum(['mapped', 'not-opted-in', 'no-revision', 'revision-gone', 'map-unavailable'])
  .describe(
    [
      'mapped: the map at `commit` is the one every file of this repository was linked against.',
      'not-opted-in: the person has not allowed Salidium to read this repository, so it was not read and there is no map. `salidium map allow <repository>` opts it in.',
      'no-revision: Salidium never observed a revision of this repository at a session boundary: a session imported from history, or a repository the session changed files in without starting or ending a turn there. No revision is claimed.',
      'revision-gone: Salidium observed revisions at the session boundaries, and none of them exists in the repository any more, for example after a rebase or a history rewrite.',
      'map-unavailable: there is no map now although the repository is opted in: the tree is over a bound version 0 maps, another build was running, or the repository cannot be read safely. `unavailable` says which, and `commit` names the revision when Salidium could confirm it exists.',
    ].join(' '),
  );
export type RepositoryLinkStatus = z.infer<typeof RepositoryLinkStatusSchema>;

export const CommitChoiceSchema = z
  .enum(['latest-turn-end', 'session-start'])
  .describe(
    'latest-turn-end: HEAD at the latest turn end, which exists. session-start: HEAD at session start, used because the latest turn-end HEAD was not observed or no longer exists.',
  );

export const RepositoryLinkSchema = z.object({
  root: RootSchema.describe(
    "The repository's main working tree. A linked worktree resolves to the repository it belongs to, by Git's own pointers.",
  ),
  worktrees: z
    .array(RootSchema)
    .max(EXECUTION_LINKS_LIMITS.worktreesPerRepository)
    .describe('The working trees the changed files were found in, the main one included if any.'),
  status: RepositoryLinkStatusSchema,
  commit: z
    .object({ id: ObjectIdSchema, chosen: CommitChoiceSchema, provenance: z.literal('observed') })
    .nullable()
    .describe(
      'The map commit for `mapped`; for `map-unavailable`, the revision that exists but could not be mapped, or null when the repository could not be read far enough to tell. Null otherwise.',
    ),
  unavailable: z
    .enum(['over-bound', 'busy', 'repository-unsupported'])
    .nullable()
    .describe(
      'For map-unavailable: over-bound, the tree is larger than version 0 maps; busy, another map was being built, so retry; repository-unsupported, the repository cannot be read safely, for example its object store borrows from another directory. Null otherwise.',
    ),
  commitTime: Timestamp.nullable().describe("The map commit's committer time, when mapped."),
  mapComplete: z
    .boolean()
    .nullable()
    .describe(
      "The map's own coverage.complete, when mapped: false means some bound was reached and an absent edge is unknown.",
    ),
});
export type RepositoryLink = z.infer<typeof RepositoryLinkSchema>;

/**
 * What became of one changed file.
 */
export const FileLinkStatusSchema = z
  .enum([
    'linked',
    'not-in-map',
    'outside-repository',
    'repository-unknown',
    'repository-not-mapped',
  ])
  .describe(
    [
      "linked: the map's commit tracks this exact path, and `node` is its node.",
      'not-in-map: the repository is mapped, but its commit does not track the path: a file added after that commit, or never committed.',
      'outside-repository: when the change happened, Salidium found no Git repository holding the path.',
      'repository-unknown: Salidium never looked for the repository holding the path, as for a session imported from history or recorded before it did.',
      "repository-not-mapped: the file's repository has no map in this document; its `status` says why.",
    ].join(' '),
  );
export type FileLinkStatus = z.infer<typeof FileLinkStatusSchema>;

export const ModuleRefSchema = z.object({
  id: NodeIdSchema,
  name: z.string().max(PROJECT_MAP_LIMITS.nameLength).nullable(),
  manifest: RepositoryPathSchema,
  ecosystem: ModuleEcosystemSchema,
});
export type ModuleRef = z.infer<typeof ModuleRefSchema>;

export const MembershipSchema = z.object({
  module: ModuleRefSchema,
  kind: z.enum(['contains', 'compiles']),
  provenance: MapProvenanceSchema,
  rule: z.string().max(PROJECT_MAP_LIMITS.ruleLength),
});

export const NeighbourSchema = z.object({
  direction: z
    .enum(['imports', 'imported-by'])
    .describe(
      'imports: the changed file names this one. imported-by: this one names the changed file.',
    ),
  edge: EdgeIdSchema,
  kind: EdgeKindSchema,
  provenance: MapProvenanceSchema,
  rule: z.string().max(PROJECT_MAP_LIMITS.ruleLength),
  node: NodeIdSchema,
  nodeKind: z.enum(['file', 'module', 'external-package', 'builtin']),
  path: RepositoryPathSchema.nullable().describe('For a file neighbour, its repository path.'),
  name: z
    .string()
    .max(PROJECT_MAP_LIMITS.nameLength)
    .nullable()
    .describe('For a module or package neighbour, its declared name.'),
  role: RoleSchema.nullable(),
  changed: z.boolean().describe('The session changed this neighbour too.'),
  evidence: z.array(EvidenceSchema).max(EXECUTION_LINKS_LIMITS.evidencePerNeighbour),
});
export type Neighbour = z.infer<typeof NeighbourSchema>;

export const FileLinkSchema = z.object({
  path: AbsolutePathSchema.describe('The changed path as the session recorded it.'),
  status: FileLinkStatusSchema,
  repository: RootSchema.nullable().describe('Main root of the repository found holding the file.'),
  worktree: RootSchema.nullable().describe('The working tree found holding the file.'),
  relativePath: z
    .string()
    .max(EXECUTION_LINKS_LIMITS.pathLength)
    .refine(printable, UNPRINTABLE)
    .nullable()
    .describe('The path relative to `worktree`, as Salidium observed it when the change was live.'),
  node: NodeIdSchema.nullable().describe('For linked, the file node in the map.'),
  role: RoleSchema.nullable().describe('For linked, the role the map infers from naming, if any.'),
  modules: z
    .array(MembershipSchema)
    .max(EXECUTION_LINKS_LIMITS.modulesPerFile)
    .describe('Ring 1: the modules that contain or compile the file at the map commit.'),
  neighbours: z
    .array(NeighbourSchema)
    .max(EXECUTION_LINKS_LIMITS.neighboursPerFile)
    .describe('Ring 1: every node the file imports or is imported by, up to the bound.'),
  neighboursTotal: Count,
  neighboursTruncated: z.boolean(),
});
export type FileLink = z.infer<typeof FileLinkSchema>;

export const DependentSchema = z.object({
  module: ModuleRefSchema,
  edge: EdgeIdSchema,
  provenance: MapProvenanceSchema,
  rule: z.string().max(PROJECT_MAP_LIMITS.ruleLength),
});

export const ModuleLinkSchema = z.object({
  repository: RootSchema,
  module: ModuleRefSchema,
  changedFiles: z
    .array(RepositoryPathSchema)
    .max(EXECUTION_LINKS_LIMITS.changedPerModule)
    .describe('The linked changed files the module contains or compiles.'),
  dependents: z
    .array(DependentSchema)
    .max(EXECUTION_LINKS_LIMITS.dependentsPerModule)
    .describe('Ring 2: modules that declare a dependency on this one.'),
  dependentsTotal: Count,
  dependentsTruncated: z.boolean(),
});
export type ModuleLink = z.infer<typeof ModuleLinkSchema>;

export const ExecutionLinksSchema = z.object({
  format: z.literal(EXECUTION_LINKS_FORMAT),
  version: z.literal(0),
  experimental: z.literal(true),
  generatedAt: Timestamp,
  sessionId: z.string().min(1).max(512).refine(printable, UNPRINTABLE),
  anchors: z.object({
    atStart: RevisionAnchorSchema.nullable(),
    atLatestTurnEnd: RevisionAnchorSchema.nullable(),
  }),
  repositories: z.array(RepositoryLinkSchema).max(EXECUTION_LINKS_LIMITS.repositories),
  files: z.array(FileLinkSchema).max(EXECUTION_LINKS_LIMITS.files),
  filesTotal: Count.describe(
    'Changed files the session recorded. `files` holds them newest first, up to its bound.',
  ),
  filesOmitted: Count.describe(
    'Changed paths this version cannot carry: not absolute, longer than the bound, holding control characters, or holding text the redactor would change, which would make the path name something else. Counted, never dropped silently.',
  ),
  mapElementsWithheld: Count.describe(
    'Map nodes and edges left out because the redactor would alter their text, so a neighbour or module may be missing. Counted, never dropped silently.',
  ),
  modules: z
    .array(ModuleLinkSchema)
    .max(EXECUTION_LINKS_LIMITS.modules)
    .describe('Ring 2, one entry per module that contains a linked changed file.'),
  modulesTruncated: z.boolean(),
});
export type ExecutionLinks = z.infer<typeof ExecutionLinksSchema>;
