import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ProviderAdapter } from '@salidium/adapter-kit';
import type { CanonicalEvent } from '@salidium/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logging/logger.ts';
import { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { TranscriptTailer } from './transcriptTailer.ts';

const parsedByteLengths: number[] = [];

/** A minimal adapter: every JSON line `{ "n": <number> }` becomes an agent.message event. */
const lineAdapter: ProviderAdapter = {
  id: 'claude-code',
  sessionRoots: (home) => [join(home, 'root')],
  matchSessionFile: (path) =>
    path.endsWith('/s1.jsonl')
      ? { sessionId: 'claude-code:s1', providerSessionId: 's1' }
      : undefined,
  createRecordParser: (ctx) => ({
    parseRecord(line: string, lineNo: number): CanonicalEvent[] {
      parsedByteLengths.push(Buffer.byteLength(line));
      const parsed = JSON.parse(line) as { n: number };
      return [
        {
          id: `${ctx.sessionId}#msg:${parsed.n}`,
          sessionId: ctx.sessionId,
          ts: new Date(1_700_000_000_000 + lineNo).toISOString(),
          tsSource: 'provider',
          source: { provider: 'claude-code', channel: 'transcript' },
          kind: 'agent.message',
          text: `line ${parsed.n}`,
        },
      ];
    },
  }),
  parseHookPayload: () => [],
  transcriptPathFromHook: () => undefined,
};

let tmp: string;
let store: SqliteStore;
let registry: SessionRegistry;
let tailer: TranscriptTailer;
let file: string;

beforeEach(() => {
  parsedByteLengths.length = 0;
  tmp = mkdtempSync(join(tmpdir(), 'salidium-tail-'));
  mkdirSync(join(tmp, 'root'), { recursive: true });
  file = join(tmp, 'root', 's1.jsonl');
  store = new SqliteStore(join(tmp, 'db.sqlite'));
  registry = new SessionRegistry(store);
  tailer = new TranscriptTailer({
    adapters: [lineAdapter],
    registry,
    store,
    log: createLogger('silent'),
  });
});

afterEach(() => {
  tailer.stop();
  registry.close();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function messages(): Promise<string[]> {
  await sleep(150);
  return registry
    .eventsAfter('claude-code:s1', -1)
    .map((e) => (e.kind === 'agent.message' ? e.text : e.kind));
}

describe('TranscriptTailer', () => {
  it('discovers and backfills a provider root created after startup', async () => {
    tailer.stop();
    rmSync(join(tmp, 'root'), { recursive: true, force: true });
    tailer = new TranscriptTailer({
      adapters: [lineAdapter],
      registry,
      store,
      log: createLogger('silent'),
      rootDiscoveryIntervalMs: 20,
    });
    tailer.start(tmp, 30);

    mkdirSync(join(tmp, 'root'), { recursive: true });
    writeFileSync(file, '{"n":1}\n');

    const started = Date.now();
    while (registry.eventsAfter('claude-code:s1', -1).length === 0) {
      if (Date.now() - started > 2000) throw new Error('new provider root was not discovered');
      await sleep(10);
    }
    expect(await messages()).toEqual(['line 1']);
    expect(tailer.watchedCount).toBe(1);
  });

  it('backfills a newly-created root even when its filesystem watcher cannot attach', async () => {
    tailer.stop();
    rmSync(join(tmp, 'root'), { recursive: true, force: true });
    tailer = new TranscriptTailer({
      adapters: [lineAdapter],
      registry,
      store,
      log: createLogger('silent'),
      rootDiscoveryIntervalMs: 20,
      watchRoot: (() => {
        throw new Error('recursive watch unavailable');
      }) as typeof import('node:fs').watch,
    });
    tailer.start(tmp, 30);

    mkdirSync(join(tmp, 'root'), { recursive: true });
    writeFileSync(file, '{"n":1}\n');

    const started = Date.now();
    while (registry.eventsAfter('claude-code:s1', -1).length === 0) {
      if (Date.now() - started > 2000) throw new Error('unwatched root was not backfilled');
      await sleep(10);
    }
    expect(await messages()).toEqual(['line 1']);
  });

  it('persists accepted events before advancing the source cursor', async () => {
    writeFileSync(file, '{"n":1}\n');
    tailer.track(file);
    const started = Date.now();
    while (!store.getSource(file)) {
      if (Date.now() - started > 2000) throw new Error('source cursor was not persisted');
      await sleep(2);
    }

    expect(store.getSource(file)?.byteOffset).toBe(8);
    expect(store.latestSeq('claude-code:s1')).toBe(0);
  });

  it('keeps a missing durable re-ingestion job retryable until the provider file returns', async () => {
    store.upsertSource({
      path: file,
      sessionId: 'claude-code:s1',
      provider: 'claude-code',
      byteOffset: 8,
      lineNo: 1,
    });
    const source = store.getSource(file);
    if (!source) throw new Error('source cursor was not stored');
    store.enqueueReingest(source);
    tailer.start(tmp, 0);

    const missingStarted = Date.now();
    while (store.reingestJobs()[0]?.status !== 'missing') {
      if (Date.now() - missingStarted > 2000) throw new Error('missing job was not recorded');
      await sleep(10);
    }
    expect(store.pendingReingestJobs()[0]?.status).toBe('missing');

    tailer.stop();
    writeFileSync(file, '{"n":9}\n');
    tailer = new TranscriptTailer({
      adapters: [lineAdapter],
      registry,
      store,
      log: createLogger('silent'),
    });
    tailer.start(tmp, 0);
    const completedStarted = Date.now();
    while (store.reingestJobs()[0]?.status !== 'completed') {
      if (Date.now() - completedStarted > 2000)
        throw new Error('returned file was not re-ingested');
      await sleep(10);
    }
    expect(await messages()).toEqual(['line 9']);
    expect(store.reingestJobs()[0]?.attempts).toBe(2);
  });

  it('leaves the recovery cursor unchanged when the related flush fails', async () => {
    const transaction = store.transaction.bind(store);
    let failOnce = true;
    store.transaction = (<T>(fn: () => T): T => {
      if (failOnce) {
        failOnce = false;
        throw new Error('temporary write failure');
      }
      return transaction(fn);
    }) as typeof store.transaction;
    writeFileSync(file, '{"n":1}\n');

    tailer.track(file);
    await sleep(20);

    expect(registry.peek('claude-code:s1')?.state.latestSeq).toBe(0);
    expect(store.latestSeq('claude-code:s1')).toBe(-1);
    expect(store.getSource(file)).toBeUndefined();
    // The coordinator's retry can persist the event later, but advancing the cursor remains the
    // tailer's responsibility on a subsequent read/restart.
    await sleep(120);
    expect(store.latestSeq('claude-code:s1')).toBe(0);
    expect(store.getSource(file)).toBeUndefined();
  });

  it('delivers a record written across two appends exactly once', async () => {
    writeFileSync(file, '{"n":1}\n{"n":2');
    tailer.track(file);
    expect(await messages()).toEqual(['line 1']);
    appendFileSync(file, '}\n');
    tailer.track(file);
    expect(await messages()).toEqual(['line 1', 'line 2']);
    // Two unterminated fragments, then the newline: still exactly one record, offset never negative.
    appendFileSync(file, '{"n":');
    tailer.track(file);
    await sleep(100);
    appendFileSync(file, '3');
    tailer.track(file);
    await sleep(100);
    appendFileSync(file, '}\n{"n":4}\n');
    tailer.track(file);
    expect(await messages()).toEqual(['line 1', 'line 2', 'line 3', 'line 4']);
  });

  it('re-ingests from the start after truncation without duplicating events', async () => {
    writeFileSync(file, '{"n":1}\n{"n":2}\n');
    tailer.track(file);
    expect(await messages()).toEqual(['line 1', 'line 2']);
    writeFileSync(file, '{"n":1}\n'); // truncated / rewritten shorter
    tailer.track(file);
    await sleep(100);
    appendFileSync(file, '{"n":2}\n{"n":5}\n');
    tailer.track(file);
    expect(await messages()).toEqual(['line 1', 'line 2', 'line 5']);
  });

  it('bounds a hostile newline-free record, warns once, and recovers at the next record', async () => {
    tailer.stop();
    tailer = new TranscriptTailer({
      adapters: [lineAdapter],
      registry,
      store,
      log: createLogger('silent'),
      maxRecordBytes: 64,
    });
    writeFileSync(file, 'x'.repeat(80));
    tailer.track(file);
    await sleep(150);

    const first = registry.eventsAfter('claude-code:s1', -1);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: 'ingest.warning',
      code: 'truncated-record',
      detail: 'provider record exceeded 64 bytes and was skipped',
    });
    expect(store.getSource(file)?.byteOffset).toBe(80);
    expect(parsedByteLengths).toEqual([]);

    // Restart from the durable cursor after the oversized record was still unterminated. The
    // tailer safely replays/dedupes its warning, discards through the newline, then resumes.
    tailer.stop();
    appendFileSync(file, `${'y'.repeat(100)}\n{"n":7}\n`);
    tailer = new TranscriptTailer({
      adapters: [lineAdapter],
      registry,
      store,
      log: createLogger('silent'),
      maxRecordBytes: 64,
    });
    tailer.track(file);
    expect(await messages()).toEqual(['ingest.warning', 'line 7']);
    expect(
      registry.eventsAfter('claude-code:s1', -1).filter((event) => event.kind === 'ingest.warning'),
    ).toHaveLength(1);
    expect(Math.max(...parsedByteLengths)).toBeLessThanOrEqual(64);
    expect(store.getSource(file)?.byteOffset).toBe(Buffer.byteLength(readFileForLength()));
  });
});

function readFileForLength(): string {
  return `${'x'.repeat(80)}${'y'.repeat(100)}\n{"n":7}\n`;
}
