import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionSummary, StoredEvent } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, SqliteStore } from './sqliteStore.ts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function summary(id: string, title = id): SessionSummary {
  return {
    id,
    provider: 'codex',
    providerSessionId: id.slice(id.indexOf(':') + 1),
    cwd: '/repo',
    title,
    status: 'ended',
    startedAt: '2026-09-01T00:00:00.000Z',
    lastEventAt: '2026-09-01T00:00:01.000Z',
    latestSeq: 3,
    counts: {
      turns: 1,
      toolCalls: 0,
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      reviewOpen: 0,
      remaining: 0,
    },
  };
}

function usage(
  sessionId: string,
  seq: number,
  messageId: string,
  tokens: number,
  agentId?: string,
): StoredEvent {
  return {
    id: `${sessionId}#usage-${seq}`,
    sessionId,
    seq,
    ts: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString(),
    tsSource: 'provider',
    source: { provider: 'codex', channel: 'rollout' },
    kind: 'agent.usage',
    ...(agentId ? { agentId } : {}),
    messageId,
    inputTokens: tokens,
    outputTokens: tokens * 2,
    cacheReadTokens: tokens * 3,
    cacheWriteTokens: tokens * 4,
  };
}

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'salidium-usage-materialization-'));
  directories.push(directory);
  return join(directory, 'store.db');
}

describe('usage materialization', () => {
  it('replaces repeated response snapshots, separates lanes, and ignores conflicting duplicates', () => {
    const path = temporaryPath();
    const store = new SqliteStore(path);
    const sessionId = 'codex:user';
    store.upsertSession(summary(sessionId));
    store.insertEvents([
      usage(sessionId, 0, 'response-1', 2),
      usage(sessionId, 1, 'response-1', 10),
      usage(sessionId, 2, 'response-1', 7, 'subagent-1'),
    ]);
    expect(store.usageTotals(false)).toEqual({
      messages: 2,
      inputTokens: 17,
      outputTokens: 34,
      cacheReadTokens: 51,
      cacheWriteTokens: 68,
    });

    // Same immutable event identity with a different payload is ignored by the event store and
    // therefore cannot corrupt its derived accounting row.
    store.insertEvents([usage(sessionId, 2, 'response-1', 999, 'subagent-1')]);
    expect(store.usageTotals(false)?.inputTokens).toBe(17);
    store.close();
  });

  it('backfills schema 7 archives once and classifies pre-flag explainer sessions', () => {
    const path = temporaryPath();
    const userId = 'codex:user';
    const internalId = 'codex:internal';
    const seeded = new SqliteStore(path);
    seeded.upsertSession(summary(userId));
    seeded.insertEvents([usage(userId, 0, 'user-response', 11)]);
    seeded.upsertSession(summary(internalId, '[salidium-explainer] explain this'));
    seeded.insertEvents([usage(internalId, 0, 'internal-response', 5)]);
    seeded.close();

    // Recreate the exact schema-7 boundary: durable events remain, while schema-8 read models and
    // columns do not exist yet.
    const old = new DatabaseSync(path);
    old.exec(`
      DROP TABLE session_usage;
      DROP TABLE usage_messages;
      DROP INDEX sessions_internal_activity;
      ALTER TABLE sessions DROP COLUMN activity_at;
      ALTER TABLE sessions DROP COLUMN internal;
      UPDATE meta SET value = '7' WHERE key = 'schema_version';
      DELETE FROM meta WHERE key = 'schema_8_migrated_at';
    `);
    old.close();

    const interrupted = new SqliteStore(path);
    try {
      expect(interrupted.usageBackfillProgress()).toEqual({ complete: false, scannedEvents: 0 });
      expect(interrupted.usageTotals(false)).toBeUndefined();
      expect(interrupted.advanceUsageBackfill(1)).toEqual({ complete: false, scannedEvents: 1 });
    } finally {
      interrupted.close();
    }

    const resumed = new SqliteStore(path);
    try {
      expect(resumed.usageBackfillProgress()).toEqual({ complete: false, scannedEvents: 1 });
      while (!resumed.advanceUsageBackfill(1).complete) {
        // Tiny pages exercise the persisted cursor across the simulated process restart above.
      }
      expect(resumed.usageTotals(false)?.inputTokens).toBe(11);
      expect(resumed.usageTotals(true)?.inputTokens).toBe(5);
      expect(resumed.listSessions().map((session) => session.id)).toEqual([userId]);
    } finally {
      resumed.close();
    }

    const inspected = new DatabaseSync(path, { readOnly: true });
    try {
      const version = inspected
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string };
      expect(Number(version.value)).toBe(SCHEMA_VERSION);
      expect(inspected.prepare('SELECT COUNT(*) AS n FROM usage_messages').get()).toMatchObject({
        n: 2,
      });
    } finally {
      inspected.close();
    }
  });
});
