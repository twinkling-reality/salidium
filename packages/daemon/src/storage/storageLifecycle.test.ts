import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type CanonicalEvent,
  type SessionSummary,
  SessionSummarySchema,
  type StoredEvent,
} from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { SqliteStore } from './sqliteStore.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryStore() {
  const dir = mkdtempSync(join(tmpdir(), 'salidium-lifecycle-'));
  dirs.push(dir);
  return { dir, path: join(dir, 'store.db'), store: new SqliteStore(join(dir, 'store.db')) };
}

function summary(
  id: string,
  status: SessionSummary['status'] = 'ended',
  at = '2020-01-01T00:00:00.000Z',
): SessionSummary {
  return {
    id,
    provider: 'codex',
    providerSessionId: id.slice(id.indexOf(':') + 1),
    cwd: '/repo',
    title: id,
    status,
    startedAt: at,
    lastEventAt: at,
    ...(status === 'ended' ? { endedAt: at } : {}),
    latestSeq: 0,
    counts: {
      turns: 0,
      toolCalls: 0,
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      reviewOpen: 0,
      remaining: 0,
    },
  };
}

function message(id: string, eventId = `${id}#message`): StoredEvent {
  return {
    id: eventId,
    sessionId: id,
    seq: 0,
    ts: '2020-01-01T00:00:00.000Z',
    tsSource: 'provider',
    source: { provider: 'codex', channel: 'rollout' },
    kind: 'agent.message',
    text: 'evidence',
  };
}

describe('evidence schema migration', () => {
  it('queues a provider file preserved only in event provenance', () => {
    const { path, store } = temporaryStore();
    const sessionId = 'codex:lost-cursor';
    const providerPath = '/provider/source-only-in-event.jsonl';
    store.upsertSession(summary(sessionId));
    store.insertEvents([
      {
        ...message(sessionId),
        agentId: 'subagent-from-record',
        source: {
          provider: 'codex',
          channel: 'rollout',
          ref: { path: providerPath, line: 7 },
        },
      },
    ]);
    store.close();

    const db = new DatabaseSync(path);
    db.prepare('DELETE FROM sources').run();
    db.prepare('DELETE FROM reingest_jobs').run();
    db.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run();
    db.close();

    const migrated = new SqliteStore(path);
    try {
      expect(migrated.allSources()).toEqual([]);
      expect(migrated.reingestSources()).toMatchObject([
        { path: providerPath, sessionId, provider: 'codex', byteOffset: 0, lineNo: 0 },
      ]);
      expect(migrated.reingestSources()[0]?.agentId).toBeUndefined();
      expect(migrated.pendingReingestJobs()).toMatchObject([
        { path: providerPath, sessionId, provider: 'codex', status: 'queued' },
      ]);
    } finally {
      migrated.close();
    }
  });

  it('does not guess when one event-referenced path ambiguously names two sessions', () => {
    const { path, store } = temporaryStore();
    const providerPath = '/provider/ambiguous.jsonl';
    for (const sessionId of ['codex:first', 'codex:second']) {
      store.upsertSession(summary(sessionId));
      store.insertEvents([
        {
          ...message(sessionId),
          source: {
            provider: 'codex',
            channel: 'rollout',
            ref: { path: providerPath, line: 1 },
          },
        },
      ]);
    }
    store.close();

    const db = new DatabaseSync(path);
    db.prepare('DELETE FROM reingest_jobs').run();
    db.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run();
    db.close();

    const migrated = new SqliteStore(path);
    try {
      expect(migrated.reingestSources()).toEqual([]);
      expect(migrated.pendingReingestJobs()).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it('quarantines a historical event whose non-timestamp shape violates the current contract', () => {
    const { path, store } = temporaryStore();
    const sessionId = 'codex:legacy-explanation';
    store.upsertSession(summary(sessionId));
    store.insertEvents([
      {
        id: `${sessionId}#explanation:0`,
        sessionId,
        seq: 0,
        ts: '2020-01-01T00:00:00.000Z',
        tsSource: 'ingest',
        source: { provider: 'codex', channel: 'salidium' },
        kind: 'salidium.explanation',
        basedOnSeq: 0,
        model: 'legacy-model',
        what: { summary: 'Legacy', currently: null },
        why: { summary: 'Legacy', lanes: [], chain: ['Legacy'] },
        how: { summary: 'Legacy', root: null, steps: ['Legacy'] },
        approachChange: { from: 'old', why: 'changed', to: 'new' },
      } as unknown as StoredEvent,
    ]);
    store.close();

    const db = new DatabaseSync(path);
    db.prepare("UPDATE meta SET value='3' WHERE key='schema_version'").run();
    db.close();

    const migrated = new SqliteStore(path);
    try {
      const event = migrated.eventsAfter(sessionId, -1)[0];
      expect(event).toMatchObject({ kind: 'ingest.warning', seq: 0 });
      expect(event?.id).toContain('migration-invalid-shape');
    } finally {
      migrated.close();
    }
  });

  it('drops an incomplete legacy verification cache so list rows remain wire-valid', () => {
    const { path, store } = temporaryStore();
    const sessionId = 'codex:legacy-summary';
    store.upsertSession(summary(sessionId));
    store.close();

    const db = new DatabaseSync(path);
    const legacy = {
      ...summary(sessionId),
      lastVerification: { outcome: 'pass', at: '2020-01-01T00:00:00Z' },
    };
    db.prepare('UPDATE sessions SET summary_json = ? WHERE id = ?').run(
      JSON.stringify(legacy),
      sessionId,
    );
    db.prepare("UPDATE meta SET value='1' WHERE key='schema_version'").run();
    db.close();

    const migrated = new SqliteStore(path);
    try {
      const row = migrated.getSession(sessionId);
      expect(SessionSummarySchema.safeParse(row).success).toBe(true);
      expect(row?.lastVerification).toBeUndefined();
    } finally {
      migrated.close();
    }
  });

  it('keeps sequences contiguous when a legacy Claude hook id already has a :hook row', () => {
    const { path, store } = temporaryStore();
    const sessionId = 'claude-code:legacy';
    store.upsertSession({ ...summary(sessionId), provider: 'claude-code' });
    store.upsertSource({
      path: '/provider/legacy.jsonl',
      sessionId,
      provider: 'claude-code',
      byteOffset: 100,
      lineNo: 2,
    });
    store.close();

    const db = new DatabaseSync(path);
    db.prepare("UPDATE meta SET value='1' WHERE key='schema_version'").run();
    const insert = db.prepare(
      'INSERT INTO events (session_id, seq, event_id, ts, kind, json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const legacy = {
      id: `${sessionId}#tool:call-1:result`,
      sessionId,
      seq: 0,
      ts: '2020-01-01T00:00:00.000Z',
      tsSource: 'ingest',
      source: { provider: 'claude-code', channel: 'hook' },
      kind: 'tool.completed',
      callId: 'call-1',
      toolName: 'Bash',
      result: { kind: 'generic', excerpt: 'old hook' },
      isError: false,
    };
    const suffixed = { ...legacy, id: `${legacy.id}:hook`, seq: 1 };
    insert.run(sessionId, 0, legacy.id, legacy.ts, legacy.kind, JSON.stringify(legacy));
    insert.run(sessionId, 1, suffixed.id, suffixed.ts, suffixed.kind, JSON.stringify(suffixed));
    db.close();

    const migrated = new SqliteStore(path);
    try {
      const events = migrated.eventsAfter(sessionId, -1);
      expect(events.map((event) => event.seq)).toEqual([0, 1]);
      expect(events[0]).toMatchObject({ kind: 'ingest.warning', seq: 0 });
      expect(events[1]?.id).toBe(`${legacy.id}:hook`);
      expect(migrated.pendingReingestJobs()).toMatchObject([
        { path: '/provider/legacy.jsonl', sessionId, status: 'queued' },
      ]);
    } finally {
      migrated.close();
    }
  });

  it('upgrades location-keyed fingerprints to immutable event identities', () => {
    const { path, store } = temporaryStore();
    store.close();
    const db = new DatabaseSync(path);
    db.exec(`
      DROP INDEX raw_fingerprints_by_location;
      DROP TABLE raw_record_fingerprints;
      CREATE TABLE raw_record_fingerprints (
        path TEXT NOT NULL, line INTEGER NOT NULL, record_hash TEXT NOT NULL,
        captured_at TEXT NOT NULL, origin TEXT NOT NULL, session_id TEXT NOT NULL,
        event_id TEXT NOT NULL, PRIMARY KEY (path, line)
      ) WITHOUT ROWID;
    `);
    db.prepare('INSERT INTO raw_record_fingerprints VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      '/provider/old.jsonl',
      4,
      `sha256:${'c'.repeat(64)}`,
      '2026-08-19T00:00:00.000Z',
      'backfill',
      'codex:old',
      'codex:old#message',
    );
    db.prepare("UPDATE meta SET value='2' WHERE key='schema_version'").run();
    db.close();

    const migrated = new SqliteStore(path);
    try {
      expect(
        migrated.rawFingerprint('codex:old', 'codex:old#message', '/provider/old.jsonl', 4)
          ?.recordHash,
      ).toBe(`sha256:${'c'.repeat(64)}`);
    } finally {
      migrated.close();
    }
  });

  it('migrates a legacy table set with no version and leaves a corrected event id reusable', () => {
    const { path, store } = temporaryStore();
    const sessionId = 'codex:no-meta';
    store.upsertSession(summary(sessionId));
    store.close();

    const db = new DatabaseSync(path);
    db.prepare("DELETE FROM meta WHERE key IN ('schema_version', 'schema_2_migrated_at')").run();
    const bad = {
      ...message(sessionId, `${sessionId}#bad-time`),
      ts: 'not-a-time',
    };
    db.prepare(
      'INSERT INTO events (session_id, seq, event_id, ts, kind, json) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(sessionId, 0, bad.id, bad.ts, bad.kind, JSON.stringify(bad));
    db.close();

    const migrated = new SqliteStore(path);
    const registry = new SessionRegistry(migrated);
    try {
      const warning = migrated.eventsAfter(sessionId, -1)[0];
      expect(warning).toMatchObject({ kind: 'ingest.warning', seq: 0 });
      expect(warning?.id).not.toBe(bad.id);
      const corrected = { ...bad, ts: '2020-01-02T00:00:00.000Z' } as CanonicalEvent;
      expect(registry.ingest(sessionId, [corrected])).toBe(1);
      expect(registry.flush(sessionId)).toBe(true);
      expect(migrated.eventById(sessionId, bad.id)?.seq).toBe(1);
    } finally {
      registry.close();
      migrated.close();
    }
  });
});

describe('raw fingerprint backfill', () => {
  it('enriches an identical immutable event and rejects a changed payload', () => {
    const { store } = temporaryStore();
    const sessionId = 'codex:fingerprint';
    const path = '/provider/session.jsonl';
    const stored = {
      ...message(sessionId),
      source: { provider: 'codex' as const, channel: 'rollout' as const, ref: { path, line: 3 } },
    };
    store.insertEvents([stored]);
    const hashA = `sha256:${'a'.repeat(64)}`;
    const same = {
      ...stored,
      source: { ...stored.source, ref: { ...stored.source.ref, recordHash: hashA } },
    };
    delete (same as { seq?: number }).seq;
    expect(store.recordRawFingerprint(same as CanonicalEvent, 'backfill')).toBe(true);
    expect(store.rawFingerprint(sessionId, stored.id, path, 3)?.recordHash).toBe(hashA);

    const changed = {
      ...same,
      text: 'different provider payload',
      source: {
        ...same.source,
        ref: { ...same.source.ref, recordHash: `sha256:${'b'.repeat(64)}` },
      },
    };
    expect(store.recordRawFingerprint(changed as CanonicalEvent, 'backfill')).toBe(false);
    expect(store.rawFingerprint(sessionId, stored.id, path, 3)?.recordHash).toBe(hashA);

    const next = {
      ...same,
      id: `${sessionId}#message-after-rotation`,
      text: 'new record at a reused file line',
      source: {
        ...same.source,
        ref: { ...same.source.ref, recordHash: `sha256:${'d'.repeat(64)}` },
      },
    };
    const { recordHash: _nextHash, ...nextRefWithoutHash } = next.source.ref;
    store.insertEvents([
      {
        ...next,
        seq: 1,
        source: { ...next.source, ref: nextRefWithoutHash },
      } as StoredEvent,
    ]);
    expect(store.recordRawFingerprint(next as CanonicalEvent, 'backfill')).toBe(true);
    expect(store.rawFingerprint(sessionId, stored.id, path, 3)?.recordHash).toBe(hashA);
    expect(store.rawFingerprint(sessionId, next.id, path, 3)?.recordHash).toBe(
      `sha256:${'d'.repeat(64)}`,
    );
    store.close();
  });
});

describe('session-granular retention', () => {
  it('previews and removes only inactive unpinned non-live sessions while preserving cursors', () => {
    const { store } = temporaryStore();
    const expired = 'codex:expired';
    const working = 'codex:working';
    const pinned = 'codex:pinned';
    const live = 'codex:live';
    for (const [id, status] of [
      [expired, 'ended'],
      [working, 'working'],
      [pinned, 'ended'],
      [live, 'ended'],
    ] as const) {
      store.upsertSession(summary(id, status));
      store.insertEvents([message(id)]);
    }
    store.insertEvents([
      {
        id: `${expired}#usage`,
        sessionId: expired,
        seq: 1,
        ts: '2020-01-01T00:00:01.000Z',
        tsSource: 'provider',
        source: { provider: 'codex', channel: 'rollout' },
        kind: 'agent.usage',
        messageId: 'response-1',
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
      },
    ]);
    store.upsertSource({
      path: '/provider/expired.jsonl',
      sessionId: expired,
      provider: 'codex',
      byteOffset: 10,
      lineNo: 1,
    });
    store.pinSession(pinned);
    store.setRetentionPolicy(30);
    const registry = new SessionRegistry(store);
    const removedIds: string[] = [];
    registry.subscribeRemovals((id) => removedIds.push(id));
    registry.snapshot(live);
    try {
      const usageBefore = store.usageTotals(false);
      const preview = store.retentionPreview(30, new Date('2026-08-19T00:00:00.000Z'));
      expect(preview.sessions.map((row) => row.id)).toEqual([expired, live]);

      const removed = registry.applyRetention(new Date('2026-08-19T00:00:00.000Z'));
      expect(removed.sessions.map((row) => row.id)).toEqual([expired]);
      expect(removedIds).toEqual([expired]);
      expect(store.getSession(expired)).toBeUndefined();
      expect(store.getSource('/provider/expired.jsonl')).toBeDefined();
      expect(store.isSessionTombstoned(expired)).toBe(true);
      expect(
        registry.ingest(expired, [{ ...message(expired), seq: undefined } as CanonicalEvent]),
      ).toBe(0);
      expect(store.getSession(working)).toBeDefined();
      expect(store.getSession(pinned)).toBeDefined();
      expect(store.getSession(live)).toBeDefined();
      expect(store.usageTotals(false)).toEqual(usageBefore);
    } finally {
      registry.close();
      store.close();
    }
  });

  it('explicit Forget tombstones a session instead of deleting its anti-resurrection cursor', () => {
    const { store } = temporaryStore();
    const sessionId = 'codex:forgotten';
    const path = '/provider/forgotten.jsonl';
    store.upsertSession(summary(sessionId));
    store.insertEvents([message(sessionId)]);
    store.upsertSource({
      path,
      sessionId,
      provider: 'codex',
      byteOffset: 10,
      lineNo: 1,
    });
    const registry = new SessionRegistry(store);
    registry.forget(sessionId);
    try {
      expect(store.getSession(sessionId)).toBeUndefined();
      expect(store.getSource(path)).toBeDefined();
      expect(store.isSessionTombstoned(sessionId)).toBe(true);
      expect(
        registry.ingest(sessionId, [{ ...message(sessionId), seq: undefined } as CanonicalEvent]),
      ).toBe(0);
    } finally {
      registry.close();
      store.close();
    }
  });
});
