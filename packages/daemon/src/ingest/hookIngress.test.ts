import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter } from '@salidium/adapter-kit';
import type { CanonicalEvent } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logging/logger.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { readCollectionGapLedger } from './collectionGaps.ts';
import { HookIngress } from './hookIngress.ts';
import { MAX_SPOOL_DRAIN_BATCH, TRUNCATED_HOOK_PAYLOAD_KEY } from './limits.ts';
import type { TranscriptTailer } from './transcriptTailer.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(
  flush: () => boolean = () => true,
  limits: { maxPayloadBytes?: number; maxSpoolRecordBytes?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'salidium-hooks-'));
  dirs.push(dir);
  const seenPayloads: unknown[] = [];
  const receivedTimes: string[] = [];
  let flushes = 0;
  const sessionId = 'claude-code:hook-session';
  const adapter: ProviderAdapter = {
    id: 'claude-code',
    sessionRoots: () => [],
    matchSessionFile: () => undefined,
    createRecordParser: () => ({ parseRecord: () => [] }),
    parseHookPayload: (payload, ctx): CanonicalEvent[] => {
      seenPayloads.push(payload);
      receivedTimes.push(ctx.receivedAt);
      return [
        {
          id: `${sessionId}#hook:${seenPayloads.length}`,
          sessionId,
          ts: '2026-08-16T10:30:00.000Z',
          tsSource: 'ingest',
          source: { provider: 'claude-code', channel: 'hook' },
          kind: 'notification',
          message: 'done',
        },
      ];
    },
    transcriptPathFromHook: () => undefined,
  };
  const registry = {
    ingest: () => 1,
    flush: () => {
      flushes++;
      return flush();
    },
  } as unknown as SessionRegistry;
  const hooks = new HookIngress({
    adapters: [adapter],
    registry,
    tailer: { track() {} } as unknown as TranscriptTailer,
    spoolDir: dir,
    breakerFile: join(dir, 'hooks-off'),
    userHome: dir,
    log: createLogger('silent'),
    ...limits,
  });
  return { dir, hooks, adapter, registry, seenPayloads, receivedTimes, flushes: () => flushes };
}

describe('HookIngress durability and recovery', () => {
  it('does not report a handled hook until its session flush succeeds', () => {
    const ok = fixture();
    expect(ok.hooks.handle('claude-code', { n: 1 })).toBe(1);
    expect(ok.flushes()).toBe(1);

    const failed = fixture(() => false);
    expect(() => failed.hooks.handle('claude-code', { n: 2 })).toThrow(
      'hook events are not durable yet',
    );
  });

  it('recovers a daily processing file left by an interrupted drain', () => {
    const { dir, hooks, seenPayloads } = fixture();
    const processing = join(dir, 'claude-code.20260816.jsonl.processing');
    writeFileSync(processing, `${JSON.stringify({ payload: { recovered: true } })}\n`);

    hooks.drainSpool();

    expect(seenPayloads).toEqual([{ recovered: true }]);
    expect(existsSync(processing)).toBe(false);
  });

  it('normalizes legacy RFC 3339 spool times but rejects local or locale-shaped times', () => {
    const { dir, hooks, seenPayloads, receivedTimes } = fixture();
    const processing = join(dir, 'claude-code.20260816.jsonl.processing');
    writeFileSync(
      processing,
      `${[
        JSON.stringify({ receivedAt: '2026-08-16T10:30:00Z', payload: { legacy: true } }),
        JSON.stringify({ receivedAt: '2026-08-16T10:30:00', payload: { local: true } }),
        JSON.stringify({ receivedAt: '08/16/2026 10:30:00', payload: { locale: true } }),
      ].join('\n')}\n`,
    );

    hooks.drainSpool();

    expect(seenPayloads).toEqual([{ legacy: true }]);
    expect(receivedTimes).toEqual(['2026-08-16T10:30:00.000Z']);
    expect(existsSync(processing)).toBe(false);
  });

  it('recognizes the full claude-code provider id in an orphaned pending filename', () => {
    const { dir, hooks, seenPayloads } = fixture();
    const pending = join(dir, 'pending');
    mkdirSync(pending);
    const path = join(pending, 'claude-code-1-2-abcd.json');
    writeFileSync(path, JSON.stringify({ recovered: 'pending' }));
    const old = new Date(Date.now() - 20_000);
    utimesSync(path, old, old);

    hooks.drainSpool();

    expect(seenPayloads).toEqual([{ recovered: 'pending' }]);
    expect(existsSync(path)).toBe(false);
  });

  it('claims an atomically-published ready envelope immediately', () => {
    const { dir, hooks, seenPayloads } = fixture();
    const pending = join(dir, 'pending');
    mkdirSync(pending);
    const path = join(pending, 'claude-code-1-2-abcd.ready.json');
    writeFileSync(path, JSON.stringify({ recovered: 'ready' }));

    hooks.drainSpool();

    expect(seenPayloads).toEqual([{ recovered: 'ready' }]);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.processing`)).toBe(false);
  });

  it('retains a current envelope while its provider is disabled and drains it when re-enabled', () => {
    const { dir, adapter, registry, seenPayloads } = fixture();
    const pending = join(dir, 'pending');
    mkdirSync(pending);
    const path = join(pending, 'claude-code_1-2-disabled.ready.json');
    writeFileSync(path, JSON.stringify({ recovered: 'after-enable' }));
    const disabled = new HookIngress({
      adapters: [],
      registry,
      tailer: { track() {} } as unknown as TranscriptTailer,
      spoolDir: dir,
      breakerFile: join(dir, 'hooks-off'),
      userHome: dir,
      log: createLogger('silent'),
    });

    disabled.drainSpool();
    expect(seenPayloads).toEqual([]);
    // Retained, and left where it was. A disabled provider's envelope is no longer claimed, so it
    // never occupies a slot in the drain batch; what matters is that it survives, not which of the
    // two names it survives under.
    expect(existsSync(path)).toBe(true);

    const enabled = new HookIngress({
      adapters: [adapter],
      registry,
      tailer: { track() {} } as unknown as TranscriptTailer,
      spoolDir: dir,
      breakerFile: join(dir, 'hooks-off'),
      userHome: dir,
      log: createLogger('silent'),
    });
    enabled.drainSpool();
    expect(seenPayloads).toEqual([{ recovered: 'after-enable' }]);
    expect(existsSync(`${path}.processing`)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('drains an enabled provider while a full batch of disabled envelopes is queued', () => {
    const { dir, adapter, registry, seenPayloads } = fixture();
    const pending = join(dir, 'pending');
    mkdirSync(pending);
    // Already claimed by an earlier pass, which is the state that made this fatal: `.processing`
    // sorts ahead of everything, so a full batch of them was re-claimed and re-failed on every
    // pass while the enabled provider's envelope waited behind them and was never read at all.
    for (let i = 0; i < MAX_SPOOL_DRAIN_BATCH + 5; i++)
      writeFileSync(
        join(pending, `codex_1-${String(i).padStart(4, '0')}-x.ready.json.processing`),
        JSON.stringify({ disabled: i }),
      );
    writeFileSync(
      join(pending, 'claude-code_2-9999-x.ready.json'),
      JSON.stringify({ enabled: 'drained' }),
    );

    const hooks = new HookIngress({
      adapters: [adapter],
      registry,
      tailer: { track() {} } as unknown as TranscriptTailer,
      spoolDir: dir,
      breakerFile: join(dir, 'hooks-off'),
      userHome: dir,
      log: createLogger('silent'),
    });
    hooks.drainSpool();

    expect(seenPayloads).toEqual([{ enabled: 'drained' }]);
    expect(existsSync(join(pending, 'claude-code_2-9999-x.ready.json'))).toBe(false);
    expect(existsSync(join(pending, 'codex_1-0000-x.ready.json.processing'))).toBe(true);
  });

  /*
   * A relay that lost its provider to a failed fork named its envelopes `_<time>-<pid>-<random>`.
   * The drain read `_<time>` as the provider, found it disabled, and retained the envelope forever.
   * No configuration can enable a provider that is not a provider id, so these are quarantined:
   * kept unread and undeleted, each one counted as an observed gap without a guessed loss count.
   */
  it('quarantines an envelope whose name carries no provider instead of retaining it forever', () => {
    const { dir, hooks, seenPayloads } = fixture();
    const pending = join(dir, 'pending');
    mkdirSync(pending);
    const old = new Date('2026-09-09T19:15:30.000Z');
    const plant = (name: string, at: Date | undefined) => {
      writeFileSync(join(pending, name), JSON.stringify({ synthetic: name }));
      if (at) utimesSync(join(pending, name), at, at);
    };
    plant('_1788981330-49817-147de426.json', old);
    plant('_1788981410-77997-13ca39bc.ready.json', old);
    plant('_1788981852-8914-.json', old);
    // A plain envelope may still belong to a sender that is about to deliver or publish it.
    plant('_1790954716-15107-3aef6314.json', undefined);
    plant('claude-code_1790954716-11848-57f91d27.ready.json', undefined);

    hooks.drainSpool();

    expect(seenPayloads).toEqual([
      { synthetic: 'claude-code_1790954716-11848-57f91d27.ready.json' },
    ]);
    expect(readdirSync(pending).sort()).toEqual([
      '_1788981330-49817-147de426.json.unattributed',
      '_1788981410-77997-13ca39bc.ready.json.unattributed',
      '_1788981852-8914-.json.unattributed',
      '_1790954716-15107-3aef6314.json',
    ]);
    expect(
      JSON.parse(readFileSync(join(pending, '_1788981852-8914-.json.unattributed'), 'utf8')),
    ).toEqual({ synthetic: '_1788981852-8914-.json' });
    const ledger = join(dir, 'collection-gaps.json');
    const gap = {
      reason: 'hook-envelope-unattributed',
      provider: null,
      event: null,
      pressure: null,
      firstDroppedAt: old.toISOString(),
      exactCount: null,
    };
    expect(readCollectionGapLedger(ledger).episodes).toMatchObject([gap, gap, gap]);

    // Quarantine is the claim. Later passes neither retry the files nor count them again.
    hooks.drainSpool();
    expect(readCollectionGapLedger(ledger).episodes).toHaveLength(3);
    expect(seenPayloads).toHaveLength(1);
  });

  it('preserves processing and pending files when persistence is deferred', () => {
    const { dir, hooks } = fixture(() => false);
    const processing = join(dir, 'claude-code.20260816.jsonl.processing');
    writeFileSync(processing, `${JSON.stringify({ payload: { retry: 'daily' } })}\n`);
    const pendingDir = join(dir, 'pending');
    mkdirSync(pendingDir);
    const pending = join(pendingDir, 'claude-code-1-2-abcd.json');
    writeFileSync(pending, JSON.stringify({ retry: 'pending' }));
    const old = new Date(Date.now() - 20_000);
    utimesSync(pending, old, old);

    hooks.drainSpool();

    expect(existsSync(processing)).toBe(true);
    expect(existsSync(`${pending}.processing`)).toBe(true);
  });

  it('commits one transaction per session in a batch, not one per envelope', () => {
    const { dir, hooks, flushes } = fixture(() => true);
    const pendingDir = join(dir, 'pending');
    mkdirSync(pendingDir);
    for (let i = 0; i < 40; i++)
      writeFileSync(join(pendingDir, `claude-code_1-${i}-aa.ready.json`), JSON.stringify({ i }));

    hooks.drainSpool();

    expect(existsSync(join(pendingDir, 'claude-code_1-0-aa.ready.json'))).toBe(false);
    // Forty envelopes, one session. The old drain flushed inside every handle() call.
    expect(flushes()).toBe(1);
  });

  it('caps a drain pass and leaves the rest claimable by the next one', () => {
    const { dir, hooks, seenPayloads } = fixture(() => true);
    const pendingDir = join(dir, 'pending');
    mkdirSync(pendingDir);
    const total = MAX_SPOOL_DRAIN_BATCH + 25;
    for (let i = 0; i < total; i++)
      writeFileSync(join(pendingDir, `claude-code_2-${i}-bb.ready.json`), JSON.stringify({ i }));

    hooks.drainSpool();

    expect(seenPayloads.length).toBe(MAX_SPOOL_DRAIN_BATCH);
    expect(readdirSync(pendingDir)).toHaveLength(25);

    hooks.drainSpool();

    expect(seenPayloads.length).toBe(total);
    expect(readdirSync(pendingDir)).toHaveLength(0);
  });

  it('retains every envelope in a batch whose session did not reach the store', () => {
    const { dir, hooks } = fixture(() => false);
    const pendingDir = join(dir, 'pending');
    mkdirSync(pendingDir);
    for (let i = 0; i < 10; i++)
      writeFileSync(join(pendingDir, `claude-code_3-${i}-cc.ready.json`), JSON.stringify({ i }));

    hooks.drainSpool();

    // Batching must not widen the durability boundary: an undurable session keeps all ten copies.
    const kept = readdirSync(pendingDir);
    expect(kept).toHaveLength(10);
    expect(kept.every((f) => f.endsWith('.processing'))).toBe(true);
  });

  it('quarantines an oversized orphan without reading or repeatedly retrying it', () => {
    const { dir, hooks, seenPayloads } = fixture(() => true, { maxPayloadBytes: 64 });
    const pendingDir = join(dir, 'pending');
    mkdirSync(pendingDir);
    const pending = join(pendingDir, 'claude-code-1-2-large.json');
    const hostile = 'x'.repeat(65);
    writeFileSync(pending, hostile);
    const old = new Date(Date.now() - 20_000);
    utimesSync(pending, old, old);

    hooks.drainSpool();

    expect(seenPayloads).toEqual([]);
    expect(existsSync(pending)).toBe(false);
    expect(existsSync(`${pending}.processing.oversized`)).toBe(true);
    expect(readCollectionGapLedger(join(dir, 'collection-gaps.json')).episodes).toMatchObject([
      { reason: 'hook-payload-oversized', provider: 'claude-code', exactCount: null },
    ]);
  });

  it('streams past an oversized spool record and still recovers the next bounded payload', () => {
    const { dir, hooks, seenPayloads } = fixture(() => true, { maxSpoolRecordBytes: 128 });
    const processing = join(dir, 'claude-code.20260816.jsonl.processing');
    writeFileSync(
      processing,
      `${'x'.repeat(1024)}\n${JSON.stringify({ payload: { recovered: 'after oversized' } })}\n`,
    );

    hooks.drainSpool();

    expect(seenPayloads).toEqual([{ recovered: 'after oversized' }]);
    expect(existsSync(processing)).toBe(false);
    expect(readCollectionGapLedger(join(dir, 'collection-gaps.json')).episodes).toMatchObject([
      { reason: 'hook-spool-record-oversized', provider: 'claude-code', exactCount: null },
    ]);
  });

  it('reports the relay truncation marker as skipped instead of passing it to an adapter', () => {
    const { dir, hooks, seenPayloads } = fixture();
    expect(hooks.handle('claude-code', { [TRUNCATED_HOOK_PAYLOAD_KEY]: true })).toBe(0);
    expect(seenPayloads).toEqual([]);
    expect(readCollectionGapLedger(join(dir, 'collection-gaps.json')).episodes).toMatchObject([
      { reason: 'hook-payload-truncated', provider: 'claude-code', exactCount: null },
    ]);
  });
});
