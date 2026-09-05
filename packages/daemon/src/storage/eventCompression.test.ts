import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionSummary, StoredEvent } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './sqliteStore.ts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('event payload compression', () => {
  it('rejects page sizes SQLite cannot apply', () => {
    const directory = mkdtempSync(join(tmpdir(), 'salidium-event-compression-'));
    directories.push(directory);
    const path = join(directory, 'salidium.db');
    expect(() => new SqliteStore(path, { pageSize: 12_000 })).toThrow(
      'invalid SQLite page size: 12000',
    );
  });

  it('stores large events as gzip BLOBs while preserving reads, usage, and source recovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'salidium-event-compression-'));
    directories.push(directory);
    const path = join(directory, 'salidium.db');
    const store = new SqliteStore(path);
    const sessionId = 'codex:s1';
    const summary: SessionSummary = {
      id: sessionId,
      provider: 'codex',
      providerSessionId: 's1',
      cwd: '/repo',
      status: 'ended',
      latestSeq: 1,
      title: 'Compression test',
    };
    const message: StoredEvent = {
      id: `${sessionId}#message`,
      sessionId,
      seq: 0,
      ts: '2026-09-04T00:00:00.000Z',
      tsSource: 'provider',
      source: {
        provider: 'codex',
        channel: 'rollout',
        ref: { path: '/provider/s1.jsonl', line: 1 },
      },
      kind: 'agent.message',
      text: 'compressible evidence '.repeat(1_000),
    };
    const usage = {
      id: `${sessionId}#usage`,
      sessionId,
      seq: 1,
      ts: '2026-09-04T00:00:01.000Z',
      tsSource: 'provider',
      source: { provider: 'codex', channel: 'rollout' },
      kind: 'agent.usage',
      messageId: 'response-1',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      padding: 'large usage record '.repeat(100),
    } as unknown as StoredEvent;
    store.upsertSession(summary);
    store.insertEvents([message, usage]);

    expect(store.eventsAfter(sessionId, -1)).toEqual([message, usage]);
    expect(store.usageTotals(false)).toEqual({
      messages: 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
    expect(store.reingestSources()).toContainEqual(
      expect.objectContaining({ path: '/provider/s1.jsonl', sessionId, provider: 'codex' }),
    );
    store.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    const rows = raw
      .prepare('SELECT json, typeof(json) AS storage_type FROM events ORDER BY seq')
      .all() as Array<{ json: Uint8Array; storage_type: string }>;
    raw.close();
    expect(rows.every((row) => row.storage_type === 'blob')).toBe(true);
    expect(rows.every((row) => Buffer.from(row.json).subarray(0, 4).toString() === 'SEV1')).toBe(
      true,
    );
  });
});
