import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SalidiumStoreFactory } from './salidiumStore.ts';
import { createSqliteStore } from './sqliteStore.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storageContract(name: string, factory: SalidiumStoreFactory): void {
  describe(`${name} SalidiumStore contract`, () => {
    it('atomically persists, reads, and deduplicates the authoritative event log', () => {
      const dir = mkdtempSync(join(tmpdir(), 'salidium-store-contract-'));
      dirs.push(dir);
      const store = factory(join(dir, 'store.db'));
      const event = {
        id: 'codex:contract#message',
        sessionId: 'codex:contract',
        seq: 0,
        ts: '2026-08-19T00:00:00.000Z',
        tsSource: 'provider' as const,
        source: { provider: 'codex' as const, channel: 'rollout' as const },
        kind: 'agent.message' as const,
        text: 'contract evidence',
      };
      store.transaction(() => {
        store.insertEvents([event, event]);
      });
      expect(store.latestSeq(event.sessionId)).toBe(0);
      expect(store.eventsAfter(event.sessionId, -1)).toEqual([event]);
      expect(store.eventById(event.sessionId, event.id)).toEqual(event);
      store.close();
    });

    it('defaults retention to forever and keeps durable re-ingestion jobs visible', () => {
      const dir = mkdtempSync(join(tmpdir(), 'salidium-store-contract-'));
      dirs.push(dir);
      const store = factory(join(dir, 'store.db'));
      expect(store.retentionPolicy()).toBe('forever');
      const source = {
        path: '/provider/contract.jsonl',
        sessionId: 'codex:contract',
        provider: 'codex',
        byteOffset: 10,
        lineNo: 1,
      };
      store.upsertSource(source);
      store.enqueueReingest(source, 'contract-parser');
      expect(store.pendingReingestJobs()).toMatchObject([
        { path: source.path, status: 'queued', parserRevision: 'contract-parser' },
      ]);
      store.close();
    });
  });
}

storageContract('SQLite', createSqliteStore);
