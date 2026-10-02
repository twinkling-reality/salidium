import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyEvent, createInitialState } from '@salidium/core';
import type { StoredEvent } from '@salidium/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explainWithStatus, SCHEMA } from './explainer.ts';
import {
  chooseExplainerBackendId,
  type ExplainerBackendRequest,
  explainedConfiguration,
  resolveExplainerBackend,
} from './explainerBackends.ts';
import {
  acquireExplainerSlot,
  MAX_EXPLAINER_OUTPUT_BYTES,
  MAX_EXPLAINER_PROCESSES,
} from './explainerCapacity.ts';
import {
  createOllamaExplainerBackend,
  listOllamaModels,
  ollamaGeneratorLabel,
  resetOllamaStructuredOutputMemory,
  resolveOllamaEndpoint,
} from './ollamaBackend.ts';

/**
 * The local route's promise is that nothing leaves the machine. These tests stand up a fake Ollama
 * on loopback and check the parts that keep that promise: the address, redirects, the byte bound,
 * time and cancellation, and that choosing `ollama` never turns into a CLI call when it cannot run.
 */

const MODEL = 'qwen-test:1b';

const VALID = JSON.stringify({
  what: { summary: 'Two components rotated the same token.', currently: null },
  why: { summary: 'race', lanes: [], chain: ['two rotations', 'token invalidated'] },
  how: { summary: 'move ownership', root: 'SessionManager', steps: ['add a mutex'] },
  approachChange: null,
});

interface Seen {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string, index: number) => void;

let server: Server;
let port: number;
let seen: Seen[];
let handler: Handler;
/** `/api/show` is asked before every chat; kept apart so `seen` stays the chat and tag requests. */
let shows: string[];
let showHandler: (res: ServerResponse) => void;
const sockets = new Set<import('node:net').Socket>();

function env(): NodeJS.ProcessEnv {
  return { OLLAMA_HOST: `127.0.0.1:${port}` };
}

function reply(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function chat(content: string, extra: Record<string, unknown> = {}) {
  return { model: MODEL, message: { role: 'assistant', content }, done: true, ...extra };
}

const request = (overrides: Partial<ExplainerBackendRequest> = {}): ExplainerBackendRequest => ({
  prompt: '[salidium-explainer] Explain this.',
  evidence: '{"ask":"Fix it"}',
  schema: SCHEMA,
  model: MODEL,
  timeoutMs: 5_000,
  ...overrides,
});

beforeEach(async () => {
  resetOllamaStructuredOutputMemory();
  seen = [];
  shows = [];
  showHandler = (res) => reply(res, 200, { details: { format: 'gguf' }, capabilities: [] });
  handler = (_req, res) => reply(res, 200, chat(VALID));
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (req.url === '/api/show') {
        shows.push(body ? String((JSON.parse(body) as { model?: unknown }).model) : '');
        showHandler(res);
        return;
      }
      const index = seen.length;
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: body ? (JSON.parse(body) as Record<string, unknown>) : undefined,
      });
      handler(req, res, body, index);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function stateWithWork() {
  const state = createInitialState({
    sessionId: 'claude-code:ollama-test',
    provider: 'claude-code',
    providerSessionId: 'ollama-test',
  });
  applyEvent(state, {
    id: '#turn:1:start',
    sessionId: 'claude-code:ollama-test',
    provider: 'claude-code',
    ts: '2026-01-01T00:00:00.000Z',
    tsSource: 'provider',
    source: { provider: 'claude-code', channel: 'transcript' },
    kind: 'turn.started',
    turnId: 't1',
    prompt: 'Fix the refresh race',
    seq: 0,
  } as unknown as StoredEvent);
  return state;
}

describe('the Ollama address', () => {
  it('defaults to 127.0.0.1:11434', () => {
    expect(resolveOllamaEndpoint({})).toEqual({
      ok: true,
      host: '127.0.0.1',
      port: 11434,
      label: 'http://127.0.0.1:11434',
    });
  });

  it('accepts only the literal loopback addresses, and connects localhost to 127.0.0.1', () => {
    for (const [value, host, port] of [
      ['127.0.0.1', '127.0.0.1', 11434],
      ['127.0.0.1:9999', '127.0.0.1', 9999],
      ['http://127.0.0.1:9999', '127.0.0.1', 9999],
      ['http://127.0.0.1', '127.0.0.1', 80],
      ['localhost:9999', '127.0.0.1', 9999],
      ['http://LOCALHOST:9999/', '127.0.0.1', 9999],
      ['[::1]:9999', '::1', 9999],
      ['http://[::1]:9999', '::1', 9999],
    ] as const) {
      const endpoint = resolveOllamaEndpoint({ OLLAMA_HOST: value });
      expect(endpoint, value).toMatchObject({ ok: true, host, port });
    }
  });

  it('refuses every host that is not loopback, and every shape that could smuggle one', () => {
    for (const value of [
      '0.0.0.0',
      '0.0.0.0:11434',
      '10.0.0.5:11434',
      'ollama.example.com',
      'http://example.com:11434',
      'https://127.0.0.1:11434',
      'http://user:pass@127.0.0.1:11434',
      'http://127.0.0.1:11434/proxy',
      'http://127.0.0.1:11434/?next=http://example.com',
      'http://127.0.0.1.example.com',
      'http://localhost.example.com',
      '[::ffff:7f00:1]:11434',
      '[::]:11434',
      'ftp://127.0.0.1',
      'not a host at all',
    ]) {
      const endpoint = resolveOllamaEndpoint({ OLLAMA_HOST: value });
      expect(endpoint.ok, value).toBe(false);
    }
  });
});

describe('the Ollama explainer backend', () => {
  it('asks for structured output first, with thinking off and temperature 0', async () => {
    const backend = createOllamaExplainerBackend(env());
    const result = await backend.generate(request());
    expect(result).toEqual({ output: VALID, model: `${MODEL} · Ollama` });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('/api/chat');
    expect(seen[0]?.body).toMatchObject({
      model: MODEL,
      stream: false,
      think: false,
      options: { temperature: 0 },
      format: SCHEMA,
    });
    const messages = seen[0]?.body?.messages as Array<{ role: string; content: string }>;
    expect(messages).toEqual([
      { role: 'user', content: '[salidium-explainer] Explain this. {"ask":"Fix it"}' },
    ]);
  });

  it('on the structured-output 501, retries once with the schema stated, and remembers it', async () => {
    handler = (_req, res, _body, index) =>
      index === 0
        ? reply(res, 501, { error: 'structured output is unavailable' })
        : reply(res, 200, chat(`\`\`\`json\n${VALID}\n\`\`\``));
    const backend = createOllamaExplainerBackend(env());
    const first = await backend.generate(request());
    expect(first.output).toBe(VALID);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.body?.format).toBeUndefined();
    const messages = seen[1]?.body?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain(JSON.stringify(SCHEMA));
    expect(messages[1]?.content).toContain('{"ask":"Fix it"}');

    // The next call for the same model goes straight to the schema-in-prompt request.
    await backend.generate(request());
    expect(seen).toHaveLength(3);
    expect(seen[2]?.body?.format).toBeUndefined();
  });

  it('does not treat any other 501 or error as the structured-output fallback', async () => {
    handler = (_req, res) => reply(res, 501, { error: 'not implemented' });
    const backend = createOllamaExplainerBackend(env());
    await expect(backend.generate(request())).rejects.toThrow(/ollama answered 501/);
    expect(seen).toHaveLength(1);
  });

  it('records malformed model output as a failure', async () => {
    handler = (_req, res) => reply(res, 200, chat('Here is the explanation you wanted.'));
    const result = await explainWithStatus(stateWithWork(), {
      backend: createOllamaExplainerBackend(env()),
      model: MODEL,
    });
    expect(result.status).toBe('failed');
  });

  it('records well-formed JSON of the wrong shape as a failure', async () => {
    handler = (_req, res) => reply(res, 200, chat('{"what":"nope"}'));
    const result = await explainWithStatus(stateWithWork(), {
      backend: createOllamaExplainerBackend(env()),
      model: MODEL,
    });
    expect(result.status).toBe('failed');
  });

  it('produces an explained event whose generator label names the model', async () => {
    const result = await explainWithStatus(stateWithWork(), {
      backend: createOllamaExplainerBackend(env()),
      model: MODEL,
    });
    expect(result.status).toBe('generated');
    if (result.status !== 'generated') return;
    expect((result.event as { model: string }).model).toBe(`${MODEL} · Ollama`);
  });

  it('stops reading at the byte ceiling', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Streamed without a length so the ceiling is enforced on the bytes, not the header.
      const chunk = 'x'.repeat(16 * 1024);
      for (let i = 0; i < 12; i += 1) res.write(chunk);
      res.end();
    };
    const backend = createOllamaExplainerBackend(env());
    await expect(backend.generate(request())).rejects.toThrow(
      `ollama response exceeded ${MAX_EXPLAINER_OUTPUT_BYTES} bytes`,
    );
  });

  it('refuses a declared length over the ceiling before reading it', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Length': String(MAX_EXPLAINER_OUTPUT_BYTES + 1) });
      res.write('{');
    };
    const backend = createOllamaExplainerBackend(env());
    await expect(backend.generate(request())).rejects.toThrow(/exceeded/);
  });

  it('times out a request that never answers', async () => {
    handler = () => {};
    const backend = createOllamaExplainerBackend(env());
    await expect(backend.generate(request({ timeoutMs: 150 }))).rejects.toThrow(/timed out/);
  });

  it('cancels a request in flight when the signal aborts, and closes the connection', async () => {
    handler = () => {};
    const controller = new AbortController();
    const backend = createOllamaExplainerBackend(env());
    const pending = backend.generate(request({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toThrow('explainer canceled');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets.size).toBe(0);
  });

  it('refuses a redirect instead of following it', async () => {
    handler = (_req, res) => {
      res.writeHead(307, { Location: 'http://example.com/api/chat' });
      res.end();
    };
    const backend = createOllamaExplainerBackend(env());
    await expect(backend.generate(request())).rejects.toThrow(/redirects are refused/);
    expect(seen).toHaveLength(1);
  });

  it('never connects when the configured host is not loopback', async () => {
    const backend = createOllamaExplainerBackend({ OLLAMA_HOST: `10.0.0.5:${port}` });
    await expect(backend.generate(request())).rejects.toThrow(/not a loopback address/);
    expect(seen).toHaveLength(0);
  });

  it('requires a model and never sends a request without one', async () => {
    const backend = createOllamaExplainerBackend(env());
    await expect(backend.generate(request({ model: undefined }))).rejects.toThrow(/needs a model/);
    expect(seen).toHaveLength(0);
  });

  it('shares the explainer concurrency ceiling with the CLI routes', async () => {
    const held = Array.from({ length: MAX_EXPLAINER_PROCESSES }, () => acquireExplainerSlot());
    try {
      const backend = createOllamaExplainerBackend(env());
      await expect(backend.generate(request())).rejects.toThrow(/process limit/);
      expect(seen).toHaveLength(0);
    } finally {
      for (const release of held) release();
    }
    await createOllamaExplainerBackend(env()).generate(request());
  });
});

describe('Ollama cloud models', () => {
  it('asks Ollama what the model is before sending it anything', async () => {
    await createOllamaExplainerBackend(env()).generate(request());
    expect(shows).toEqual([MODEL]);
    expect(seen).toHaveLength(1);
  });

  it('refuses a model that Ollama says runs remotely, before any chat request', async () => {
    showHandler = (res) =>
      reply(res, 200, { remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' });
    const backend = createOllamaExplainerBackend(env());
    await expect(backend.generate(request())).rejects.toThrow(/ollama\.com/);
    expect(seen).toHaveLength(0);
  });

  it('refuses a cloud-tagged name without asking Ollama at all', async () => {
    for (const model of ['gpt-oss:120b-cloud', 'deepseek-v3.1:671b-cloud', 'kimi:cloud']) {
      await expect(
        createOllamaExplainerBackend(env()).generate(request({ model })),
      ).rejects.toThrow(/cloud/);
    }
    expect(shows).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it('records a model Ollama does not have as a failure without a chat request', async () => {
    showHandler = (res) => reply(res, 404, { error: 'model not found' });
    await expect(createOllamaExplainerBackend(env()).generate(request())).rejects.toThrow(
      /not have model/,
    );
    expect(seen).toHaveLength(0);
  });

  it('never offers a cloud model in the installed list', async () => {
    handler = (_req, res) =>
      reply(res, 200, {
        models: [
          { name: 'local:7b' },
          { name: 'gpt-oss:120b-cloud' },
          { name: 'sneaky:latest', remote_host: 'https://ollama.com:443' },
          { name: 'other:1b', remote_model: 'x' },
        ],
      });
    const list = await listOllamaModels(env());
    expect(list).toMatchObject({ state: 'ready', models: ['local:7b'] });
  });
});

describe('selecting the Ollama route', () => {
  it('is never chosen by auto, even when it is the only writer available', () => {
    expect(chooseExplainerBackendId('claude-code', 'auto', new Set(['ollama']))).toBeUndefined();
    expect(chooseExplainerBackendId('codex', 'auto', new Set(['ollama']))).toBeUndefined();
  });

  it('never falls through to a CLI when ollama is chosen but cannot run', () => {
    const everything = new Set(['claude', 'codex']);
    expect(chooseExplainerBackendId('claude-code', 'ollama', everything)).toBeUndefined();
    expect(chooseExplainerBackendId('codex', 'ollama', everything)).toBeUndefined();
    // The local route is what runs whenever it is selected, usable or not, so its own refusal is
    // what gets recorded; a CLI is never resolved in its place.
    for (const environment of [{ OLLAMA_HOST: '10.0.0.5' }, env(), {}])
      for (const provider of ['claude-code', 'codex'] as const)
        expect(resolveExplainerBackend(provider, environment, 'ollama')?.id).toBe('ollama');
  });

  it('records a selected but unusable local route as a failed attempt, never a fallback', async () => {
    const state = stateWithWork();
    // No model chosen.
    expect(
      await explainWithStatus(state, { mode: 'ollama', environment: env(), model: undefined }),
    ).toEqual({ status: 'failed' });
    // A refused address.
    expect(
      await explainWithStatus(state, {
        mode: 'ollama',
        environment: { OLLAMA_HOST: '10.0.0.5' },
        model: MODEL,
      }),
    ).toEqual({ status: 'failed' });
    expect(seen).toHaveLength(0);
    // Ollama not answering on its port.
    expect(
      await explainWithStatus(state, {
        mode: 'ollama',
        environment: { OLLAMA_HOST: '127.0.0.1:1' },
        model: MODEL,
      }),
    ).toEqual({ status: 'failed' });
    // An Ollama that answers with an error, including the model missing.
    handler = (_req, res) => reply(res, 404, { error: `model '${MODEL}' not found` });
    expect(
      await explainWithStatus(state, { mode: 'ollama', environment: env(), model: MODEL }),
    ).toEqual({ status: 'failed' });
    expect(seen.map((r) => r.url)).toEqual(['/api/chat']);
  });

  it('leaves auto with nothing to run when Ollama is the only writer', () => {
    const configured = explainedConfiguration('auto', MODEL, { ...env(), PATH: '' });
    expect(configured.availableBackends).not.toContain('ollama');
    expect(chooseExplainerBackendId('claude-code', 'auto', new Set(['ollama']))).toBeUndefined();
    expect(resolveExplainerBackend('codex', env(), 'auto')?.id).not.toBe('ollama');
  });

  it('reports one local route for both providers, and why a refused address cannot run', () => {
    const configured = explainedConfiguration('ollama', MODEL, env());
    expect(configured.routes).toEqual({
      claudeCode: { backend: 'ollama', model: ollamaGeneratorLabel(MODEL) },
      codex: { backend: 'ollama', model: ollamaGeneratorLabel(MODEL) },
    });
    expect(configured.ollama).toEqual({ endpoint: `http://127.0.0.1:${port}`, refused: null });

    const noModel = explainedConfiguration('ollama', null, env());
    expect(noModel.routes.claudeCode).toEqual({ backend: null, model: null });

    const refused = explainedConfiguration('ollama', MODEL, { OLLAMA_HOST: '0.0.0.0' });
    expect(refused.routes.claudeCode).toEqual({ backend: null, model: null });
    expect(refused.ollama?.endpoint).toBeNull();
    expect(refused.ollama?.refused).toMatch(/loopback/);

    expect(explainedConfiguration('auto', MODEL, env()).ollama).toBeUndefined();
  });

  it('accepts ollama as an explicit launch override', () => {
    const configured = explainedConfiguration('auto', MODEL, {
      ...env(),
      SALIDIUM_EXPLAINER: 'ollama',
    });
    expect(configured.mode).toBe('ollama');
    expect(configured.backendLocked).toBe(true);
  });

  it('keeps a long model name within the explanation label limit', () => {
    const long = 'm'.repeat(118);
    expect(ollamaGeneratorLabel(long)).toBe(long);
  });
});

describe('installed Ollama models', () => {
  it('lists names from /api/tags and never asks for anything else', async () => {
    handler = (_req, res) =>
      reply(res, 200, {
        models: [
          { name: 'zeta:1b', model: 'zeta:1b' },
          { name: 'alpha:2b' },
          { name: 'bad\u0007name' },
          { size: 3 },
        ],
      });
    expect(await listOllamaModels(env())).toEqual({
      state: 'ready',
      endpoint: `http://127.0.0.1:${port}`,
      models: ['alpha:2b', 'zeta:1b'],
    });
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /api/tags']);
  });

  it('says when Ollama is not answering, and when the address is refused', async () => {
    const closed = await listOllamaModels({ OLLAMA_HOST: '127.0.0.1:1' });
    expect(closed.state).toBe('unreachable');
    const refused = await listOllamaModels({ OLLAMA_HOST: 'example.com' });
    expect(refused.state).toBe('refused');
  });

  it('turns every bad answer into unreachable in its own words, within about two seconds', async () => {
    const SECRET = 'ollama-internal-detail';
    const answers: Handler[] = [
      (_req, res) => reply(res, 500, { error: SECRET }),
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(`not json ${SECRET}`);
      },
      (_req, res) => reply(res, 200, null),
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(`{"models":[{"name":"${'a'.repeat(300 * 1024)}"}]}`);
      },
      (_req, res) => {
        res.writeHead(302, { Location: 'http://example.com/api/tags' });
        res.end();
      },
      () => {},
    ];
    for (const answer of answers) {
      handler = answer;
      const started = Date.now();
      const list = await listOllamaModels(env());
      expect(list.state).toBe('unreachable');
      expect(JSON.stringify(list)).not.toContain(SECRET);
      expect(JSON.stringify(list)).not.toContain('example.com');
      expect(Date.now() - started).toBeLessThan(2_600);
    }
  });
});
