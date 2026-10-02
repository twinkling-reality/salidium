import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type { Redactor, RunState, RevisionAnchor as RunStateAnchor } from '@salidium/core';
import { createRedactor } from '@salidium/core';
import {
  type ChangedFile,
  EXECUTION_LINKS_LIMITS,
  type ExecutionLinks,
  ExecutionLinksSchema,
  linkExecution,
  type ProjectMapService,
  type RepositoryResolution,
  type RevisionAnchor,
  type RouteResult,
  repositoriesOf,
  repositoryOf,
  resolveRepository,
  type SessionAnchors,
  type SessionLinksHandlerFactory,
} from '@salidium/project-map';
import type { Logger } from '../logging/logger.ts';
import { isUserSession, type SessionRegistry } from '../sessions/sessionRegistry.ts';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface SessionLinksDeps {
  registry: Pick<SessionRegistry, 'readSession'>;
  now?: () => number;
  log: Logger;
}

/**
 * The `salidium.execution-links` document for one session: where its changed files sit in the
 * codebase, at the revision Salidium observed it at.
 *
 * Both the consumer route (`/project-map/v0/sessions/{id}/links`) and the interface's owner route
 * (`/api/sessions/{id}/links`) serve exactly this, so the opt-in rule cannot differ between them:
 * every repository is reached through `maps`, which refuses one the person has not opted in before
 * reading anything under it.
 *
 * Reading changes nothing. The session is read the way consumer reports are, without loading a
 * coordinator, and nothing here schedules work other than the map build the service performs on
 * request, serialized and rate limited by the service itself.
 */
export function createSessionLinks(deps: SessionLinksDeps) {
  const now = deps.now ?? Date.now;

  async function document(
    maps: ProjectMapService,
    sessionId: string,
  ): Promise<ExecutionLinks | undefined> {
    const read = deps.registry.readSession(sessionId);
    if (!read || !isUserSession(read.summary)) return undefined;
    const { state } = read;
    // One redactor per document, so numbering never depends on what earlier requests saw.
    const redactor = createRedactor();
    const unchanged = (value: string) => redactor.redact(value).text === value;
    const all = changedFiles(state);
    // An identifier is carried whole or not at all: a changed path or root the redactor would
    // alter names something else, so the file is counted as withheld rather than half-shown.
    const files = all.filter(
      (file) =>
        unchanged(file.path) &&
        (!file.location ||
          (unchanged(file.location.root) &&
            unchanged(file.location.path) &&
            (file.location.mainRoot === undefined || unchanged(file.location.mainRoot)))),
    );
    const anchors = withheldBranches(sessionAnchors(state), unchanged);
    const repositories = new Map<string, RepositoryResolution>();
    for (const root of repositoriesOf(files).slice(0, EXECUTION_LINKS_LIMITS.repositories))
      repositories.set(root, await resolveRepository(maps, anchors, root));
    const doc = linkExecution({
      sessionId,
      generatedAt: new Date(now()).toISOString(),
      anchors,
      files,
      withheld: all.length - files.length,
      repositories,
    });
    // Map-derived names and rules from the opted-in tree pass the redactor too, as any text does.
    return ExecutionLinksSchema.parse(redactStrings(doc, redactor));
  }

  const handler: SessionLinksHandlerFactory =
    ({ maps }) =>
    async ({ sessionId }): Promise<RouteResult> => {
      try {
        const doc = await document(maps, sessionId);
        if (!doc) return { status: 404, error: 'not-found', message: 'no such session' };
        return { status: 200, body: doc };
      } catch (error) {
        deps.log.warn('execution links failed', { sessionId, err: String(error) });
        return { status: 500, error: 'internal', message: 'the links could not be computed' };
      }
    };

  return { document, handler };
}

/** Changed files, newest change first, each with the location observed when it was live. */
export function changedFiles(state: RunState): ChangedFile[] {
  return Object.values(state.files)
    .sort((a, b) => b.lastChangeSeq - a.lastChangeSeq || (a.path < b.path ? -1 : 1))
    .map((file) => ({
      path: file.path,
      // Absent means Salidium never looked; null means it looked and found no repository.
      location: Object.hasOwn(state.fileLocations, file.path)
        ? state.fileLocations[file.path]
        : undefined,
    }));
}

/** A branch name the redactor would change is not carried; the anchor's HEAD still is. */
function withheldBranches(anchors: SessionAnchors, unchanged: (value: string) => boolean) {
  const keep = (a: RevisionAnchor | null) =>
    a && a.branch !== null && !unchanged(a.branch) ? { ...a, branch: null } : a;
  return {
    ...anchors,
    atStart: keep(anchors.atStart),
    atLatestTurnEnd: keep(anchors.atLatestTurnEnd),
  };
}

function anchor(value: RunStateAnchor | undefined): RevisionAnchor | null {
  if (!value) return null;
  const branch =
    value.branch !== undefined && value.branch.length <= EXECUTION_LINKS_LIMITS.branchLength
      ? value.branch
      : null;
  return {
    head: value.head && FULL_SHA.test(value.head) ? value.head : null,
    branch,
    at: value.at,
    provenance: 'observed',
  };
}

/**
 * The session's revision anchors and the main repository they were read in.
 *
 * Snapshots name the working tree they read (`repoRoot`), which may be a linked worktree. Its main
 * repository is taken only from what Salidium observed while the session ran, the location of a
 * file changed in that tree; otherwise the root stands for itself. Nothing is read from disk now,
 * because the disk now says nothing about the disk then, and at worst a repository then reads
 * `no-revision` rather than borrow a revision that is not its own.
 *
 * Run state keeps one root, from the first snapshot, while a turn-end snapshot reads wherever the
 * session's directory is at that moment. A session whose directory has left its root may have a
 * turn-end HEAD from another repository, so that anchor is not used for it.
 */
export function sessionAnchors(
  state: RunState,
  stillInRoot: (cwd: string, root: string) => boolean = within,
): SessionAnchors {
  const root = state.repoRoot;
  const atStart = anchor(state.git.atStart);
  const atLatestTurnEnd = root && stillInRoot(state.cwd, root) ? anchor(state.git.atTurnEnd) : null;
  if (!root || (!atStart && !atLatestTurnEnd))
    return { repository: null, atStart, atLatestTurnEnd };
  const observed = Object.values(state.fileLocations).find((location) => location?.root === root);
  return { repository: observed ? repositoryOf(observed) : root, atStart, atLatestTurnEnd };
}

/**
 * Whether a session directory lies in a working tree. Git reports its top level through symbolic
 * links (`/tmp` is `/private/tmp` on macOS) while a provider reports the directory it was given,
 * so the directory's real path is tried too. Resolving it reads no file.
 */
function within(cwd: string, root: string): boolean {
  const inside = (dir: string) => {
    const rel = relative(root, dir);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  if (inside(cwd)) return true;
  try {
    return inside(realpathSync(cwd));
  } catch {
    return false;
  }
}

/**
 * Every string that crosses passes the redactor again, as the consumer report's do: paths and
 * names are identifiers and are never clipped, but a secret that reached a file name is not
 * repeated here. Object ids, timestamps and enumeration values hold nothing the rules match.
 */
function redactStrings<T>(value: T, redactor: Redactor): T {
  if (typeof value === 'string') return redactor.redact(value).text as T;
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redactor)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item, redactor)]),
    ) as T;
  return value;
}
