import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInitialState } from '@salidium/core';
import type { StoredEvent } from '@salidium/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectStoreLayout, optimizeStoreLayout } from './optimizeStore.ts';
import { MAX_RAW_FINGERPRINT_CONFLICTS, SqliteStore } from './sqliteStore.ts';

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'salidium-storage-optimize-'));
  path = join(directory, 'salidium.db');
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function event(seq: number, text: string): StoredEvent {
  return {
    id: `claude-code:s1#message:${seq}`,
    sessionId: 'claude-code:s1',
    seq,
    ts: new Date(1_700_000_000_000 + seq).toISOString(),
    tsSource: 'provider',
    source: {
      provider: 'claude-code',
      channel: 'transcript',
      ref: { path: '/provider/s1.jsonl', line: seq },
    },
    kind: 'agent.message',
    text,
  };
}

function seedLegacyStore(): StoredEvent[] {
  const events = [event(0, 'small'), event(1, 'large '.repeat(2_000))];
  const store = new SqliteStore(path);
  store.insertEvents(events);
  store.saveCheckpoint(
    'claude-code:s1',
    1,
    'test-reducer',
    createInitialState({
      sessionId: 'claude-code:s1',
      provider: 'claude-code',
      providerSessionId: 's1',
    }),
  );
  store.close();

  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = DELETE;');
  db.exec(`
    DROP INDEX events_by_id;
    DROP INDEX events_by_kind;
    DROP TABLE events;
    CREATE TABLE events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      agent_id TEXT,
      turn_id TEXT,
      json TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID;
    CREATE UNIQUE INDEX events_by_id ON events(session_id, event_id);
    CREATE INDEX events_by_kind ON events(session_id, kind);
  `);
  const insert = db.prepare(
    'INSERT INTO events(session_id, seq, event_id, ts, kind, agent_id, turn_id, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const item of events)
    insert.run(
      item.sessionId,
      item.seq,
      item.id,
      item.ts,
      item.kind,
      item.agentId ?? null,
      item.turnId ?? null,
      JSON.stringify(item),
    );
  db.prepare("DELETE FROM meta WHERE key LIKE 'storage_layout_%'").run();
  db.exec('PRAGMA page_size = 4096; VACUUM;');
  db.close();
  return events;
}

describe('offline storage layout optimization', () => {
  it('streams encoded rows under fixed row and byte transaction ceilings', () => {
    const source = readFileSync(join(import.meta.dirname, 'optimizeStore.ts'), 'utf8');
    expect(source).toContain(
      "copyEncodedTable(db, source, 'events', 'json', 2_000, 32 * 1024 * 1024)",
    );
    expect(source).not.toContain('? IS NULL OR');
    expect(source).not.toMatch(/\bOFFSET\b/);
  });

  it('copies, compresses, verifies, and atomically swaps the authoritative store', () => {
    const expected = seedLegacyStore();
    const before = inspectStoreLayout(path);
    expect(before).toMatchObject({
      optimized: false,
      pageSize: 4096,
      eventsWithoutRowid: true,
      eventJsonType: 'TEXT',
    });

    const stages: string[] = [];
    const result = optimizeStoreLayout(path, {
      availableBytes: Number.MAX_SAFE_INTEGER,
      now: new Date('2026-09-04T12:00:00.000Z'),
      onProgress: (stage) => stages.push(stage),
    });

    expect(result.alreadyOptimized).toBe(false);
    expect(result.eventRows).toBe(2);
    expect(result.checkpointRows).toBe(1);
    expect(result.sourceDigest).toBe(result.targetDigest);
    expect(result.layout).toMatchObject({
      optimized: true,
      pageSize: 16_384,
      eventsWithoutRowid: false,
      eventJsonType: 'BLOB',
      checkpointType: 'BLOB',
    });
    expect(stages).toEqual([
      'creating optimized store',
      'copying losslessly',
      'verifying logical digest',
      'swapping verified store',
    ]);
    expect(readdirSync(directory).filter((name) => name.includes('optimizing-'))).toEqual([]);
    expect(readdirSync(directory).filter((name) => name.includes('pre-optimize-'))).toEqual([]);

    const raw = new DatabaseSync(path, { readOnly: true });
    const payloads = raw
      .prepare('SELECT json, typeof(json) AS kind FROM events ORDER BY seq')
      .all() as Array<{ json: Uint8Array; kind: string }>;
    expect(payloads.every((row) => row.kind === 'blob')).toBe(true);
    expect(
      Buffer.from(payloads[1]?.json ?? [])
        .subarray(0, 4)
        .toString(),
    ).toBe('SEV1');
    raw.close();

    const reopened = new SqliteStore(path, { readOnly: true });
    expect(reopened.eventsAfter('claude-code:s1', -1)).toEqual(expected);
    expect(reopened.latestCheckpoint('claude-code:s1', 'test-reducer')?.seq).toBe(1);
    reopened.close();
    expect(optimizeStoreLayout(path).alreadyOptimized).toBe(true);
  });

  it('does not change the source when free space is below the explicit preflight', () => {
    seedLegacyStore();
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');
    expect(() => optimizeStoreLayout(path, { availableBytes: 1 })).toThrow(
      'storage optimization needs',
    );
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before);
    expect(inspectStoreLayout(path).optimized).toBe(false);
    expect(readdirSync(directory)).toEqual(['salidium.db']);
  });
});

describe('diagnostic conflict retention', () => {
  it('bounds old fingerprint conflicts when the store opens', () => {
    new SqliteStore(path).close();
    const db = new DatabaseSync(path);
    db.exec(`WITH RECURSIVE rows(n) AS (
      VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < ${MAX_RAW_FINGERPRINT_CONFLICTS + 5}
    ) INSERT INTO raw_fingerprint_conflicts
      (path, line, candidate_hash, captured_at, session_id, event_id, reason)
      SELECT '/tmp/source', n, 'hash', '2026-09-04T00:00:00.000Z', 'claude-code:s1', 'event', 'test'
      FROM rows;`);
    db.close();

    new SqliteStore(path).close();
    const verified = new DatabaseSync(path, { readOnly: true });
    const row = verified
      .prepare('SELECT COUNT(*) AS count, MIN(id) AS oldest FROM raw_fingerprint_conflicts')
      .get() as { count: number; oldest: number };
    verified.close();
    expect(row).toEqual({ count: MAX_RAW_FINGERPRINT_CONFLICTS, oldest: 6 });
  });
});
