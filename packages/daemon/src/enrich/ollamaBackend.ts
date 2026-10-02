import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { ExplainerBackend, ExplainerBackendRequest } from './explainerBackends.ts';
import { acquireExplainerSlot, MAX_EXPLAINER_OUTPUT_BYTES } from './explainerCapacity.ts';

/**
 * A local Ollama model as an explanation writer, over loopback HTTP and nothing else.
 *
 * This route exists so that local-model work can be explained without anything leaving the
 * machine. That promise is only as good as the address, so the address is checked rather than
 * trusted: Salidium connects to the literal 127.0.0.1 or ::1, never to a name the resolver could
 * redirect, refuses any redirect the server answers with, and bounds what it reads with the same
 * ceiling the CLI routes use. There is no default model and nothing is ever pulled: a model is
 * named by the person from the ones already installed.
 */

export const DEFAULT_OLLAMA_PORT = 11434;
export const DEFAULT_OLLAMA_ENDPOINT = `http://127.0.0.1:${DEFAULT_OLLAMA_PORT}`;
/** A model list is metadata, not generated text, but it is still bounded. */
export const MAX_OLLAMA_TAGS_BYTES = 256 * 1024;
const TAGS_TIMEOUT_MS = 2_000;

export type OllamaEndpoint =
  | { ok: true; host: '127.0.0.1' | '::1'; port: number; label: string }
  | { ok: false; reason: string };

/**
 * Where the Ollama route will connect, from `OLLAMA_HOST` or the default. Only a loopback address
 * is accepted. `localhost` is taken to mean 127.0.0.1 and the connection is made to that literal
 * address, so the system resolver is never asked and cannot answer with a remote one.
 */
export function resolveOllamaEndpoint(
  environment: NodeJS.ProcessEnv = process.env,
): OllamaEndpoint {
  const raw = environment.OLLAMA_HOST?.trim();
  if (!raw)
    return {
      ok: true,
      host: '127.0.0.1',
      port: DEFAULT_OLLAMA_PORT,
      label: DEFAULT_OLLAMA_ENDPOINT,
    };
  const refused = (reason: string): OllamaEndpoint => ({ ok: false, reason });
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    return refused('OLLAMA_HOST is not a valid address');
  }
  if (url.protocol !== 'http:') return refused('OLLAMA_HOST must use http on a loopback address');
  if (url.username || url.password) return refused('OLLAMA_HOST cannot carry credentials');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    return refused('OLLAMA_HOST cannot carry a path or query');
  let host: '127.0.0.1' | '::1';
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') host = '127.0.0.1';
  else if (url.hostname === '[::1]') host = '::1';
  else return refused('OLLAMA_HOST is not a loopback address (127.0.0.1, ::1, or localhost)');
  // Ollama's own reading: a bare host means its usual port, an explicit scheme means the scheme's.
  const port = url.port ? Number(url.port) : hasScheme ? 80 : DEFAULT_OLLAMA_PORT;
  const label = `http://${host === '::1' ? '[::1]' : host}:${port}`;
  return { ok: true, host, port, label };
}

interface LoopbackResponse {
  status: number;
  body: string;
}

/**
 * One request to the loopback endpoint. Node's http client never follows a redirect; a 3xx is
 * turned into a failure here so that no caller can be talked into a second request elsewhere.
 */
function loopbackRequest(
  endpoint: Extract<OllamaEndpoint, { ok: true }>,
  method: 'GET' | 'POST',
  path: string,
  body: string | undefined,
  limits: { timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<LoopbackResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error: Error | undefined, value?: LoopbackResponse) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      limits.signal?.removeEventListener('abort', abort);
      if (error) {
        req.destroy();
        reject(error);
      } else resolve(value as LoopbackResponse);
    };
    const abort = () => finish(new Error('explainer canceled'));
    const req = httpRequest({
      host: endpoint.host,
      family: endpoint.host === '::1' ? 6 : 4,
      port: endpoint.port,
      method,
      path,
      // No pooled socket can outlive the call or be reused by an unrelated request.
      agent: false,
      headers: {
        Accept: 'application/json',
        ...(body === undefined
          ? {}
          : {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            }),
      },
    });
    req.on('error', (error) => finish(error));
    req.on('response', (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        finish(new Error(`ollama answered with a redirect (${status}); redirects are refused`));
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > limits.maxBytes) {
        res.destroy();
        finish(new Error(`ollama response exceeded ${limits.maxBytes} bytes`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limits.maxBytes) {
          res.destroy();
          finish(new Error(`ollama response exceeded ${limits.maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (error) => finish(error));
      res.on('end', () =>
        finish(undefined, { status, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    limits.signal?.addEventListener('abort', abort, { once: true });
    if (limits.signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(
      () => finish(new Error(`explainer timed out after ${limits.timeoutMs}ms`)),
      limits.timeoutMs,
    );
    req.end(body);
  });
}

function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error.slice(0, 300);
  } catch {
    /* Fall through to the raw excerpt. */
  }
  return body.slice(0, 300);
}

/**
 * Ollama's answer when a model cannot constrain its output to a JSON Schema. MLX builds answer
 * this for every schema; the route then states the schema in the request instead.
 */
export function isStructuredOutputUnavailable(response: LoopbackResponse): boolean {
  return response.status === 501 && /structured output/i.test(errorText(response.body));
}

/** Models whose structured output Ollama has refused, keyed by endpoint and model. */
const structuredOutputUnavailable = new Set<string>();

/** Test seam: forget what earlier requests learned about structured output. */
export function resetOllamaStructuredOutputMemory(): void {
  structuredOutputUnavailable.clear();
}

const SCHEMA_IN_PROMPT =
  'Reply with exactly one JSON object and nothing else: no prose, no code fence. The object must ' +
  'conform to this JSON Schema:';

export function buildOllamaChatBody(
  request: ExplainerBackendRequest,
  model: string,
  structured: boolean,
): string {
  const messages = structured
    ? [{ role: 'user', content: `${request.prompt} ${request.evidence}` }]
    : [
        { role: 'system', content: `${SCHEMA_IN_PROMPT} ${JSON.stringify(request.schema)}` },
        { role: 'user', content: `${request.prompt} ${request.evidence}` },
      ];
  return JSON.stringify({
    model,
    messages,
    stream: false,
    think: false,
    options: { temperature: 0 },
    ...(structured ? { format: request.schema } : {}),
  });
}

/** A local model sometimes fences its JSON even when told not to; the fence is not content. */
function unfence(text: string): string {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(text.trim());
  return match?.[1] ?? text;
}

function chatOutput(response: LoopbackResponse): string {
  if (response.status !== 200)
    throw new Error(`ollama answered ${response.status}: ${errorText(response.body)}`);
  let envelope: { message?: { content?: unknown }; done_reason?: unknown };
  try {
    envelope = JSON.parse(response.body);
  } catch {
    throw new Error('ollama answered with something other than JSON');
  }
  if (envelope.done_reason === 'length') throw new Error('ollama stopped at its length limit');
  const content = envelope.message?.content;
  if (typeof content !== 'string') throw new Error('ollama answered without message content');
  return unfence(content);
}

/** How a generated explanation names its writer: the model, and that it ran in local Ollama. */
export function ollamaGeneratorLabel(model: string): string {
  const label = `${model} · Ollama`;
  return label.length <= 120 ? label : model;
}

export function createOllamaExplainerBackend(
  environment: NodeJS.ProcessEnv = process.env,
): ExplainerBackend {
  return {
    id: 'ollama',
    isAvailable: (env = environment) => resolveOllamaEndpoint(env).ok,
    async generate(request) {
      const model = request.model;
      if (!model) throw new Error('the Ollama route needs a model; none is chosen');
      const endpoint = resolveOllamaEndpoint(environment);
      if (!endpoint.ok) throw new Error(endpoint.reason);
      const release = acquireExplainerSlot();
      try {
        const deadline = Date.now() + request.timeoutMs;
        const remaining = () => {
          const left = deadline - Date.now();
          if (left <= 0) throw new Error(`explainer timed out after ${request.timeoutMs}ms`);
          return left;
        };
        const chat = (structured: boolean) =>
          loopbackRequest(
            endpoint,
            'POST',
            '/api/chat',
            buildOllamaChatBody(request, model, structured),
            {
              timeoutMs: remaining(),
              maxBytes: MAX_EXPLAINER_OUTPUT_BYTES,
              signal: request.signal,
            },
          );
        const key = `${endpoint.label} ${model}`;
        if (!structuredOutputUnavailable.has(key)) {
          const first = await chat(true);
          if (!isStructuredOutputUnavailable(first))
            return { output: chatOutput(first), model: ollamaGeneratorLabel(model) };
          structuredOutputUnavailable.add(key);
        }
        return { output: chatOutput(await chat(false)), model: ollamaGeneratorLabel(model) };
      } finally {
        release();
      }
    },
  };
}

export type OllamaModelList =
  | { state: 'ready'; endpoint: string; models: string[] }
  | { state: 'unreachable'; endpoint: string; reason: string }
  | { state: 'refused'; reason: string };

/** The installed models, from `/api/tags`. Read-only: this never pulls, loads or deletes one. */
export async function listOllamaModels(
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<OllamaModelList> {
  const endpoint = resolveOllamaEndpoint(environment);
  if (!endpoint.ok) return { state: 'refused', reason: endpoint.reason };
  try {
    const response = await loopbackRequest(endpoint, 'GET', '/api/tags', undefined, {
      timeoutMs: TAGS_TIMEOUT_MS,
      maxBytes: MAX_OLLAMA_TAGS_BYTES,
      signal,
    });
    if (response.status !== 200)
      return {
        state: 'unreachable',
        endpoint: endpoint.label,
        reason: `Ollama answered the model list with HTTP ${response.status}.`,
      };
    const parsed = JSON.parse(response.body) as {
      models?: Array<{ name?: unknown; model?: unknown }>;
    };
    const names = new Set<string>();
    for (const entry of Array.isArray(parsed.models) ? parsed.models : []) {
      const name = typeof entry?.name === 'string' ? entry.name : entry?.model;
      if (typeof name !== 'string') continue;
      const trimmed = name.trim();
      // The same shape a stored model must have, so every offered name can be chosen.
      if (
        trimmed.length > 0 &&
        trimmed.length <= 120 &&
        Array.from(trimmed).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
      )
        names.add(trimmed);
      if (names.size >= 500) break;
    }
    return { state: 'ready', endpoint: endpoint.label, models: [...names].sort() };
  } catch {
    // Salidium's own words only. Nothing Ollama or the socket said is passed to the interface.
    return {
      state: 'unreachable',
      endpoint: endpoint.label,
      reason: 'Ollama did not give a usable model list in time.',
    };
  }
}
