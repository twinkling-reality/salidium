import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CONSUMER_BASE_PATH,
  type ConsumerDiscovery,
  ConsumerDiscoverySchema,
  type ConsumerError,
  type FeedMessage,
  FeedMessageSchema,
  NativeSessionIdSchema,
  ProviderIdSchema,
  type SessionEntry,
  SessionEntrySchema,
  type SessionList,
  SessionListSchema,
  type SessionLookup,
  SessionLookupSchema,
  SessionReportSchema,
} from '@salidium/consumer-contract';
import { createRedactor, projectSession } from '@salidium/core';
import {
  makeSessionId,
  type ProviderId,
  parseSessionId,
  type SessionSummary,
} from '@salidium/protocol';
import type { z } from 'zod';
import type { Logger } from '../logging/logger.ts';
import { startSse } from '../server/sse.ts';
import { isUserSession, type SessionRegistry } from '../sessions/sessionRegistry.ts';
import type { ConsumerCredential, ConsumerCredentialVerifier } from './credentials.ts';
import {
  consumerText,
  currentStatus,
  MAX_CONSUMER_PATH,
  toSessionEntry,
  toSessionReport,
} from './report.ts';

export interface ConsumerRouteDeps {
  registry: SessionRegistry;
  credentials: ConsumerCredentialVerifier;
  discovery: () => ConsumerDiscovery;
  now?: () => number;
  log: Logger;
}

export const DEFAULT_CONSUMER_LIST_LIMIT = 200;
export const MAX_CONSUMER_LIST_LIMIT = 2000;
/**
 * How many sessions' list entries are remembered, most recent first. Past it a list still works,
 * and the older sessions are built and checked on every request as before.
 */
export const MAX_CACHED_LIST_ENTRIES = 10_000;
/** The contract's bound on Salidium's own session id, which repeats the provider's. */
const MAX_SESSION_ID = 1100;
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

  /*
   * The producer's rule: every document served here passes its own exact parse. The store keeps
   * what providers wrote, unbounded, and the contract bounds what crosses, so a stored session can
   * hold a value no valid document can carry. Two layers keep one such value from making a
   * consumer's whole list or feed fail validation.
   *
   * `entryOf` names the known cases: an identity outside `NativeIdentitySchema` or a cwd longer
   * than its bound makes the session unrepresentable, so it is left out of the list and the feed,
   * its lookup is not observed, and its report is not found. Nullable fields that cannot cross whole
   * are null, and unclippable paths are left out of a report, in `report.ts`.
   *
   * `checked` is the safety net for anything those miss: each document is parsed with its own
   * schema before it is written. The contract has no field that counts what was left out, so each
   * case is logged once per daemon run, with lengths and schema paths only. A value that failed is
   * by definition one that should not cross, and may hold control characters, so it is never
   * logged.
   */
  const warned = new Set<string>();
  function warnOnce(key: string, message: string, fields: Record<string, unknown>): void {
    if (warned.has(key)) return;
    warned.add(key);
    log.warn(message, fields);
  }

  function providerField(provider: string): Record<string, unknown> {
    return ProviderIdSchema.safeParse(provider).success
      ? { provider }
      : { providerLength: provider.length };
  }

  function entryOf(summary: SessionSummary, at: number): SessionEntry | undefined {
    if (
      !ProviderIdSchema.safeParse(summary.provider).success ||
      !NativeSessionIdSchema.safeParse(summary.providerSessionId).success ||
      summary.id.length > MAX_SESSION_ID
    ) {
      warnOnce(
        `identity:${summary.id}`,
        'consumer contract cannot identify a stored session; it is left out',
        { ...providerField(summary.provider), sessionIdLength: summary.providerSessionId.length },
      );
      return undefined;
    }
    const entry = toSessionEntry(summary, at, text);
    if (entry.cwd.length > MAX_CONSUMER_PATH) {
      warnOnce(
        `cwd:${summary.id}`,
        'consumer contract cannot carry a stored session’s working directory; it is left out',
        { ...providerField(summary.provider), cwdLength: entry.cwd.length },
      );
      return undefined;
    }
    return checked(SessionEntrySchema, entry, summary.id) ? entry : undefined;
  }

  /*
   * A list builds and checks an entry for every stored session so that total is honest, which at
   * thousands of sessions is real time on the daemon's thread. Each session's result, including
   * "cannot be carried", is kept until its summary changes, and each list replaces the cache with
   * the sessions it saw, so a forgotten session does not linger.
   *
   * The key is the whole summary plus the status it reads as now, not just evidenceSeq and status:
   * the explanation status moves from generating to generated, or to disabled, with no new
   * evidence, and an entry keyed without it would keep announcing the old one.
   */
  interface CachedEntry {
    key: string;
    entry: SessionEntry | undefined;
  }
  let listCache = new Map<string, CachedEntry>();
  function listEntryOf(
    summary: SessionSummary,
    at: number,
    seen: Map<string, CachedEntry>,
  ): SessionEntry | undefined {
    const key = `${currentStatus(summary, at)}|${JSON.stringify(summary)}`;
    let cached = listCache.get(summary.id);
    if (cached?.key !== key) cached = { key, entry: entryOf(summary, at) };
    if (seen.size < MAX_CACHED_LIST_ENTRIES) seen.set(summary.id, cached);
    return cached.entry;
  }

  /** The last line: whether `document` passes its own schema, logging where it did not if not. */
  function checked(schema: z.ZodType, document: unknown, key: string): boolean {
    const parsed = schema.safeParse(document);
    if (parsed.success) return true;
    const format = (document as { format?: unknown }).format;
    warnOnce(
      `schema:${String(format)}:${key}`,
      'consumer document failed its own schema; it is not served',
      {
        format,
        issues: parsed.error.issues.slice(0, 10).map((issue) => ({
          path: issue.path.map(String).join('.'),
          code: issue.code,
        })),
      },
    );
    return false;
  }

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
    if (path === `${CONSUMER_BASE_PATH}/discovery`) {
      const body = deps.discovery();
      return checked(ConsumerDiscoverySchema, body, 'discovery')
        ? json(res, 200, body)
        : unservable(res);
    }

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
    // Every session is checked before counting, so total and truncated describe what can be served.
    const seen = new Map<string, CachedEntry>();
    const all = registry.listSessions().flatMap((summary) => listEntryOf(summary, at, seen) ?? []);
    listCache = seen;
    const body: SessionList = {
      format: 'salidium.session-list',
      version: 1,
      generatedAt: new Date(at).toISOString(),
      sessions: all.slice(0, limit),
      total: all.length,
      truncated: all.length > limit,
    };
    // Each entry already passed SessionEntrySchema, so the envelope is checked around them rather
    // than parsing up to the limit's worth of entries a second time.
    return checked(SessionListSchema, { ...body, sessions: [] }, 'list')
      ? json(res, 200, body)
      : unservable(res);
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
    const at = now();
    // A session the contract cannot carry is absent from the list and the feed too, so lookup
    // answers with the one 404 it documents rather than a code a consumer was never told about.
    const session = summary && isUserSession(summary) ? entryOf(summary, at) : undefined;
    if (!session)
      return fail(
        res,
        404,
        'session-not-observed',
        'Salidium has not observed this session. A session launched moments ago may not have reported yet.',
      );
    const body: SessionLookup = {
      format: 'salidium.session-lookup',
      version: 1,
      generatedAt: new Date(at).toISOString(),
      session,
    };
    return checked(SessionLookupSchema, body, session.id) ? json(res, 200, body) : unservable(res);
  }

  function sessionReport(res: ServerResponse, encoded: string): undefined {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(encoded);
    } catch {
      return fail(res, 400, 'bad-request', 'the session id is not valid percent-encoding');
    }
    const read = registry.readSession(sessionId);
    const at = now();
    if (!read || !isUserSession(read.summary) || !entryOf(read.summary, at))
      return fail(res, 404, 'not-found', 'no such session');
    const omitted = new Set<number>();
    const body = toSessionReport(
      read.state,
      projectSession(read.state, at),
      read.summary,
      at,
      text,
      (pathLength) => omitted.add(pathLength),
    );
    if (omitted.size > 0)
      warnOnce(
        `paths:${read.summary.id}`,
        'consumer report left out changed files whose paths it cannot carry whole',
        {
          ...providerField(read.summary.provider),
          pathLengths: [...omitted].sort((a, b) => a - b),
        },
      );
    if (!checked(SessionReportSchema, body, read.summary.id))
      return fail(res, 404, 'not-found', 'no such session');
    json(res, 200, body);
  }

  function feed(res: ServerResponse, credential: ConsumerCredential): undefined {
    startSse(res);
    const stamp = () => new Date(now()).toISOString();
    let open = true;
    const send = (message: FeedMessage) => {
      if (!open) return;
      const key = 'sessionId' in message ? message.sessionId : message.type;
      if (!checked(FeedMessageSchema, message, key)) return;
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
      const entry = isUserSession(summary) ? entryOf(summary, now()) : undefined;
      if (!entry) return;
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
    /**
     * Whether the contract describes this stored session at all: a user session `entryOf` can
     * represent. Sibling views built on the same credential, such as execution links, use it so
     * they never serve a session the contract leaves out.
     */
    represents(summary: SessionSummary): boolean {
      return isUserSession(summary) && entryOf(summary, now()) !== undefined;
    },
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

/** A document that failed its own schema and has no entry to drop answers as a handler failure. */
function unservable(res: ServerResponse): undefined {
  return fail(res, 500, 'internal', 'the request could not be completed');
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
