import { join } from 'node:path';
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
import { RepositoryLocator } from '../enrichers/fileLocation.ts';
import type { Logger } from '../logging/logger.ts';
import { isUserSession, type SessionRegistry } from '../sessions/sessionRegistry.ts';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface SessionLinksDeps {
  registry: Pick<SessionRegistry, 'readSession'>;
  /** Finds the main repository of the session's own root. Defaults to the shared locator rules. */
  locator?: Pick<RepositoryLocator, 'locate'>;
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
  const locator = deps.locator ?? new RepositoryLocator();
  const now = deps.now ?? Date.now;
  const redactor = createRedactor();

  async function document(
    maps: ProjectMapService,
    sessionId: string,
  ): Promise<ExecutionLinks | undefined> {
    const read = deps.registry.readSession(sessionId);
    if (!read || !isUserSession(read.summary)) return undefined;
    const { state } = read;
    const files = changedFiles(state);
    const anchors = await sessionAnchors(state, locator);
    const repositories = new Map<string, RepositoryResolution>();
    for (const root of repositoriesOf(files).slice(0, EXECUTION_LINKS_LIMITS.repositories))
      repositories.set(root, await resolveRepository(maps, anchors, root));
    const doc = linkExecution({
      sessionId,
      generatedAt: new Date(now()).toISOString(),
      anchors,
      files,
      repositories,
    });
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
 * repository comes first from what Salidium observed when files changed there, and otherwise from
 * the same read-only pointer rules today. When neither answers, the root stands for itself, which
 * at worst makes a repository read `no-revision` rather than borrow a revision that is not its own.
 */
export async function sessionAnchors(
  state: RunState,
  locator: Pick<RepositoryLocator, 'locate'>,
): Promise<SessionAnchors> {
  const atStart = anchor(state.git.atStart);
  const atLatestTurnEnd = anchor(state.git.atTurnEnd);
  const root = state.repoRoot;
  if (!root || (!atStart && !atLatestTurnEnd))
    return { repository: null, atStart, atLatestTurnEnd };
  const observed = Object.values(state.fileLocations).find((location) => location?.root === root);
  if (observed) return { repository: repositoryOf(observed), atStart, atLatestTurnEnd };
  // A child of the root, so the walk starts at the root itself; the name is never opened.
  const located = await locator.locate(join(root, '.salidium-locate'));
  return {
    repository: located ? repositoryOf(located) : root,
    atStart,
    atLatestTurnEnd,
  };
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
