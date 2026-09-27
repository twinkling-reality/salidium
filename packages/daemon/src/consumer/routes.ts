import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CONSUMER_BASE_PATH,
  type ConsumerDiscovery,
  type ConsumerError,
  type FeedMessage,
  NativeSessionIdSchema,
  ProviderIdSchema,
  type SessionList,
  type SessionLookup,
} from '@salidium/consumer-contract';
import { createRedactor, projectSession } from '@salidium/core';
import { makeSessionId, type ProviderId, parseSessionId } from '@salidium/protocol';
import type { Logger } from '../logging/logger.ts';
import { startSse } from '../server/sse.ts';
import { isUserSession, type SessionRegistry } from '../sessions/sessionRegistry.ts';
import type { ConsumerCredential, ConsumerCredentialVerifier } from './credentials.ts';
import { consumerText, toSessionEntry, toSessionReport } from './report.ts';

export interface ConsumerRouteDeps {
  registry: SessionRegistry;
  credentials: ConsumerCredentialVerifier;
  discovery: () => ConsumerDiscovery;
  now?: () => number;
  log: Logger;
}

export const DEFAULT_CONSUMER_LIST_LIMIT = 200;
export const MAX_CONSUMER_LIST_LIMIT = 2000;
/** A feed this far behind is not being read. It is closed, and the reconnect starts with resync. */
export const MAX_FEED_BUFFER_BYTES = 1024 * 1024;
const FEED_HEARTBEAT_MS = 15_000;
/** How quickly a revocation reaches an already open feed. Requests are checked every time. */
const FEED_REVOCATION_CHECK_MS = 2_000;

interface OpenFeed {
  credential: ConsumerCredential;
  close: (reason: 'credential-revoked' | 'shutting-down') => void;
}

/**
 * The consumer contract's HTTP surface, `/consumer/v1`.
 *
 * Read-only by construction: every method except GET is refused before authentication is even
 * considered, and no handler here reaches a registry method that ingests, forgets, configures,
 * or requests an explanation. Reading a report does not load a session coordinator either; see
 * `SessionRegistry.readSession`.
 *
 * The loopback Host and Origin checks in `httpServer.ts` run before this handler, unchanged.
 */
export function createConsumerRoutes(deps: ConsumerRouteDeps) {
  const { registry, credentials, log } = deps;
  const now = deps.now ?? Date.now;
  const text = consumerText(createRedactor());
  const feeds = new Set<OpenFeed>();

  const revocationTimer = setInterval(() => {
    for (const feed of feeds)
      if (!credentials.stillValid(feed.credential.id)) feed.close('credential-revoked');
  }, FEED_REVOCATION_CHECK_MS);
  revocationTimer.unref();

  /** Every response under `/consumer`, failures included, is a contract document. */
  function handle(req: IncomingMessage, res: ServerResponse, url: URL): undefined {
    try {
      return route(req, res, url);
    } catch (error) {
      log.warn('consumer request failed', { path: url.pathname, err: String(error) });
      if (!res.headersSent) return fail(res, 500, 'internal', 'the request could not be completed');
      res.destroy();
      return undefined;
    }
  }

  function route(req: IncomingMessage, res: ServerResponse, url: URL): undefined {
    res.setHeader('Cache-Control', 'no-store');
    const path = url.pathname;
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return fail(res, 405, 'method-not-allowed', 'the consumer contract is read-only');
    }
    if (path === `${CONSUMER_BASE_PATH}/discovery`) return json(res, 200, deps.discovery());

    const credential = authenticate(req);
    if (!credential) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="salidium-consumer"');
      return fail(
        res,
        401,
        'unauthorized',
        'a consumer credential is required; create one with `salidium consumer create <label>`',
      );
    }

    if (path === `${CONSUMER_BASE_PATH}/sessions`) return list(res, url);
    if (path === `${CONSUMER_BASE_PATH}/sessions/lookup`) return lookup(res, url);
    if (path === `${CONSUMER_BASE_PATH}/feed`) return feed(res, credential);
    const report = /^\/consumer\/v1\/sessions\/([^/]+)\/report$/.exec(path);
    if (report?.[1]) return sessionReport(res, report[1]);
    return fail(res, 404, 'not-found', 'no such consumer endpoint');
  }

  function authenticate(req: IncomingMessage): ConsumerCredential | undefined {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return undefined;
    return credentials.verify(header.slice(7));
  }

  function list(res: ServerResponse, url: URL): undefined {
    const raw = url.searchParams.get('limit');
    const limit = raw === null ? DEFAULT_CONSUMER_LIST_LIMIT : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONSUMER_LIST_LIMIT)
      return fail(
        res,
        400,
        'bad-request',
        `limit must be a whole number from 1 to ${MAX_CONSUMER_LIST_LIMIT}`,
      );
    const at = now();
    const all = registry.listSessions();
    const body: SessionList = {
      format: 'salidium.session-list',
      version: 1,
      generatedAt: new Date(at).toISOString(),
      sessions: all.slice(0, limit).map((summary) => toSessionEntry(summary, at, text)),
      total: all.length,
      truncated: all.length > limit,
    };
    json(res, 200, body);
  }

  function lookup(res: ServerResponse, url: URL): undefined {
    const provider = ProviderIdSchema.safeParse(url.searchParams.get('provider'));
    const sessionId = NativeSessionIdSchema.safeParse(url.searchParams.get('sessionId'));
    if (!provider.success || !sessionId.success)
      return fail(
        res,
        400,
        'bad-request',
        'provider and sessionId are required: the provider id and its own session id',
      );
    const summary = registry.summaryOf(makeSessionId(provider.data as ProviderId, sessionId.data));
    if (!summary || !isUserSession(summary))
      return fail(
        res,
        404,
        'session-not-observed',
        'Salidium has not observed this session. A session launched moments ago may not have reported yet.',
      );
    const at = now();
    const body: SessionLookup = {
      format: 'salidium.session-lookup',
      version: 1,
      generatedAt: new Date(at).toISOString(),
      session: toSessionEntry(summary, at, text),
    };
    json(res, 200, body);
  }

  function sessionReport(res: ServerResponse, encoded: string): undefined {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(encoded);
    } catch {
      return fail(res, 400, 'bad-request', 'the session id is not valid percent-encoding');
    }
    const read = registry.readSession(sessionId);
    if (!read || !isUserSession(read.summary))
      return fail(res, 404, 'not-found', 'no such session');
    const at = now();
    json(
      res,
      200,
      toSessionReport(read.state, projectSession(read.state, at), read.summary, at, text),
    );
  }

  function feed(res: ServerResponse, credential: ConsumerCredential): undefined {
    startSse(res);
    const stamp = () => new Date(now()).toISOString();
    let open = true;
    const send = (message: FeedMessage) => {
      if (!open) return;
      res.write(`data: ${JSON.stringify(message)}\n\n`);
      if (res.writableLength > MAX_FEED_BUFFER_BYTES) {
        log.warn('consumer feed closed: the reader fell too far behind', {
          credential: credential.id,
        });
        cleanup();
        res.destroy();
      }
    };
    const base = { format: 'salidium.session-feed', version: 1 } as const;
    send({ ...base, type: 'resync', at: stamp(), reason: 'connected' });

    // What this connection last told the consumer about each session, so a summary refresh that
    // changed nothing a consumer can see does not become a notification.
    const told = new Map<string, string>();
    const unsubscribeSummaries = registry.subscribeSummaries((summary) => {
      if (!isUserSession(summary)) return;
      const entry = toSessionEntry(summary, now(), text);
      const key = `${entry.evidenceSeq}|${entry.status}|${entry.explanation}`;
      if (told.get(entry.id) === key) return;
      told.set(entry.id, key);
      send({
        ...base,
        type: 'session.changed',
        at: stamp(),
        sessionId: entry.id,
        native: entry.native,
        evidenceSeq: entry.evidenceSeq,
        status: entry.status,
        explanation: entry.explanation,
      });
    });
    const unsubscribeRemovals = registry.subscribeRemovals((sessionId) => {
      told.delete(sessionId);
      const parsed = parseSessionId(sessionId);
      const native =
        parsed &&
        ProviderIdSchema.safeParse(parsed.provider).success &&
        NativeSessionIdSchema.safeParse(parsed.providerSessionId).success
          ? { provider: parsed.provider, sessionId: parsed.providerSessionId }
          : null;
      send({ ...base, type: 'session.removed', at: stamp(), sessionId, native });
    });
    const heartbeat = setInterval(
      () => send({ ...base, type: 'heartbeat', at: stamp() }),
      FEED_HEARTBEAT_MS,
    );
    heartbeat.unref();

    const entry: OpenFeed = {
      credential,
      close: (reason) => {
        send({ ...base, type: 'closing', at: stamp(), reason });
        cleanup();
        res.end();
      },
    };
    feeds.add(entry);
    function cleanup(): void {
      if (!open) return;
      open = false;
      feeds.delete(entry);
      unsubscribeSummaries();
      unsubscribeRemovals();
      clearInterval(heartbeat);
    }
    res.on('close', cleanup);
  }

  return {
    handle,
    /** The loopback guard's refusals, in the contract's own error envelope. */
    refuse(
      res: ServerResponse,
      status: 403 | 421,
      error: 'host-not-allowed' | 'origin-not-allowed',
      message: string,
    ): undefined {
      res.setHeader('Cache-Control', 'no-store');
      return fail(res, status, error, message);
    },
    close(): void {
      clearInterval(revocationTimer);
      for (const feed of [...feeds]) feed.close('shutting-down');
    },
  };
}

/** Returns `undefined` so a handler can end with `return json(...)` and still be typed as ending. */
function json(res: ServerResponse, status: number, body: unknown): undefined {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
  return undefined;
}

function fail(
  res: ServerResponse,
  status: number,
  error: ConsumerError['error'],
  message: string,
): undefined {
  const body: ConsumerError = { format: 'salidium.consumer-error', version: 1, error, message };
  return json(res, status, body);
}
