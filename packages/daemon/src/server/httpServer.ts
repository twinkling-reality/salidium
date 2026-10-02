import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { StoreRawRecord } from '@salidium/adapter-kit';
import {
  createRedactor,
  isCredentialDumpCommand,
  isSensitiveMcpFileRead,
  isSensitivePath,
  isSensitiveUri,
  projectSession,
} from '@salidium/core';
import type { SessionLinksHandler } from '@salidium/project-map';
import type {
  CollectionControlRequest,
  CollectionStatus,
  DaemonInfo,
  EffectiveOperationalConfig,
  EventSource,
  ExplainerSettings,
  ExplainerSettingsRequest,
  LocalAlertState,
  MaintenanceState,
  OllamaModels,
  OperationalConfigPatch,
  OperationsOverview,
  PersonalizationSettings,
  PersonalizationSettingsRequest,
  PersonalizedExplanation,
  QueueInspection,
  StorageComposition,
  StoredEvent,
  StreamMessage,
} from '@salidium/protocol';
import {
  CanonicalTimestampSchema,
  CollectionControlRequestSchema,
  ExplainerSettingsRequestSchema,
  OperationalConfigPatchSchema,
  PersonalizationSettingsRequestSchema,
} from '@salidium/protocol';
import type { createConsumerRoutes } from '../consumer/routes.ts';
import type { HookIngress } from '../ingest/hookIngress.ts';
import { MAX_INGEST_PAYLOAD_BYTES } from '../ingest/limits.ts';
import type { Logger } from '../logging/logger.ts';
import { type createProjectMapRoutes, isProjectMapPath } from '../projectMap/routes.ts';
import { isUserSession, type SessionRegistry } from '../sessions/sessionRegistry.ts';
import { startSse } from './sse.ts';

export interface HttpServerDeps {
  registry: SessionRegistry;
  hooks: HookIngress;
  token: string;
  /** Actual bound port (known only after listen when an ephemeral port is used). */
  port: () => number;
  uiDist?: string;
  info: () => DaemonInfo;
  collection?: {
    status: () => CollectionStatus;
    set: (request: CollectionControlRequest) => CollectionStatus;
    disconnect: (provider: string) => CollectionStatus | undefined;
  };
  operations?: {
    overview: () => OperationsOverview;
    setConfig: (
      patch: OperationalConfigPatch,
      expectedRevision: number | undefined,
    ) => EffectiveOperationalConfig;
    resetConfig: (
      key: string | undefined,
      expectedRevision: number | undefined,
    ) => EffectiveOperationalConfig;
    inspectQueue: (limit: number) => QueueInspection;
    drainQueue: () => {
      state: MaintenanceState;
      before: QueueInspection;
      after: QueueInspection;
    };
    acknowledgeAlert: (id: string) => LocalAlertState;
    storageComposition: () => StorageComposition;
    analyzeStorage: () => StorageComposition;
  };
  /**
   * The choices that survive a restart. Optional because the routes are the only thing that needs
   * them, and a test that stands the server up to exercise one other route should not have to
   * build a settings store to do it — without this, `/api/settings/*` simply is not there.
   */
  settings?: {
    explainer: () => ExplainerSettings;
    setExplainerSettings: (settings: ExplainerSettingsRequest) => ExplainerSettings;
    /** Installed local models, asked of the loopback Ollama only when the settings UI needs them. */
    ollamaModels?: () => Promise<OllamaModels>;
    personalization: () => PersonalizationSettings;
    setPersonalization: (
      settings: PersonalizationSettingsRequest,
      expectedRevision: string | undefined,
    ) => PersonalizationSettings | 'conflict';
    deletePersonalization: (
      expectedRevision: string | undefined,
    ) => PersonalizationSettings | 'conflict';
    personalize: (
      sessionId: string,
    ) => Promise<
      | { status: 'generated'; presentation: PersonalizedExplanation }
      | { status: 'disabled' | 'unavailable' | 'failed' | 'not-found' | 'stale' }
    >;
  };
  /**
   * The read-only consumer contract under `/consumer/v1`. Optional for the same reason as
   * `settings`; without it those paths are simply not found.
   */
  consumer?: ReturnType<typeof createConsumerRoutes>;
  /**
   * Raw records of providers whose durable record is a database. `read` answers undefined when the
   * provider is not enabled, and then nothing is read, even for events already stored.
   */
  storeRecords?: {
    isStoreProvider: (provider: string) => boolean;
    read: (provider: string, ref: NonNullable<EventSource['ref']>) => StoreRawRecord | undefined;
  };
  /**
   * The experimental project map under `/project-map/v0`, read with a consumer credential.
   * Optional for the same reason as `consumer`.
   */
  projectMap?: ReturnType<typeof createProjectMapRoutes>;
  /**
   * Where a session's changed files sit in the codebase, for the interface: the same
   * `salidium.execution-links` document the map routes serve to consumers, under the same opt-in.
   * Optional like `settings`; without it the path is simply not found.
   */
  sessionLinks?: SessionLinksHandler;
  log: Logger;
}

/**
 * The most rows one search will ever return. This is not a paging cursor; it is a ceiling on what
 * a mistaken or hostile caller can ask the daemon to serialise at once.
 */
const MAX_SESSION_LIMIT = 2000;
/** Beyond this replay window the only safe recovery is a fresh reducer snapshot. */
export const MAX_STREAM_REPLAY_EVENTS = 50_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Loopback-only HTTP server: hook ingress, JSON API, server-sent event streams, static UI.
 * Security model (see docs/architecture.md): bind 127.0.0.1; every /api and /hooks request needs
 * the daemon token; Host must be a loopback authority; a present Origin must be our own origin
 * (defeats DNS rebinding and cross-site requests from other local pages); API responses are
 * never cacheable; the UI shell gets a strict CSP and loads nothing remote.
 */
/**
 * A settings body is one short JSON object, so it is bounded on its own terms rather than by
 * the ingest limit: an 8 MB allowance for `{"cadence":"turn"}` is a limit that never says no.
 */
const MAX_SETTINGS_BODY_BYTES = 4 * 1024;

export function createHttpServer(deps: HttpServerDeps): Server {
  const { registry, hooks, token, log } = deps;
  const allowedHosts = () => {
    const port = deps.port();
    return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  };
  const tokenBuf = Buffer.from(token);
  const redactor = createRedactor();

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log.warn('request failed', { url: req.url, err: String(err) });
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const hosts = allowedHosts();
    // The guard is identical for every path; only the body a consumer route refuses with differs,
    // so that everything under /consumer answers in the contract's error envelope.
    const consumer =
      (url.pathname === '/consumer' || url.pathname.startsWith('/consumer/')) && deps.consumer;
    const projectMap = isProjectMapPath(url.pathname) && deps.projectMap;
    if (!hosts.has(req.headers.host ?? ''))
      return consumer
        ? consumer.refuse(res, 421, 'host-not-allowed', 'only a loopback Host is accepted')
        : projectMap
          ? projectMap.refuse(res, 'host-not-allowed', 'only a loopback Host is accepted')
          : json(res, 421, { error: 'unexpected host' });
    const origin = req.headers.origin;
    if (origin && !hosts.has(origin.replace(/^https?:\/\//, '')))
      return consumer
        ? consumer.refuse(res, 403, 'origin-not-allowed', 'cross-origin requests are refused')
        : projectMap
          ? projectMap.refuse(res, 'origin-not-allowed', 'cross-origin requests are refused')
          : json(res, 403, { error: 'origin not allowed' });
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return consumer
        ? consumer.refuse(res, 403, 'origin-not-allowed', 'cross-site requests are refused')
        : projectMap
          ? projectMap.refuse(res, 'origin-not-allowed', 'cross-site requests are refused')
          : json(res, 403, { error: 'cross-site request' });

    /*
     * The consumer contract has its own credential and never accepts the owner token, and the owner
     * routes below never accept a consumer credential. It is dispatched before the owner check so
     * that the two cannot be confused by a shared prefix.
     */
    if (url.pathname === '/consumer' || url.pathname.startsWith('/consumer/')) {
      if (deps.consumer) return deps.consumer.handle(req, res, url);
      res.setHeader('Cache-Control', 'no-store');
      return json(res, 404, { error: 'not found' });
    }
    // The project map is read with a consumer credential and dispatched here for the same reason.
    if (isProjectMapPath(url.pathname)) {
      if (deps.projectMap) return deps.projectMap.handle(req, res, url);
      res.setHeader('Cache-Control', 'no-store');
      return json(res, 404, { error: 'not found' });
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hooks/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/hooks/')) {
      const provider = url.pathname.slice('/hooks/'.length);
      const body = await readBody(req, MAX_INGEST_PAYLOAD_BYTES);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return json(res, 400, { error: 'invalid json' });
      }
      const accepted = hooks.handle(provider, payload);
      res.statusCode = 204;
      res.setHeader('X-Salidium-Accepted', String(accepted));
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/info') return json(res, 200, deps.info());
    if (req.method === 'GET' && url.pathname === '/api/operations' && deps.operations)
      return json(res, 200, deps.operations.overview());
    if (url.pathname === '/api/operations/config' && deps.operations) {
      if (req.method === 'GET') return json(res, 200, deps.operations.overview().config);
      const expected = revisionHeader(req);
      if (expected === 'invalid')
        return json(res, 400, { error: 'If-Match must be a revision number' });
      if (req.method === 'PUT') {
        const body = await readBody(req, MAX_SETTINGS_BODY_BYTES);
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          return json(res, 400, { error: 'invalid json' });
        }
        const parsed = OperationalConfigPatchSchema.safeParse(payload);
        if (!parsed.success) return json(res, 400, { error: 'invalid operational configuration' });
        try {
          return json(res, 200, deps.operations.setConfig(parsed.data, expected));
        } catch (error) {
          if (String(error).includes('configuration changed'))
            return json(res, 409, { error: 'configuration changed' });
          throw error;
        }
      }
      if (req.method === 'DELETE') {
        try {
          return json(
            res,
            200,
            deps.operations.resetConfig(url.searchParams.get('key') ?? undefined, expected),
          );
        } catch (error) {
          if (String(error).includes('configuration changed'))
            return json(res, 409, { error: 'configuration changed' });
          if (String(error).includes('unknown configuration key'))
            return json(res, 400, { error: 'unknown configuration key' });
          throw error;
        }
      }
      return json(res, 405, { error: 'method not allowed' });
    }
    if (req.method === 'GET' && url.pathname === '/api/operations/queue' && deps.operations) {
      const asked = Number(url.searchParams.get('limit') ?? 25);
      if (!Number.isFinite(asked) || asked < 0)
        return json(res, 400, { error: 'limit must be a nonnegative number' });
      return json(res, 200, deps.operations.inspectQueue(Math.min(Math.trunc(asked), 200)));
    }
    if (
      req.method === 'POST' &&
      url.pathname === '/api/operations/maintenance/drain' &&
      deps.operations
    )
      return json(res, 200, deps.operations.drainQueue());
    if (url.pathname === '/api/operations/storage' && deps.operations) {
      if (req.method === 'GET') return json(res, 200, deps.operations.storageComposition());
      /*
       * A POST because it starts work, not because it changes anything: the measurement is
       * read-only and its answer replaces the previous one. It returns immediately with the
       * running state and the caller polls the GET.
       */
      if (req.method === 'POST') return json(res, 200, deps.operations.analyzeStorage());
      return json(res, 405, { error: 'method not allowed' });
    }
    const acknowledge = /^\/api\/operations\/alerts\/([^/]+)\/acknowledge$/.exec(url.pathname);
    if (req.method === 'POST' && acknowledge?.[1] && deps.operations) {
      const alertId = decodeSegment(acknowledge[1]);
      if (alertId === undefined) return badEncoding(res);
      try {
        return json(res, 200, deps.operations.acknowledgeAlert(alertId));
      } catch (error) {
        if (String(error).includes('unknown alert'))
          return json(res, 404, { error: 'unknown alert' });
        throw error;
      }
    }
    if (url.pathname === '/api/collection' && deps.collection) {
      if (req.method === 'GET') return json(res, 200, deps.collection.status());
      if (req.method === 'PUT') {
        const body = await readBody(req, MAX_SETTINGS_BODY_BYTES);
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          return json(res, 400, { error: 'invalid json' });
        }
        const parsed = CollectionControlRequestSchema.safeParse(payload);
        if (!parsed.success) return json(res, 400, { error: 'invalid collection control' });
        return json(res, 200, deps.collection.set(parsed.data));
      }
      return json(res, 405, { error: 'method not allowed' });
    }
    const disconnect = /^\/api\/collection\/hooks\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && disconnect?.[1] && deps.collection) {
      const provider = decodeSegment(disconnect[1]);
      if (provider === undefined) return badEncoding(res);
      const status = deps.collection.disconnect(provider);
      return status ? json(res, 200, status) : json(res, 404, { error: 'unknown provider' });
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions')
      return json(res, 200, registry.listSessions());
    /*
     * Matching a query is the daemon's job, not the browser's: the list is capped, so filtering
     * only what was served can miss matches that exist outside the current page.
     *
     * A sibling route rather than a `q=` on /api/sessions, which stays an array: the list route has
     * three consumers (the UI's initial load, the `salidium view` picker, the daemon's own test)
     * and changing its shape breaks all of them, one of them silently. It must be tested before the
     * `/api/sessions/:id` pattern below, which would otherwise read `search` as a session id.
     *
     * `limit=0` is a real request — the panel asking what the store holds while it shows rows it
     * already has — so the floor is 0, not 1. NaN is guarded explicitly rather than clamped with
     * Math.min, which passes it straight through to the SQL LIMIT.
     */
    if (req.method === 'GET' && url.pathname === '/api/sessions/search') {
      const asked = url.searchParams.get('limit');
      const n = asked === null ? Number.NaN : Number(asked);
      const limit = Number.isFinite(n)
        ? Math.min(Math.max(Math.trunc(n), 0), MAX_SESSION_LIMIT)
        : undefined;
      return json(
        res,
        200,
        registry.searchSessions({ query: url.searchParams.get('q') ?? '', limit }),
      );
    }
    /*
     * The explainer's stop. A GET so the surface can open already showing what is in force, and a
     * PUT because setting it twice is setting it once — this is a value being replaced, not an
     * action being taken, and a retried request must not compound.
     *
     * The body is parsed by the same schema the client sends, so a cadence the daemon does not
     * know is a 400 rather than a silently ignored write: the panel would otherwise report back
     * the stop it asked for while the daemon kept the old one.
     */
    if (url.pathname === '/api/settings/explainer' && deps.settings) {
      if (req.method === 'GET') return json(res, 200, deps.settings.explainer());
      if (req.method === 'PUT') {
        const body = await readBody(req, MAX_SETTINGS_BODY_BYTES);
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          return json(res, 400, { error: 'invalid json' });
        }
        const parsed = ExplainerSettingsRequestSchema.safeParse(payload);
        if (!parsed.success) return json(res, 400, { error: 'invalid explainer setting' });
        return json(res, 200, deps.settings.setExplainerSettings(parsed.data));
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if (url.pathname === '/api/settings/explainer/ollama-models' && deps.settings?.ollamaModels) {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      return json(res, 200, await deps.settings.ollamaModels());
    }

    if (url.pathname === '/api/settings/personalization' && deps.settings) {
      if (req.method === 'GET') return json(res, 200, deps.settings.personalization());
      if (req.method === 'PUT') {
        const body = await readBody(req, MAX_SETTINGS_BODY_BYTES);
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          return json(res, 400, { error: 'invalid json' });
        }
        const parsed = PersonalizationSettingsRequestSchema.safeParse(payload);
        if (!parsed.success) return json(res, 400, { error: 'invalid personalization profile' });
        const expected = req.headers['if-match'];
        const result = deps.settings.setPersonalization(
          parsed.data,
          typeof expected === 'string' ? expected : undefined,
        );
        return result === 'conflict'
          ? json(res, 409, { error: 'personalization revision changed' })
          : json(res, 200, result);
      }
      if (req.method === 'DELETE') {
        const expected = req.headers['if-match'];
        const result = deps.settings.deletePersonalization(
          typeof expected === 'string' ? expected : undefined,
        );
        return result === 'conflict'
          ? json(res, 409, { error: 'personalization revision changed' })
          : json(res, 200, result);
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') return streamSummaries(res);

    const m = /^\/api\/sessions\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (m?.[1]) {
      const sessionId = decodeSegment(m[1]);
      if (sessionId === undefined) return badEncoding(res);
      const rest = m[2] ?? '';
      if (req.method === 'DELETE' && rest === '') {
        registry.forget(sessionId);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && rest === 'personalized-presentation' && deps.settings) {
        const result = await deps.settings.personalize(sessionId);
        if (result.status === 'generated') return json(res, 200, result.presentation);
        if (result.status === 'not-found') return json(res, 404, { error: 'unknown session' });
        if (result.status === 'stale')
          return json(res, 409, { error: 'personalization changed while generating' });
        if (result.status === 'disabled')
          return json(res, 409, { error: 'written Why and How is local only' });
        if (result.status === 'unavailable')
          return json(res, 409, {
            error: 'a generated explanation and enabled profile are required',
          });
        return json(res, 502, { error: 'personalized presentation failed' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      switch (true) {
        case rest === 'snapshot': {
          const snap = registry.snapshot(sessionId, Number(url.searchParams.get('changes') ?? 300));
          return snap ? json(res, 200, snap) : json(res, 404, { error: 'unknown session' });
        }
        case rest === 'view': {
          const at = url.searchParams.get('at');
          const state = at
            ? registry.stateAt(sessionId, Number(at))?.state
            : registry.snapshot(sessionId, 0)?.state;
          if (!state) return json(res, 404, { error: 'unknown session' });
          return json(res, 200, projectSession(state as never));
        }
        case rest === 'state': {
          const atTime = url.searchParams.get('atTime');
          if (atTime) {
            if (!CanonicalTimestampSchema.safeParse(atTime).success)
              return json(res, 400, { error: 'atTime must be a UTC timestamp with milliseconds' });
            const r = registry.stateAtTime(sessionId, atTime);
            return r
              ? json(res, 200, { state: r.state, seq: r.state.latestSeq, atTime })
              : json(res, 404, { error: 'unknown session' });
          }
          const at = Number(url.searchParams.get('at') ?? Number.MAX_SAFE_INTEGER);
          const r = registry.stateAt(sessionId, at);
          return r
            ? json(res, 200, { state: r.state, seq: r.state.latestSeq })
            : json(res, 404, { error: 'unknown session' });
        }
        case rest === 'events': {
          const after = Number(url.searchParams.get('after') ?? -1);
          const until = url.searchParams.get('until');
          const limit = Math.min(Number(url.searchParams.get('limit') ?? 5000), 20000);
          return json(
            res,
            200,
            registry.eventsAfter(sessionId, after, until ? Number(until) : undefined, limit),
          );
        }
        case rest === 'changes': {
          const after = Number(url.searchParams.get('after') ?? -1);
          const until = Number(url.searchParams.get('until') ?? Number.MAX_SAFE_INTEGER);
          return json(res, 200, registry.changesRange(sessionId, after, until));
        }
        case rest === 'stream': {
          const after = Number(url.searchParams.get('after') ?? -1);
          if (!Number.isInteger(after) || after < -1)
            return json(res, 400, { error: 'after must be an integer at least -1' });
          return streamSession(res, sessionId, after);
        }
        case rest === 'links' && deps.sessionLinks !== undefined: {
          const result = await deps.sessionLinks({ sessionId, query: url.searchParams });
          if ('body' in result) return json(res, 200, result.body);
          // Not found reads as it does on every other session route.
          return json(res, result.status, {
            error: result.status === 404 ? 'unknown session' : result.message,
          });
        }
        case rest.startsWith('raw/'): {
          const eventId = decodeSegment(rest.slice(4));
          if (eventId === undefined) return badEncoding(res);
          return rawRecord(res, sessionId, eventId);
        }
        default:
          return json(res, 404, { error: 'not found' });
      }
    }

    if (req.method === 'GET' && deps.uiDist) return serveStatic(res, deps.uiDist, url.pathname);
    return json(res, 404, { error: 'not found' });
  }
  server.on('close', () => deps.consumer?.close());

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice(7));
    return provided.length === tokenBuf.length && timingSafeEqual(provided, tokenBuf);
  }

  function streamSummaries(res: ServerResponse): void {
    startSse(res);
    const send = (m: StreamMessage) => res.write(`data: ${JSON.stringify(m)}\n\n`);
    for (const s of registry.listSessions()) send({ type: 'session', summary: s });
    const unsub = registry.subscribeSummaries((summary) => {
      if (isUserSession(summary)) send({ type: 'session', summary });
    });
    const unsubRemoved = registry.subscribeRemovals((id) => send({ type: 'sessionRemoved', id }));
    const hb = setInterval(() => send({ type: 'heartbeat', at: new Date().toISOString() }), 15000);
    res.on('close', () => {
      unsub();
      unsubRemoved();
      clearInterval(hb);
    });
  }

  function streamSession(res: ServerResponse, sessionId: string, after: number): void {
    // Establish that this is a real session before installing a subscriber. Older behavior opened
    // a healthy-looking stream for an id that could never produce an event.
    const initial = registry.snapshot(sessionId, 0);
    if (!initial) {
      json(res, 404, { error: 'unknown session' });
      return;
    }
    const send = (m: StreamMessage) => res.write(`data: ${JSON.stringify(m)}\n\n`);
    // Subscribe first, then replay the gap, so nothing is lost between the two.
    let replaying = true;
    const buffered: StreamMessage[] = [];
    const unsub = registry.subscribe(sessionId, (events, changes) => {
      const msgs: StreamMessage[] = [
        ...events.map((e) => ({ type: 'event' as const, event: e })),
        ...(changes.length ? [{ type: 'changes' as const, changes }] : []),
      ];
      if (replaying) buffered.push(...msgs);
      else for (const m of msgs) send(m);
    });
    const gap = registry.eventsAfter(sessionId, after, undefined, MAX_STREAM_REPLAY_EVENTS + 1);
    let latestSeq = Math.max(initial.seq, registry.snapshot(sessionId, 0)?.seq ?? -1);
    for (const message of buffered)
      if (message.type === 'event') latestSeq = Math.max(latestSeq, message.event.seq);
    const firstSeq = gap[0]?.seq;
    const hasGap = gap.some((event, index) => event.seq !== after + index + 1);
    const reason =
      after > latestSeq
        ? 'cursor-ahead'
        : gap.length > MAX_STREAM_REPLAY_EVENTS
          ? 'backlog-exceeded'
          : latestSeq > after && (firstSeq !== after + 1 || hasGap)
            ? 'history-gap'
            : undefined;
    if (reason) {
      unsub();
      json(res, 409, {
        error: 'resnapshot-required',
        reason,
        sessionId,
        after,
        latestSeq,
      });
      return;
    }

    startSse(res);
    let lastSeq = after;
    for (const e of gap) {
      send({ type: 'event', event: e });
      lastSeq = e.seq;
    }
    if (gap.length)
      send({ type: 'changes', changes: registry.changesRange(sessionId, after, lastSeq) });
    replaying = false;
    for (const m of buffered) {
      if (m.type === 'event' && m.event.seq <= lastSeq) continue;
      send(m);
    }
    const hb = setInterval(() => send({ type: 'heartbeat', at: new Date().toISOString() }), 15000);
    res.on('close', () => {
      unsub();
      clearInterval(hb);
    });
  }

  async function rawRecord(res: ServerResponse, sessionId: string, eventId: string): Promise<void> {
    const event = registry.eventById(sessionId, eventId);
    if (!event) return json(res, 404, { error: 'unknown event' });
    if (isSuppressedRecord(event))
      return json(res, 200, {
        event,
        raw: null,
        reason: 'suppressed: sensitive file contents or credential dump',
      });
    const ref = event.source.ref;
    if (deps.storeRecords?.isStoreProvider(event.source.provider)) {
      if (!ref?.path || !ref.recordId)
        return json(res, 200, { event, raw: null, reason: 'no provider record (derived event)' });
      const read = deps.storeRecords.read(event.source.provider, ref);
      if (!read)
        return json(res, 200, {
          event,
          raw: null,
          reason: 'this provider is not enabled in Salidium, so its store is not read',
        });
      if (read.raw === undefined) return json(res, 200, { event, raw: null, reason: read.reason });
      // The source names the paths and commands in what it returned; suppress as for events.
      if (
        read.paths.some(isSensitivePath) ||
        read.uris?.some(isSensitiveUri) ||
        read.commands.some(isCredentialDumpCommand)
      )
        return json(res, 200, {
          event,
          raw: null,
          reason: 'suppressed: sensitive file contents or credential dump',
        });
      let record: unknown;
      try {
        record = JSON.parse(redactor.redact(read.raw).text);
      } catch {
        record = redactor.redact(read.raw).text;
      }
      return json(res, 200, { event, raw: record, path: ref.path, recordId: ref.recordId });
    }
    if (!ref?.path || ref.line === undefined)
      return json(res, 200, {
        event,
        raw: null,
        reason: 'no provider record (hook or derived event)',
      });
    if (!existsSync(ref.path))
      return json(res, 200, { event, raw: null, reason: 'provider file no longer on disk' });
    const read = await readLine(ref.path, ref.line, MAX_INGEST_PAYLOAD_BYTES);
    if (read.oversized)
      return json(res, 200, {
        event,
        raw: null,
        reason: `provider record exceeds ${MAX_INGEST_PAYLOAD_BYTES} bytes; raw suppressed`,
      });
    const line = read.line;
    if (line === undefined)
      return json(res, 200, { event, raw: null, reason: 'record not found at recorded line' });
    const sidecar = ref.recordHash
      ? undefined
      : registry.rawFingerprint(sessionId, eventId, ref.path, ref.line);
    const expectedHash = ref.recordHash ?? sidecar?.recordHash;
    if (expectedHash && recordHash(line.trim()) !== expectedHash)
      return json(res, 200, {
        event,
        raw: null,
        reason: 'provider record changed since ingestion',
      });
    // Codex rollout rows historically had no stable provider record id. Without an ingestion-time
    // hash, reading the current line would present mutable file contents as historical evidence.
    if (!expectedHash && event.source.provider === 'codex')
      return json(res, 200, {
        event,
        raw: null,
        reason: 'raw fingerprint unavailable; re-ingest this session to verify the provider line',
      });
    if (!expectedHash && ref.recordId && providerRecordId(line) !== ref.recordId)
      return json(res, 200, {
        event,
        raw: null,
        reason: 'provider record changed since ingestion',
      });
    if (!expectedHash && !ref.recordId)
      return json(res, 200, {
        event,
        raw: null,
        reason: 'raw record identity unavailable; re-ingest this session',
      });
    let record: unknown;
    try {
      record = JSON.parse(redactor.redact(line).text);
    } catch {
      record = redactor.redact(line).text;
    }
    return json(res, 200, {
      event,
      raw: record,
      path: ref.path,
      line: ref.line,
      ...(sidecar
        ? { fingerprint: { capturedAt: sidecar.capturedAt, origin: sidecar.origin } }
        : {}),
    });
  }

  function recordHash(line: string): string {
    return `sha256:${createHash('sha256').update(line).digest('hex')}`;
  }

  function providerRecordId(line: string): string | undefined {
    try {
      const parsed = JSON.parse(line) as { uuid?: unknown; id?: unknown };
      return typeof parsed.uuid === 'string'
        ? parsed.uuid
        : typeof parsed.id === 'string'
          ? parsed.id
          : undefined;
    } catch {
      return undefined;
    }
  }

  function serveStatic(res: ServerResponse, dist: string, pathname: string): void {
    const decoded = decodeSegment(pathname);
    if (decoded === undefined) {
      badEncoding(res);
      return;
    }
    const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
    let file = join(dist, rel === '/' || rel === '' ? 'index.html' : rel);
    if (!file.startsWith(dist)) {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    if (!existsSync(file)) {
      json(res, 404, { error: 'ui not built' });
      return;
    }
    const ext = extname(file);
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    if (ext === '.html') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
      res.setHeader('X-Frame-Options', 'DENY');
      res.end(readFileSync(file));
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    createReadStream(file).pipe(res);
  }

  return server;
}

/**
 * The ingest layer structurally suppresses reads of credential files and env dumps; the raw
 * drill-through must not reopen them from disk. Regex redaction alone cannot cover a whole .env.
 */
function isSuppressedRecord(event: StoredEvent): boolean {
  if (event.kind === 'tool.called') {
    const i = event.input;
    if (
      (i.kind === 'fileRead' || i.kind === 'fileWrite' || i.kind === 'fileEdit') &&
      isSensitivePath(i.path)
    )
      return true;
    if (i.kind === 'command' && isCredentialDumpCommand(i.command)) return true;
    if (i.kind === 'mcp' && isSensitiveMcpFileRead(i)) return true;
    if (i.kind === 'search' && i.path !== undefined && isSensitivePath(i.path)) return true;
    return false;
  }
  if (event.kind === 'tool.failed') return event.errorExcerpt.startsWith('[contents suppressed');
  if (event.kind === 'tool.completed') {
    const r = event.result;
    if (r.kind === 'fileRead' && (r.suppressed || isSensitivePath(r.path))) return true;
    if (r.kind === 'command' && r.outputExcerpt.startsWith('[contents suppressed')) return true;
    if (r.kind === 'generic' && r.excerpt?.startsWith('[contents suppressed')) return true;
    if (
      r.kind === 'fileChanges' &&
      r.changes.some(
        (c) =>
          isSensitivePath(c.path) || (c.movedFrom !== undefined && isSensitivePath(c.movedFrom)),
      )
    )
      return true;
  }
  return false;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/**
 * `decodeURIComponent` throws on a malformed escape such as `%E0%A4%A`. That is the client's
 * mistake, so it answers 400 through `badEncoding` rather than reaching the 500 handler.
 */
function decodeSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function badEncoding(res: ServerResponse): void {
  json(res, 400, { error: 'invalid percent-encoding in path' });
}

function revisionHeader(req: IncomingMessage): number | undefined | 'invalid' {
  const raw = req.headers['if-match'];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw) || !/^\d+$/.test(raw)) return 'invalid';
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : 'invalid';
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Reads the Nth `\n`-delimited line (same splitting as the tailer, so line numbers agree) without
 * buffering preceding records and with the same hostile-record ceiling as ingest.
 */
function readLine(
  path: string,
  lineNo: number,
  limit: number,
): Promise<{ line?: string; oversized?: true }> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    let current = 0;
    let size = 0;
    const parts: Buffer[] = [];
    let settled = false;
    const finish = (result: { line?: string; oversized?: true }) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(result);
    };
    stream.on('data', (chunk: Buffer | string) => {
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      let start = 0;
      while (start < data.length) {
        const nl = data.indexOf(0x0a, start);
        const end = nl === -1 ? data.length : nl;
        if (current === lineNo && end > start) {
          const piece = data.subarray(start, end);
          size += piece.length;
          if (size > limit) {
            finish({ oversized: true });
            return;
          }
          parts.push(Buffer.from(piece));
        }
        if (nl === -1) return;
        if (current === lineNo) {
          finish({ line: Buffer.concat(parts, size).toString('utf8') });
          return;
        }
        current++;
        start = nl + 1;
      }
    });
    stream.on('end', () => {
      if (settled) return;
      resolve(
        current === lineNo && size ? { line: Buffer.concat(parts, size).toString('utf8') } : {},
      );
    });
    stream.on('error', (err) => {
      if (!settled) reject(err);
    });
  });
}
