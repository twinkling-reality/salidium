import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalEvent, SessionSummary } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExplanationAttempt } from '../enrich/explainer.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { SessionCoordinator } from './sessionCoordinator.ts';

const temporaryDirectories: string[] = [];

function turnStarted(sessionId: string): CanonicalEvent {
  return {
    kind: 'turn.started',
    id: `${sessionId}#turn:1:start`,
    sessionId,
    provider: 'claude-code',
    ts: '2026-08-18T00:00:00.000Z',
    tsSource: 'provider',
    source: { provider: 'claude-code', channel: 'transcript' },
    turnId: 't1',
    prompt: 'Fix the refresh race',
  };
}

function generated(sessionId: string, basedOnSeq: number): ExplanationAttempt {
  return {
    status: 'generated',
    event: {
      kind: 'salidium.explanation',
      id: `${sessionId}#explanation:${basedOnSeq}`,
      sessionId,
      provider: 'claude-code',
      ts: '2026-08-18T00:00:01.000Z',
      tsSource: 'ingest',
      source: { provider: 'claude-code', channel: 'salidium' },
      basedOnSeq,
      model: 'test-model',
      what: { summary: 'The refresh race is fixed.', currently: null },
      why: { summary: 'Two paths overlapped.', lanes: [], chain: ['paths overlapped'] },
      how: {
        summary: 'One owner now refreshes.',
        root: 'SessionManager',
        steps: ['move ownership'],
      },
      approachChange: null,
    },
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('explanation runtime status', () => {
  it.each(['unavailable', 'failed'] as const)(
    'reports %s without calling it a different outcome',
    async (status) => {
      const path = mkdtempSync(join(tmpdir(), 'salidium-explanation-status-'));
      temporaryDirectories.push(path);
      const store = new SqliteStore(join(path, 'test.db'));
      const sessionId = `claude-code:${status}`;
      const summaries: SessionSummary[] = [];
      const coordinator = SessionCoordinator.load({
        sessionId,
        provider: 'claude-code',
        providerSessionId: status,
        store,
        listener: { onEvents: () => {}, onSummary: (summary) => summaries.push(summary) },
        options: {
          explain: true,
          flushDelayMs: 10_000,
          explainSession: async () => ({ status }),
        },
      });
      coordinator.ingest([turnStarted(sessionId)]);
      coordinator.requestExplanation();
      expect(coordinator.summary.explanationStatus).toBe('generating');
      await new Promise((resolve) => setImmediate(resolve));
      expect(coordinator.summary.explanationStatus).toBe(status);
      coordinator.close();
      store.close();
      expect(summaries.at(-1)?.explanationStatus).toBe(status);
    },
  );

  it('reports disabled without invoking an explainer or claiming failure', () => {
    const path = mkdtempSync(join(tmpdir(), 'salidium-explanation-off-'));
    temporaryDirectories.push(path);
    const store = new SqliteStore(join(path, 'test.db'));
    const sessionId = 'claude-code:disabled';
    let calls = 0;
    const coordinator = SessionCoordinator.load({
      sessionId,
      provider: 'claude-code',
      providerSessionId: 'disabled',
      store,
      listener: { onEvents: () => {}, onSummary: () => {} },
      options: {
        explain: false,
        explainSession: async () => {
          calls += 1;
          return { status: 'failed' };
        },
      },
    });
    coordinator.ingest([turnStarted(sessionId)]);
    coordinator.requestExplanation();
    expect(calls).toBe(0);
    expect(coordinator.summary.explanationStatus).toBe('disabled');
    expect(coordinator.summary).not.toHaveProperty('explainFailed');
    coordinator.close();
    store.close();
  });

  it('reports generated after accepting the validated explanation event', async () => {
    const path = mkdtempSync(join(tmpdir(), 'salidium-explanation-generated-'));
    temporaryDirectories.push(path);
    const store = new SqliteStore(join(path, 'test.db'));
    const sessionId = 'claude-code:generated';
    const coordinator = SessionCoordinator.load({
      sessionId,
      provider: 'claude-code',
      providerSessionId: 'generated',
      store,
      listener: { onEvents: () => {}, onSummary: () => {} },
      options: {
        explain: true,
        flushDelayMs: 10_000,
        explainSession: async (state) => generated(sessionId, state.latestSeq),
      },
    });
    coordinator.ingest([turnStarted(sessionId)]);
    coordinator.requestExplanation();
    await new Promise((resolve) => setImmediate(resolve));
    expect(coordinator.summary.explanationStatus).toBe('generated');
    expect(coordinator.state.explained?.model).toBe('test-model');
    coordinator.close();
    store.close();
  });
});
