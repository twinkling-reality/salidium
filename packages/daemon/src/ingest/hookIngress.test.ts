import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter } from '@salidium/adapter-kit';
import type { CanonicalEvent } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logging/logger.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { HookIngress } from './hookIngress.ts';
import { TRUNCATED_HOOK_PAYLOAD_KEY } from './limits.ts';
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
    userHome: dir,
    log: createLogger('silent'),
    ...limits,
  });
  return { dir, hooks, seenPayloads, receivedTimes, flushes: () => flushes };
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
  });

  it('reports the relay truncation marker as skipped instead of passing it to an adapter', () => {
    const { hooks, seenPayloads } = fixture();
    expect(hooks.handle('claude-code', { [TRUNCATED_HOOK_PAYLOAD_KEY]: true })).toBe(0);
    expect(seenPayloads).toEqual([]);
  });
});
