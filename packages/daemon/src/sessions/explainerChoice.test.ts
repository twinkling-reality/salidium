import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalEvent } from '@salidium/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOllamaStructuredOutputMemory } from '../enrich/ollamaBackend.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { SessionCoordinator, type StoredExplainerChoice } from './sessionCoordinator.ts';

/**
 * The coordinator's own explainer, the one production uses, decides the writer from the stored
 * choice. These run it unmocked against a fake loopback Ollama, so a coordinator that ignored the
 * choice and fell back to `auto` would reach for a CLI instead and the fake would see nothing.
 */

const VALID = JSON.stringify({
  what: { summary: 'The total was stale.', currently: null },
  why: { summary: 'cache', lanes: [], chain: ['coupon removed', 'cache kept total'] },
  how: { summary: 'recompute', root: 'CartSummary', steps: ['recompute on change'] },
  approachChange: null,
});

const temporaryDirectories: string[] = [];
let server: Server;
let requests: string[];

beforeEach(async () => {
  resetOllamaStructuredOutputMemory();
  requests = [];
  server = createServer((req, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          req.url === '/api/show'
            ? { details: {} }
            : { message: { role: 'assistant', content: VALID }, done: true },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('OLLAMA_HOST', `127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.stubEnv('SALIDIUM_EXPLAINER', undefined);
  vi.stubEnv('SALIDIUM_EXPLAIN', undefined);
  vi.stubEnv('SALIDIUM_EXPLAIN_MODEL', undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function event(sessionId: string, kind: 'turn.started' | 'turn.ended', n: number): CanonicalEvent {
  const base = {
    id: `${sessionId}#turn:${n}:${kind === 'turn.started' ? 'start' : 'end'}`,
    sessionId,
    provider: 'claude-code' as const,
    ts: new Date(Date.UTC(2026, 9, 2, 0, n * 2 + (kind === 'turn.ended' ? 1 : 0))).toISOString(),
    tsSource: 'provider' as const,
    source: { provider: 'claude-code' as const, channel: 'transcript' as const },
    turnId: `t${n}`,
  };
  return (
    kind === 'turn.started'
      ? { ...base, kind, prompt: 'Fix the stale total' }
      : { ...base, kind, outcome: 'completed' }
  ) as CanonicalEvent;
}

function coordinator(explainerChoice?: () => StoredExplainerChoice) {
  const path = mkdtempSync(join(tmpdir(), 'salidium-explainer-choice-'));
  temporaryDirectories.push(path);
  const store = new SqliteStore(join(path, 'test.db'));
  const sessionId = `claude-code:choice-${Math.random().toString(16).slice(2)}`;
  const c = SessionCoordinator.load({
    sessionId,
    provider: 'claude-code',
    providerSessionId: sessionId,
    store,
    listener: { onEvents: () => {}, onSummary: () => {} },
    options: {
      cadence: 'turn',
      flushDelayMs: 10_000,
      ...(explainerChoice ? { explainerChoice } : {}),
    },
  });
  return { c, sessionId };
}

async function settled(c: SessionCoordinator): Promise<string | undefined> {
  for (let i = 0; i < 200; i++) {
    const status = c.summary.explanationStatus;
    if (status && status !== 'generating') return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return c.summary.explanationStatus;
}

describe("the coordinator's default explainer", () => {
  it('writes with the stored local Ollama choice, not an auto default', async () => {
    const { c, sessionId } = coordinator(() => ({ backend: 'ollama', model: 'local:1b' }));
    c.ingest([event(sessionId, 'turn.started', 1), event(sessionId, 'turn.ended', 1)]);
    expect(await settled(c)).toBe('generated');
    expect(requests).toEqual(['POST /api/show', 'POST /api/chat']);
    expect(c.state.explained?.model).toBe('local:1b · Ollama');
  });

  it('records a stored Ollama choice without a model as failed, never trying another writer', async () => {
    const { c, sessionId } = coordinator(() => ({ backend: 'ollama', model: null }));
    c.ingest([event(sessionId, 'turn.started', 1), event(sessionId, 'turn.ended', 1)]);
    expect(await settled(c)).toBe('failed');
    expect(requests).toEqual([]);
  });

  it('reads the choice at call time, so a change applies to the next turn', async () => {
    let choice: StoredExplainerChoice = { backend: 'ollama', model: null };
    const { c, sessionId } = coordinator(() => choice);
    c.ingest([event(sessionId, 'turn.started', 1), event(sessionId, 'turn.ended', 1)]);
    expect(await settled(c)).toBe('failed');
    choice = { backend: 'ollama', model: 'local:1b' };
    c.ingest([event(sessionId, 'turn.started', 2), event(sessionId, 'turn.ended', 2)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await settled(c)).toBe('generated');
    expect(requests).toEqual(['POST /api/show', 'POST /api/chat']);
  });

  it('generates nothing when no stored choice was handed to it', async () => {
    const { c, sessionId } = coordinator();
    c.ingest([event(sessionId, 'turn.started', 1), event(sessionId, 'turn.ended', 1)]);
    expect(await settled(c)).toBe('unavailable');
    expect(requests).toEqual([]);
  });
});
