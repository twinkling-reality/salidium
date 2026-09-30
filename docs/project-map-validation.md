# Project map: validation record

- **Question:** Can Salidium produce a bounded, evidence-linked map of a real repository (files,
  modules and dependency edges at a pinned Git revision) and link one execution's changed files to
  it, so that a local consumer could show what changed and how it fits into the codebase? What
  would that cost, how fresh can it be, and what does the current consumer contract already give?
- **Date:** 2026-09-30.
- **Status:** an experiment, not a product feature. Nothing here is served by the daemon, and the
  consumer contract (`/consumer/v1`, [ADR 0005](decisions/0005-read-only-consumer-contract.md)) is
  unchanged. The read contract at the end is a proposal for review. No model was called.
- **Code:** [`scripts/project-map/`](../scripts/project-map/). Run its checks with
  `node --test scripts/project-map/project-map.test.mjs`.

## Method

- Two public repositories at pinned revisions: Halcyonic at `3cbe884` (TypeScript control plane
  plus a C# Unity client) and Salidium at `0e9269a` (TypeScript). The indexer reads the committed
  tree through `git ls-tree` and `git cat-file`, never the working tree, so ignored, untracked and
  uncommitted files cannot enter a map, and two runs at one revision read the same bytes.
- Real recorded sessions on both repositories from the maintainer's own store, read through the
  real `/consumer/v1` report route of a throwaway daemon over a copy of that store, with no
  provider adapters, no git enrichment and `SALIDIUM_EXPLAINER=off`. Further Halcyonic sessions
  were ingested from copied transcripts into a second throwaway store the same way, with no Codex
  binary on the path. Counts are kept out of this record, as CONTRIBUTING asks; rates are given
  instead, and the Halcyonic sample is small enough that its rates are indicative only.
- The import scanner was checked against esbuild's parser on every script of both revisions, and
  the resolver against esbuild's resolver on a Salidium checkout with dependencies installed.

## What consumer v1 already proves

For one execution, the session report carries observed identifiers, not structure:

| Carried | Not carried |
| --- | --- |
| Each changed file's absolute path, change count, line counts, kinds and last change time | The file's path relative to its repository, or which repository holds it |
| `repositoryRoot`, when Salidium observed one, and `cwd` | The revision the work started from or ended at, and the branch |
| Commit SHAs the session made, observed | Any relationship between files: imports, modules, components |
| File coverage (`inferred`) and the reason nearest a change (`reported`) | For a `move`, where the file came from |
| The optional explanation (`explained`): what, Why lanes and chain, How steps | Any reference from an explanation step to a file, check or event |

So a consumer can list what one execution touched and whether a check ran after it. It cannot
place those files in a codebase, and it cannot say which revision of the codebase they belong to.

Two properties of the real reports matter for any link:

- **Revision.** Salidium observes `HEAD` at session start and at turn ends for live sessions
  (`git.snapshot`), but only the latest value survives in run state and none of it crosses the
  contract. A session Salidium did not watch live, such as one imported from history, has no
  snapshot, and since `repositoryRoot` comes only from a snapshot it is null; a consumer falls back
  to `cwd`.
- **Where the files are.** A session's root is where it started, not where it wrote. Agents that
  work in a separate worktree, or that run from a scratch directory and edit a checkout, report
  absolute paths outside `repositoryRoot`. Every recorded path was absolute.

The explanation is plain text. Under 3% of real generated steps contain anything shaped like a
path, and none carries a reference. Linking a Why or How step to a file would mean inferring it
from prose, which this record does not do.

## The map prototype

Every tracked file is a node with its path, language, size and blob id. Manifests become module
nodes: `package.json`, `.csproj` and Unity `.asmdef`. Edges:

| Edge | From | Provenance and rule |
| --- | --- | --- |
| `imports`, `imports-type`, `re-exports`, `imports-dynamic`, `requires` | a JavaScript or TypeScript file | observed: a literal specifier in the source, resolved in the same tree by a named rule (`exact`, `ts-extension`, `probe`, `exports:<condition>`) |
| `contains` | a module | observed: the nearest `package.json`, or the nearest `.asmdef` for C# (Unity's own rule) |
| `compiles` | a `.csproj` | observed: SDK default items and `<Compile Include>` globs |
| `depends-on` | a module | observed: a `package.json` dependency on a package in the tree, a `<ProjectReference>`, an `.asmdef` reference |

The one inferred element is a `test` role on files named or placed like tests, labelled `inferred`
with its rule. Component names, data flow and intent are absent: they are not in the tree, and
producing them would need a model and an `explained` label.

Node ids are the path (`file:<path>`), and edge ids hash `from`, kind and `to`, so both survive
revisions that do not rename files; a node's blob id changes when its content does. The test suite
checks both.

| At the pinned revision | Halcyonic `3cbe884` | Salidium `0e9269a` |
| --- | --- | --- |
| Tracked files | 690 | 403 |
| Scripts parsed (all JavaScript and TypeScript) | 188 | 279 |
| Internal file edges | 601 | 770 |
| Scripts in at least one internal edge | 184 of 188 | 261 of 279 |
| Unresolved imports | 0 | 15, all of build output that is not in the tree |
| Module nodes | 25 | 13 |
| C# files placed in an assembly or project | 122 of 122 | none present |
| C# edges between files | not analyzed | not applicable |
| Map size, uncompressed JSON | 0.68 MB | 0.59 MB |

Checks against an independent parser:

- **Extraction.** esbuild found 860 distinct imports in Halcyonic's scripts and 1,087 in
  Salidium's. The scanner found every one. Everything it found beyond them was type-only, which
  esbuild erases, except one `require` through `createRequire`, which Node does execute and esbuild
  does not see as a call.
- **Resolution.** Of 734 relative and workspace imports in Salidium, the tree-only resolver named
  the same file as esbuild's resolver for 723. The other 11 import a package whose entry is build
  output (`dist/`), which the tree does not contain; the map keeps those as edges to the package's
  module node and lists them as unresolved to a file. The resolver never falls back to a guess.

**Cost.** One map is a single pass over the tree: well under a second for either repository on a
laptop, about the time `git ls-tree` and `git cat-file` take, and no model call. Rebuilding for
another revision costs the same, so the experiment built maps for many revisions without caching.
Neither repository is large; behaviour on tens of thousands of files is not measured.

## Linking real executions

A changed file links when it lies under the session's root and the map's revision tracks its
relative path. Nothing is matched by name or similarity. Three ways of choosing the root and the
revision were measured:

| Link method | Salidium sessions | Halcyonic sessions |
| --- | --- | --- |
| Consumer v1 alone: `repositoryRoot` (else `cwd`), map at the pinned revision | 87.5% of changed files | 1% for sessions whose root was not where they wrote; 74% for the others |
| Map at the `HEAD` Salidium observed at the session's last turn (internal, not in the contract) | 79% (84% for the same sessions at the pinned revision) | no snapshots: history imports |
| Each path resolved to the worktree that holds it today, then the pinned map | 87.5% | 50% for the sessions that wrote elsewhere; of the rest, 81% were files not at the pinned revision (new on worktree branches, or never committed) and 19% sat in worktrees that no longer exist |

What did not link, for Salidium at the pinned revision: 8% of paths were outside the session's
repository (other repositories, temporary directories and worktrees since removed), 2% were never
committed, 2% are tracked only at other revisions (renamed, deleted, or on branches never merged),
and under 1% are ignored by `.gitignore`.

- **A later revision links more than the session's own.** Files a session created are committed
  after it, so a map at the session's `HEAD` misses them. Neither revision is right on its own: the
  map describes a commit and the execution's overlay describes what changed since.
- **Observed revisions go stale in the repository, too.** About half of the recorded `HEAD` values
  of Salidium sessions no longer exist in the local repository; all of those were recorded in the
  three days around the rewrite of its history for publication. The median reachable one is 67 commits behind the pinned
  revision. A link needs the revision recorded at observation time and a fallback when it is gone.
- **Where it helps, the neighbourhood is small.** In 90% of Salidium sessions with changes, at
  least one changed file has import neighbours. A linked file has a median of 4 and a 90th
  percentile of 16 direct neighbours; the largest is 129. Changes to Markdown, CSS and JSON have
  none.
- **Halcyonic's recent work is mostly C# and documents.** Of the Halcyonic files that linked, most
  were C# or Markdown, and one had a file edge. For its XR client the map can say which assembly a
  file belongs to and which assemblies depend on it, not which files use it.
- **Some Codex sessions report no changed files.** Rollouts written by a newer Codex desktop build
  record edits as `item_completed` file-change items and as patches inside code-mode `exec`
  calls. Salidium 0.6.0's rollout parser reads neither, so real Codex sessions on Halcyonic that
  made commits report "No files changed". Until the adapter reads them, a map cannot link that work.

## Observed, inferred, unknown

| Element | Class |
| --- | --- |
| Files, blob ids, sizes, languages by extension | observed at the revision |
| Import, re-export and require edges; module membership and dependencies | observed, each with the rule that resolved it |
| Test role | inferred from naming, with the rule |
| A changed file's node | observed path equality, given the root and revision chosen |
| Which revision an execution belongs to | observed internally for live sessions; unknown for history imports; not in the contract |
| C# and other non-JavaScript file-to-file dependencies | unknown: not analyzed |
| Components, responsibilities, data flow, runtime calls | unknown: would be `explained`, with a model call |
| Links from explanation steps to evidence | unknown: the explanation carries no references |

## Proposal: a separate, versioned read contract

For review only. It is not implemented, and it does not change `/consumer/v1`.

1. **Anchor executions to revisions, inside v1, additively.** A minor version of the session
   report could add, as nullable observed properties, the `HEAD` at session start and at the latest
   turn end, the branch, and for each changed file its repository root and relative path, resolved
   when the change is observed. The ADR's rules allow added properties in a minor version. It needs
   a small reducer change, because run state keeps only the latest `HEAD`. Without it a consumer can
   link only by the root and guess the revision.
2. **A separate map document, `salidium.project-map` version 0, marked experimental.** Keyed by
   repository and commit: `repository` (commit, tree, commit time), `coverage` (per language, what
   was parsed, unresolved counts and a list of what is not analyzed), `nodes` (files with path,
   language and blob id; modules; external packages), and `edges` (id, from, to, kind,
   `provenance: 'observed'`, rule, and bounded evidence: path and line). Inferred roles carry
   `provenance: 'inferred'` and a rule. Built on request from committed trees only, cached per
   commit, and never with a model call. It would sit beside the consumer contract with its own
   version rather than extend v1, because its size and evolution differ from a session report.
3. **A per-execution link view.** For a session and a map commit: each changed file with its node
   id or a status (`not-in-map`, `outside-repository`, `repository-unknown`) and the node's direct
   neighbours. That is the "show how it fits together" step, and the measured neighbourhoods are
   small enough to show whole.

Before any of that is worth a version number: the Codex adapter has to record the file changes it
misses today, a decision is needed on C# (a compiler-based analysis or an explicit
assembly-level-only map), and a person has to find the neighbourhood view useful. Component and
flow views stay out of scope until their model cost is approved and their output is labelled
`explained`.

## Reproduce

```bash
node scripts/project-map/index-repository.mjs <repository> <revision> --out map.json
node scripts/project-map/crosscheck.mjs <repository> <revision> [--worktree <checkout>]
node --test scripts/project-map/project-map.test.mjs
```

The link measurements read real session reports and are not reproducible from this repository;
[`link.mjs`](../scripts/project-map/link.mjs) is the rule they applied.
