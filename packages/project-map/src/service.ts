import type { BoundName, OptedInRepository, ProjectMap, ProjectMapErrorCode } from './schemas.ts';

/**
 * The daemon's map service: the one way any route, including the execution links view, reaches a
 * repository.
 *
 * Every method takes a repository's main root: the realpath of its main working tree, which a
 * linked worktree resolves to through its `.git` file and `commondir`. Nothing is keyed by a
 * worktree path. A root that is not opted in is answered `not-opted-in` before anything under it is
 * read, so no caller can make the daemon read a repository the person did not opt in.
 *
 * Building is the service's alone: on request, never in the background, one build at a time, rate
 * limited, and cached per (repository, commit).
 */
export interface ProjectMapService {
  /** Whether the person has opted this main root in, read from the opt-in file now. */
  isOptedIn(mainRoot: string): boolean;
  /** The opted-in repositories, in the order they were allowed. */
  repositories(): OptedInRepository[];
  /**
   * Whether the repository's object store holds a commit with this full id. Reads the object store
   * only, and only for an opted-in root; `not-opted-in` otherwise.
   */
  commitExists(mainRoot: string, commit: string): Promise<CommitExistsResult>;
  /** The map at that commit, from the cache or built now, or a bounded refusal. */
  getMap(mainRoot: string, commit: string): Promise<MapResult>;
}

export type MapRefusalCode = Extract<
  ProjectMapErrorCode,
  | 'not-opted-in'
  | 'commit-unknown'
  | 'over-bound'
  | 'busy'
  | 'bad-request'
  | 'repository-unsupported'
>;

export interface MapRefusal {
  error: MapRefusalCode;
  /** Plain words, at most 300 characters, safe to show and to put in an error document. */
  message: string;
  /** For `over-bound`, the bound that was reached; otherwise null. */
  bound: BoundName | null;
}

export type MapResult = { ok: true; map: ProjectMap } | { ok: false; refusal: MapRefusal };

export type CommitExistsResult = { ok: true; exists: boolean } | { ok: false; refusal: MapRefusal };

/**
 * What a handler plugged into the map routes returns. The router writes it: a document as JSON
 * with status 200, or a `salidium.project-map-error` for a refusal. Handlers never touch the
 * response, so the guards, headers and error envelope stay the router's.
 */
export type RouteResult =
  | { status: 200; body: unknown }
  | { status: 400 | 404 | 413 | 422 | 429 | 500; error: ProjectMapErrorCode; message: string };

/**
 * The slot for `GET /project-map/v0/sessions/{id}/links`. The router authenticates the consumer
 * credential, applies the loopback guards, decodes the session id from one path segment, and only
 * then calls the handler. The handler reaches repositories only through `maps`.
 */
export type SessionLinksHandler = (request: {
  sessionId: string;
  query: URLSearchParams;
}) => Promise<RouteResult>;

export type SessionLinksHandlerFactory = (deps: { maps: ProjectMapService }) => SessionLinksHandler;
