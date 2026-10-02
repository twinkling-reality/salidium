import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ObjectIdSchema,
  PROJECT_MAP_BASE_PATH,
  type ProjectMapError,
  type ProjectMapService,
  type RepositoryList,
  RepositoryRootSchema,
  type RouteResult,
  type SessionLinksHandler,
} from '@salidium/project-map';
import type { ConsumerCredentialVerifier } from '../consumer/credentials.ts';
import type { Logger } from '../logging/logger.ts';

export interface ProjectMapRouteDeps {
  maps: ProjectMapService;
  /** The consumer credential file's verifier: the map is read with the same credential. */
  credentials: ConsumerCredentialVerifier;
  /** The execution links view, when the daemon provides one. */
  sessionLinks?: SessionLinksHandler;
  now?: () => number;
  log: Logger;
}

const STATUS: Record<Exclude<RouteResult, { status: 200 }>['error'], number> = {
  'host-not-allowed': 421,
  'origin-not-allowed': 403,
  unauthorized: 401,
  'not-found': 404,
  'method-not-allowed': 405,
  'bad-request': 400,
  'not-opted-in': 404,
  'commit-unknown': 404,
  'over-bound': 413,
  busy: 429,
  'repository-unsupported': 422,
  internal: 500,
};

/** A path under the map's own prefix, so the server can route it before the owner check. */
export const isProjectMapPath = (pathname: string): boolean =>
  pathname === '/project-map' || pathname.startsWith('/project-map/');

/**
 * The experimental project map's HTTP surface, `/project-map/v0`.
 *
 * Read-only, like the consumer contract beside it: every method other than GET is refused before
 * authentication, and every request needs a consumer credential. The owner token opens nothing
 * here. A repository is named by its opted-in main root and a commit by its full id; the service
 * answers `not-opted-in` before reading anything, so no request can make the daemon read a
 * repository the person has not opted in. Every response, refusals included, is a document of the
 * map's own vocabulary.
 *
 * The loopback Host and Origin checks in `httpServer.ts` run before this handler, unchanged.
 */
export function createProjectMapRoutes(deps: ProjectMapRouteDeps) {
  const { maps, credentials, log } = deps;
  const now = deps.now ?? Date.now;

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try {
      await route(req, res, url);
    } catch (error) {
      log.warn('project map request failed', { path: url.pathname, err: String(error) });
      if (!res.headersSent) fail(res, 'internal', 'the request could not be completed');
      else res.destroy();
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return fail(res, 'method-not-allowed', 'the project map is read-only');
    }
    if (!authenticate(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="salidium-consumer"');
      return fail(
        res,
        'unauthorized',
        'a consumer credential is required; create one with `salidium consumer create <label>`',
      );
    }
    const path = url.pathname;
    if (path === `${PROJECT_MAP_BASE_PATH}/repositories`) return repositories(res);
    if (path === `${PROJECT_MAP_BASE_PATH}/maps`) return map(res, url);
    const links = /^\/project-map\/v0\/sessions\/([^/]+)\/links$/.exec(path);
    if (links?.[1] && deps.sessionLinks) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(links[1]);
      } catch {
        return fail(res, 'bad-request', 'the session id is not valid percent-encoding');
      }
      return write(res, await deps.sessionLinks({ sessionId, query: url.searchParams }));
    }
    return fail(res, 'not-found', 'no such project map endpoint');
  }

  function authenticate(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return false;
    return credentials.verify(header.slice(7)) !== undefined;
  }

  function repositories(res: ServerResponse): void {
    const body: RepositoryList = {
      format: 'salidium.project-map-repositories',
      version: 0,
      experimental: true,
      generatedAt: new Date(now()).toISOString(),
      repositories: maps.repositories(),
    };
    json(res, 200, body);
  }

  async function map(res: ServerResponse, url: URL): Promise<void> {
    const repository = RepositoryRootSchema.safeParse(url.searchParams.get('repository'));
    const commit = ObjectIdSchema.safeParse(url.searchParams.get('commit'));
    if (!repository.success || !commit.success)
      return fail(
        res,
        'bad-request',
        'repository (an opted-in absolute root) and commit (a full 40- or 64-hex id) are required',
      );
    const result = await maps.getMap(repository.data, commit.data);
    if (result.ok) return json(res, 200, result.map);
    if (result.refusal.error === 'busy') res.setHeader('Retry-After', '10');
    return fail(res, result.refusal.error, result.refusal.message);
  }

  function write(res: ServerResponse, result: RouteResult): void {
    if (result.status === 200) return json(res, 200, result.body);
    return fail(res, result.error, result.message, result.status);
  }

  return {
    handle,
    /** The loopback guard's refusals, in the map's own error envelope. */
    refuse(
      res: ServerResponse,
      error: 'host-not-allowed' | 'origin-not-allowed',
      message: string,
    ): undefined {
      res.setHeader('Cache-Control', 'no-store');
      fail(res, error, message);
      return undefined;
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function fail(
  res: ServerResponse,
  error: ProjectMapError['error'],
  message: string,
  status: number = STATUS[error],
): void {
  const body: ProjectMapError = {
    format: 'salidium.project-map-error',
    version: 0,
    error,
    message: message.slice(0, 300),
  };
  json(res, status, body);
}
