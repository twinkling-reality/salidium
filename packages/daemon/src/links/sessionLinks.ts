import type { Redactor, RunState, RevisionAnchor as RunStateAnchor } from '@salidium/core';
import { createRedactor } from '@salidium/core';
import {
  type ChangedFile,
  EXECUTION_LINKS_LIMITS,
  type ExecutionLinks,
  ExecutionLinksSchema,
  type FileLink,
  hasUnprintable,
  linkExecution,
  type ModuleLink,
  type ModuleRef,
  type ProjectMap,
  type ProjectMapService,
  type RepositoryResolution,
  type RevisionAnchor,
  type RouteResult,
  repositoriesOf,
  repositoryOf,
  representable,
  resolveRepository,
  type SessionAnchors,
  type SessionLinksHandlerFactory,
} from '@salidium/project-map';
import type { SessionSummary } from '@salidium/protocol';
import type { Logger } from '../logging/logger.ts';
import { isUserSession, type SessionRegistry } from '../sessions/sessionRegistry.ts';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Documents kept, by session, and for how long one may be served again unchanged. */
const DOCUMENTS = 64;
const DOCUMENT_MS = 60_000;

export interface SessionLinksDeps {
  registry: Pick<SessionRegistry, 'readSession'>;
  /**
   * Whether the consumer contract describes a stored session (its `entryOf` rule). Links never
   * serves a session the contract leaves out. Without it, user sessions are served.
   */
  represents?: (summary: SessionSummary) => boolean;
  now?: () => number;
  /** The redactor the carry-whole-or-withhold checks use. Tests count its calls. */
  redactor?: () => Redactor;
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
 * coordinator, and nothing here schedules work other than what the map service does on request,
 * serialized and rate limited by the service itself.
 *
 * What a request costs is bounded by what the document carries, not by the size of the map. The map
 * is linked first and only the strings that cross are checked; each check is remembered for as long
 * as the service keeps that map object in memory. A finished document is served again while the
 * session and the opt-in file are unchanged, for up to a minute.
 */
export function createSessionLinks(deps: SessionLinksDeps) {
  const now = deps.now ?? Date.now;
  const redactorFor = deps.redactor ?? createRedactor;
  const represents = deps.represents ?? isUserSession;
  /** Per map object: each string's answer to "would the redactor leave it as it is?". */
  const textChecks = new WeakMap<ProjectMap, Map<string, boolean>>();
  const documents = new Map<string, { key: string; at: number; doc: ExecutionLinks }>();

  function remember(sessionId: string, key: string, doc: ExecutionLinks): void {
    documents.delete(sessionId);
    documents.set(sessionId, { key, at: now(), doc });
    for (const oldest of documents.keys()) {
      if (documents.size <= DOCUMENTS) break;
      documents.delete(oldest);
    }
  }

  async function document(
    maps: ProjectMapService,
    sessionId: string,
  ): Promise<ExecutionLinks | undefined> {
    // An id the document cannot carry (over its bound, or unprintable) belongs to no session this
    // view can describe: not found, as on every other session route.
    if (!ExecutionLinksSchema.shape.sessionId.safeParse(sessionId).success) return undefined;
    const read = deps.registry.readSession(sessionId);
    if (!read || !represents(read.summary)) return undefined;
    const { state } = read;
    // The opt-in file's content as the service reads it: any grant, revocation or re-grant changes
    // it, and with it every answer below.
    const key = `${state.latestSeq}\0${JSON.stringify(maps.repositories())}`;
    const kept = documents.get(sessionId);
    if (kept && kept.key === key && now() - kept.at < DOCUMENT_MS) return kept.doc;

    const redactor = redactorFor();
    const unchanged = (value: string) => redactor.redact(value).text === value;
    const all = changedFiles(state);
    // An identifier is carried whole or not at all: a changed path or root the redactor would
    // alter names something else, so the file is counted as withheld rather than half-shown.
    const files = all.filter(
      (file) =>
        representable(file) &&
        unchanged(file.path) &&
        (!file.location ||
          (unchanged(file.location.root) &&
            unchanged(file.location.path) &&
            (file.location.mainRoot === undefined || unchanged(file.location.mainRoot)))),
    );
    const anchors = withheldAnchorText(sessionAnchors(state), unchanged);
    const repositories = new Map<string, RepositoryResolution>();
    for (const root of repositoriesOf(files).slice(0, EXECUTION_LINKS_LIMITS.repositories))
      repositories.set(root, await resolveRepository(maps, anchors, root));
    const linked = linkExecution({
      sessionId,
      generatedAt: new Date(now()).toISOString(),
      anchors,
      files,
      withheld: all.length - files.length,
      repositories,
    });
    const doc = ExecutionLinksSchema.parse(
      withholdMapText(linked, (repository, text) => {
        const resolved = repositories.get(repository);
        if (resolved?.status !== 'mapped') return unchanged(text);
        let checks = textChecks.get(resolved.map);
        if (!checks) {
          checks = new Map();
          textChecks.set(resolved.map, checks);
        }
        let answer = checks.get(text);
        if (answer === undefined) {
          answer = unchanged(text);
          checks.set(text, answer);
        }
        return answer;
      }),
    );
    // A refusal for now (busy, or a bound) is asked again next time rather than served from here.
    if (![...repositories.values()].some((r) => r.status === 'map-unavailable'))
      remember(sessionId, key, doc);
    return doc;
  }

  const handler: SessionLinksHandlerFactory = ({ maps }) => {
    return async ({ sessionId }): Promise<RouteResult> => {
      try {
        const doc = await document(maps, sessionId);
        if (!doc) return { status: 404, error: 'not-found', message: 'no such session' };
        return { status: 200, body: doc };
      } catch (error) {
        deps.log.warn('execution links failed', { sessionId, err: String(error) });
        return { status: 500, error: 'internal', message: 'the links could not be computed' };
      }
    };
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

/**
 * Anchor text the redactor would change is not carried: a branch becomes null, and a root or
 * repository becomes null too, which leaves that anchor offered to no repository. HEAD still is.
 */
function withheldAnchorText(
  anchors: SessionAnchors,
  unchanged: (value: string) => boolean,
): SessionAnchors {
  const keep = (a: RevisionAnchor | null): RevisionAnchor | null => {
    if (!a) return a;
    const place =
      (a.root === null || unchanged(a.root)) && (a.repository === null || unchanged(a.repository));
    return {
      ...a,
      root: place ? a.root : null,
      repository: place ? a.repository : null,
      branch: a.branch !== null && !unchanged(a.branch) ? null : a.branch,
    };
  };
  return { atStart: keep(anchors.atStart), atLatestTurnEnd: keep(anchors.atLatestTurnEnd) };
}

/**
 * One anchor, with the main repository it was read in.
 *
 * A snapshot names the working tree it read, which may be a linked worktree. Its main repository is
 * taken only from what Salidium observed while the session ran, the location of a file changed in
 * that tree; otherwise the tree stands for itself. Nothing is read from disk now, because the disk
 * now says nothing about the disk then, and at worst a repository then reads `no-revision` rather
 * than borrow a revision that is not its own.
 */
function anchor(state: RunState, value: RunStateAnchor | undefined): RevisionAnchor | null {
  if (!value) return null;
  const branch =
    value.branch !== undefined && value.branch.length <= EXECUTION_LINKS_LIMITS.branchLength
      ? value.branch
      : null;
  const carriable = carriableRoot(value.root);
  const observed = carriable
    ? Object.values(state.fileLocations).find((location) => location?.root === value.root)
    : undefined;
  return {
    root: carriable ? value.root : null,
    repository: !carriable ? null : observed ? repositoryOf(observed) : value.root,
    head: value.head && FULL_SHA.test(value.head) ? value.head : null,
    branch,
    at: value.at,
    provenance: 'observed',
  };
}

/** Each boundary's anchor names the repository it read, so a session that moved is not misread. */
export function sessionAnchors(state: RunState): SessionAnchors {
  return {
    atStart: anchor(state, state.git.atStart),
    atLatestTurnEnd: anchor(state, state.git.atTurnEnd),
  };
}

function carriableRoot(root: string): boolean {
  return (
    root.startsWith('/') &&
    root.length <= EXECUTION_LINKS_LIMITS.pathLength &&
    !hasUnprintable(root)
  );
}

/**
 * The document with every map-derived element whose text the redactor would alter left out, and
 * how many were. A path or name that crosses altered names something else, and a placeholder longer
 * than what it replaced could push a value past its bound, so the element is withheld, as the
 * session's own identifiers are. Only what the document carries is checked: the changed files'
 * modules and neighbours, and the containing modules' dependents, never the rest of the map.
 */
export function withholdMapText(
  doc: ExecutionLinks,
  unchanged: (repository: string, text: string) => boolean,
): ExecutionLinks {
  let withheld = 0;
  let omitted = 0;
  const moduleOk = (ok: (text: string) => boolean, module: ModuleRef) =>
    ok(module.id) && ok(module.manifest) && (module.name === null || ok(module.name));
  const files: FileLink[] = [];
  for (const file of doc.files) {
    const repository = file.repository;
    if (file.status !== 'linked' || repository === null) {
      files.push(file);
      continue;
    }
    const ok = (text: string) => unchanged(repository, text);
    if (file.node !== null && !ok(file.node)) {
      omitted += 1;
      continue;
    }
    let role = file.role;
    if (role && !ok(role.rule)) {
      role = null;
      withheld += 1;
    }
    const modules = file.modules.filter((m) => {
      const keep = moduleOk(ok, m.module) && ok(m.rule);
      if (!keep) withheld += 1;
      return keep;
    });
    let dropped = 0;
    const neighbours = file.neighbours.flatMap((n) => {
      const keep =
        ok(n.node) &&
        (n.path === null || ok(n.path)) &&
        (n.name === null || ok(n.name)) &&
        ok(n.rule) &&
        (n.role === null || ok(n.role.rule));
      if (!keep) {
        dropped += 1;
        return [];
      }
      const evidence = n.evidence.filter((e) => ok(e.path));
      return [evidence.length === n.evidence.length ? n : { ...n, evidence }];
    });
    withheld += dropped;
    files.push({
      ...file,
      role,
      modules,
      neighbours,
      neighboursTotal: file.neighboursTotal - dropped,
    });
  }
  const modules: ModuleLink[] = [];
  for (const entry of doc.modules) {
    const ok = (text: string) => unchanged(entry.repository, text);
    if (!moduleOk(ok, entry.module)) {
      withheld += 1;
      continue;
    }
    let dropped = 0;
    const dependents = entry.dependents.filter((d) => {
      const keep = moduleOk(ok, d.module) && ok(d.rule);
      if (!keep) dropped += 1;
      return keep;
    });
    withheld += dropped;
    modules.push({ ...entry, dependents, dependentsTotal: entry.dependentsTotal - dropped });
  }
  return {
    ...doc,
    files,
    modules,
    filesOmitted: doc.filesOmitted + omitted,
    mapElementsWithheld: doc.mapElementsWithheld + withheld,
  };
}
