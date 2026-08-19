import type {
  DaemonInfo,
  ExplainerCadence,
  ExplainerSettings,
  SemanticChange,
  SessionList,
  SessionSnapshot,
  SessionSummary,
  StoredEvent,
  StreamMessage,
} from '@salidium/protocol';
import { StreamMessageSchema, StreamResnapshotRequiredSchema } from '@salidium/protocol';

/**
 * Thin client for the daemon's loopback API. The token arrives in the URL fragment when the CLI
 * opens the UI and is kept in sessionStorage; every request sends it as a bearer header (so it
 * never appears in server logs or referrers) and streams are consumed with fetch, not
 * EventSource, so the same header applies.
 */
export class ApiClient {
  private readonly token: string;
  private readonly onUnauthorized: (() => void) | undefined;

  /** `onUnauthorized` fires once the daemon rejects the token (401) on any request or stream. */
  constructor(token: string, opts: { onUnauthorized?: () => void } = {}) {
    this.token = token;
    this.onUnauthorized = opts.onUnauthorized;
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(path, { headers: this.headers(), signal });
    } catch (err) {
      // A request the caller cancelled is not an unreachable daemon. Let the abort through as
      // itself, so superseding a search cannot raise "daemon unreachable" over a healthy one.
      if (signal?.aborted) throw err;
      throw new ApiError(
        `daemon unreachable${err instanceof Error && err.message ? ` (${err.message})` : ''}`,
        0,
      );
    }
    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new ApiError('unauthorized', 401);
    }
    if (!res.ok) throw new ApiError(`request failed: ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  info(): Promise<DaemonInfo> {
    return this.get('/api/info');
  }

  /**
   * When the explainer runs, and what Salidium has observed it consume.
   *
   * The write answers with the same shape the read does, rather than 204, so the surface never has
   * to guess what it now holds: the daemon's environment can be holding the explainer off, and the
   * usage beside the control moves independently of the choice being made.
   */
  explainerSettings(): Promise<ExplainerSettings> {
    return this.get('/api/settings/explainer');
  }

  async setExplainerCadence(cadence: ExplainerCadence): Promise<ExplainerSettings> {
    const res = await fetch('/api/settings/explainer', {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ cadence }),
    });
    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new ApiError('unauthorized', 401);
    }
    if (!res.ok) throw new ApiError(`request failed: ${res.status}`, res.status);
    return (await res.json()) as ExplainerSettings;
  }

  sessions(): Promise<SessionSummary[]> {
    return this.get('/api/sessions');
  }

  /**
   * Sessions matching every word of `query`, searched over the whole store rather than over the
   * rows this client happens to hold, with the size of the matched set and of the store beside
   * them. `limit` 0 asks for those two numbers alone — which is what the default view needs, since
   * it is already showing the rows. Omitting it takes the daemon's page size.
   *
   * `signal` is how a superseded search is cancelled. It is not the only guard: the response
   * echoes the query it answers, so one that arrives late is discarded rather than painted over
   * newer typing.
   */
  searchSessions(
    query: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<SessionList> {
    const q = query.trim();
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    return this.get(`/api/sessions/search?${params}`, opts.signal);
  }

  snapshot(sessionId: string): Promise<SessionSnapshot> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot?changes=400`);
  }

  stateAt(sessionId: string, seq: number): Promise<{ state: unknown; seq: number }> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/state?at=${seq}`);
  }

  stateAtTime(sessionId: string, ts: string): Promise<{ state: unknown; seq: number }> {
    return this.get(
      `/api/sessions/${encodeURIComponent(sessionId)}/state?atTime=${encodeURIComponent(ts)}`,
    );
  }

  changes(sessionId: string, afterSeq = -1, untilSeq?: number): Promise<SemanticChange[]> {
    const until = untilSeq === undefined ? '' : `&until=${untilSeq}`;
    return this.get(
      `/api/sessions/${encodeURIComponent(sessionId)}/changes?after=${afterSeq}${until}`,
    );
  }

  events(
    sessionId: string,
    afterSeq: number,
    untilSeq?: number,
    limit = 5000,
  ): Promise<StoredEvent[]> {
    const until = untilSeq === undefined ? '' : `&until=${untilSeq}`;
    return this.get(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?after=${afterSeq}${until}&limit=${limit}`,
    );
  }

  raw(
    sessionId: string,
    eventId: string,
  ): Promise<{ event: StoredEvent; raw: unknown; path?: string; line?: number; reason?: string }> {
    return this.get(
      `/api/sessions/${encodeURIComponent(sessionId)}/raw/${encodeURIComponent(eventId)}`,
    );
  }

  async forget(sessionId: string): Promise<void> {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
  }

  /**
   * Opens a server-sent event stream and dispatches parsed messages. Returns an abort function.
   * Reconnects with backoff until aborted; `onStatus` reports connection state.
   */
  stream(
    path: string | (() => string),
    onMessage: (m: StreamMessage) => void,
    onStatus: (s: 'connecting' | 'open' | 'reconnecting' | 'closed') => void,
    onResnapshotRequired?: () => void,
  ): () => void {
    let aborted = false;
    let abortCurrent: (() => void) | undefined;
    let attempt = 0;
    const connect = async () => {
      while (!aborted) {
        onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
        try {
          const url = typeof path === 'function' ? path() : path;
          let buffer = '';
          const consume = (chunk: string) => {
            buffer += chunk;
            let idx = buffer.indexOf('\n\n');
            while (idx !== -1) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                try {
                  const message = StreamMessageSchema.safeParse(JSON.parse(line.slice(6)));
                  if (message.success) onMessage(message.data);
                } catch {
                  /* ignore malformed frame */
                }
              }
              idx = buffer.indexOf('\n\n');
            }
          };

          if (needsProgressiveXhr()) {
            const result = await xhrStream(
              url,
              this.token,
              consume,
              () => {
                onStatus('open');
                attempt = 0;
              },
              (abort) => {
                abortCurrent = abort;
              },
            );
            if (result.status === 409) {
              const parsed = StreamResnapshotRequiredSchema.safeParse(parseJson(result.body));
              if (parsed.success) {
                onStatus('closed');
                onResnapshotRequired?.();
                return;
              }
            }
            if (result.status === 401) throw new ApiError('unauthorized', 401);
            if (result.status !== 0 && (result.status < 200 || result.status >= 300))
              throw new ApiError(`stream failed: ${result.status}`, result.status);
          } else {
            const controller = new AbortController();
            abortCurrent = () => controller.abort();
            const res = await fetch(url, {
              headers: this.headers(),
              signal: controller.signal,
            });
            if (res.status === 409) {
              const parsed = StreamResnapshotRequiredSchema.safeParse(await res.json());
              if (parsed.success) {
                onStatus('closed');
                onResnapshotRequired?.();
                return;
              }
            }
            if (!res.ok || !res.body)
              throw new ApiError(`stream failed: ${res.status}`, res.status);
            onStatus('open');
            attempt = 0;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              consume(decoder.decode(value, { stream: true }));
            }
          }
        } catch (err) {
          if (aborted) break;
          if (err instanceof ApiError && err.status === 401) {
            onStatus('closed');
            this.onUnauthorized?.();
            return;
          }
        }
        if (aborted) break;
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(15000, 500 * 2 ** Math.min(attempt, 5))));
      }
      onStatus('closed');
    };
    void connect();
    return () => {
      aborted = true;
      abortCurrent?.();
    };
  }
}

/**
 * WebKit exposes fetch response bodies as ReadableStreams but can hold a live HTTP response until
 * it ends. XHR progress events are incremental in the same engines and still allow the bearer
 * header EventSource cannot send, so WebKit uses that transport with the identical frame parser.
 */
function needsProgressiveXhr(): boolean {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return (
    /AppleWebKit/i.test(agent) &&
    !/(?:Chrome|Chromium|Edg|OPR)\//i.test(agent) &&
    typeof XMLHttpRequest !== 'undefined'
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function xhrStream(
  path: string,
  token: string,
  onChunk: (chunk: string) => void,
  onOpen: () => void,
  registerAbort: (abort: () => void) => void,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let seen = 0;
    let opened = false;
    const openedOnce = () => {
      if (opened || xhr.status !== 200) return;
      opened = true;
      onOpen();
    };
    const consume = () => {
      openedOnce();
      if (xhr.status !== 200 || xhr.responseText.length <= seen) return;
      onChunk(xhr.responseText.slice(seen));
      seen = xhr.responseText.length;
    };

    xhr.open('GET', path);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= XMLHttpRequest.HEADERS_RECEIVED) openedOnce();
      if (xhr.readyState === XMLHttpRequest.LOADING) consume();
    };
    xhr.onprogress = consume;
    xhr.onload = () => {
      consume();
      resolve({ status: xhr.status, body: xhr.responseText });
    };
    xhr.onerror = () => reject(new Error('stream failed'));
    xhr.onabort = () => resolve({ status: 0, body: '' });
    registerAbort(() => xhr.abort());
    xhr.send();
  });
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const TOKEN_KEY = 'salidium.token';

/** Reads the token from the URL fragment (once) or sessionStorage; strips it from the URL. */
export function resolveToken(): string | undefined {
  const hash = window.location.hash;
  const m = /token=([0-9a-f]+)/.exec(hash);
  if (m?.[1]) {
    sessionStorage.setItem(TOKEN_KEY, m[1]);
    const cleaned = hash.replace(/[#&]?token=[0-9a-f]+/, '').replace(/^#&/, '#');
    history.replaceState(null, '', `${window.location.pathname}${cleaned === '#' ? '' : cleaned}`);
    return m[1];
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
}

/**
 * Keeps a token the reader pasted, so it survives a reload exactly as one delivered in the URL
 * does. `resolveToken` already writes the hash's token here; this is the same store, reached from
 * the other door.
 */
export function rememberToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

/**
 * The token out of anything a reader is plausibly holding: the bare value, or the whole URL the
 * CLI printed, which is what you get from selecting a line of terminal output. `undefined` when it
 * is neither, so the gate can say so rather than storing a string that will only fail later.
 */
export function readToken(input: string): string | undefined {
  const text = input.trim();
  const inUrl = /token=([0-9a-f]+)/.exec(text);
  if (inUrl?.[1]) return inUrl[1];
  return /^[0-9a-f]{16,}$/.test(text) ? text : undefined;
}

/** Forgets a token the daemon rejected, so the gate asks for a fresh `salidium open`. */
export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}
