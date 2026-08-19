import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ProviderAdapter } from '@salidium/adapter-kit';
import type { CanonicalEvent } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { writeRelayScript } from './daemon.ts';
import { HookIngress } from './ingest/hookIngress.ts';
import { MAX_INGEST_PAYLOAD_BYTES, TRUNCATED_HOOK_PAYLOAD_KEY } from './ingest/limits.ts';
import type { TranscriptTailer } from './ingest/transcriptTailer.ts';
import { createLogger } from './logging/logger.ts';
import type { SessionRegistry } from './sessions/sessionRegistry.ts';

describe('the installed hook relay', () => {
  it('safely spools and recovers a namespaced provider hook while the daemon is offline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-relay-namespaced-'));
    try {
      const home = join(root, 'state');
      const pendingDir = join(home, 'spool', 'pending');
      const relay = writeRelayScript(join(home, 'hooks'), home, {
        PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
      });
      const payload = { hook: 'offline extension delivery' };

      const result = spawnSync('/bin/sh', [relay, 'example/agent'], {
        env: {},
        encoding: 'utf8',
        input: JSON.stringify(payload),
      });
      expect(result.status).toBe(0);

      let ready: string | undefined;
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        ready = existsSync(pendingDir)
          ? readdirSync(pendingDir).find((name) => name.endsWith('.ready.json'))
          : undefined;
        if (!ready) await sleep(10);
      }
      expect(ready).toMatch(/^example~agent_.*\.ready\.json$/);
      expect(existsSync(join(pendingDir, 'example'))).toBe(false);

      const seen: unknown[] = [];
      const sessionId = 'example/agent:relay-offline';
      const adapter: ProviderAdapter = {
        id: 'example/agent',
        sessionRoots: () => [],
        matchSessionFile: () => undefined,
        createRecordParser: () => ({ parseRecord: () => [] }),
        parseHookPayload: (hookPayload): CanonicalEvent[] => {
          seen.push(hookPayload);
          return [
            {
              id: `${sessionId}#hook:1`,
              sessionId,
              ts: '2026-08-16T10:30:00.000Z',
              tsSource: 'ingest',
              source: { provider: 'example/agent', channel: 'hook' },
              kind: 'notification',
              message: 'done',
            },
          ];
        },
        transcriptPathFromHook: () => undefined,
      };
      const ingress = new HookIngress({
        adapters: [adapter],
        registry: { ingest: () => 1, flush: () => true } as unknown as SessionRegistry,
        tailer: { track() {} } as unknown as TranscriptTailer,
        spoolDir: join(home, 'spool'),
        userHome: root,
        log: createLogger('silent'),
      });

      ingress.drainSpool();

      expect(seen).toEqual([payload]);
      expect(readdirSync(pendingDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins a project-free PATH and spools the payload when HTTP delivery is not successful', () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-relay-'));
    try {
      const home = join(root, 'state');
      const hooks = join(home, 'hooks');
      const pendingDir = join(home, 'spool', 'pending');
      const pending = join(pendingDir, 'claude-code-test.json');
      const projectBin = join(root, 'project', 'node_modules', '.bin');
      const trustedBin = join(root, 'installed', 'bin');
      mkdirSync(projectBin, { recursive: true });
      mkdirSync(trustedBin, { recursive: true });
      mkdirSync(pendingDir, { recursive: true });
      // curl --fail returns non-zero for a non-2xx response. This stand-in exercises that branch.
      const curl = join(trustedBin, 'curl');
      writeFileSync(curl, '#!/bin/sh\nexit 22\n');
      chmodSync(curl, 0o700);
      writeFileSync(
        join(home, 'daemon.json'),
        JSON.stringify({ port: 1234, token: 'a'.repeat(64) }),
      );
      writeFileSync(pending, '{"hook_event_name":"Stop"}');

      const relay = writeRelayScript(hooks, home, {
        PATH: [projectBin, trustedBin, '/usr/bin', '/bin'].join(delimiter),
      });
      const script = readFileSync(relay, 'utf8');
      expect(script).not.toContain(projectBin);
      expect(script).toContain(trustedBin);
      expect(script).toContain('curl -fsS');
      expect(script).toContain(`head -c ${MAX_INGEST_PAYLOAD_BYTES + 1}`);

      const result = spawnSync('/bin/sh', [relay, '--send', 'claude-code', pending], {
        env: {},
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(existsSync(pending)).toBe(false);
      const spool = readdirSync(pendingDir).find((name) => name.endsWith('.ready.json'));
      expect(spool).toBe('claude-code-test.ready.json');
      expect(readFileSync(join(pendingDir, spool ?? ''), 'utf8')).toContain(
        '"hook_event_name":"Stop"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replaces an oversized pending payload with a bounded, explicit truncation marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-relay-limit-'));
    try {
      const home = join(root, 'state');
      const hooks = join(home, 'hooks');
      const pendingDir = join(home, 'spool', 'pending');
      const pending = join(pendingDir, 'claude-code-oversized.json');
      const trustedBin = join(root, 'installed', 'bin');
      mkdirSync(trustedBin, { recursive: true });
      mkdirSync(pendingDir, { recursive: true });
      const curl = join(trustedBin, 'curl');
      writeFileSync(curl, '#!/bin/sh\nexit 22\n');
      chmodSync(curl, 0o700);
      writeFileSync(
        join(home, 'daemon.json'),
        JSON.stringify({ port: 1234, token: 'a'.repeat(64) }),
      );
      writeFileSync(pending, Buffer.alloc(MAX_INGEST_PAYLOAD_BYTES + 1, 0x78));
      const relay = writeRelayScript(hooks, home, {
        PATH: [trustedBin, '/usr/bin', '/bin'].join(delimiter),
      });

      const result = spawnSync('/bin/sh', [relay, '--send', 'claude-code', pending], {
        env: {},
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(existsSync(pending)).toBe(false);
      const spool = readdirSync(pendingDir).find((name) => name.endsWith('.ready.json'));
      const content = readFileSync(join(pendingDir, spool ?? ''), 'utf8');
      expect(content.length).toBeLessThan(1024);
      expect(content).toContain(`"${TRUNCATED_HOOK_PAYLOAD_KEY}":true`);
      expect(content).not.toContain('x'.repeat(100));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes concurrent failures as intact envelopes while a drain is running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-relay-concurrent-'));
    try {
      const home = join(root, 'state');
      const hooksDir = join(home, 'hooks');
      const pendingDir = join(home, 'spool', 'pending');
      const trustedBin = join(root, 'installed', 'bin');
      mkdirSync(pendingDir, { recursive: true });
      mkdirSync(trustedBin, { recursive: true });
      const curl = join(trustedBin, 'curl');
      writeFileSync(curl, '#!/bin/sh\nexit 22\n');
      chmodSync(curl, 0o700);
      writeFileSync(
        join(home, 'daemon.json'),
        JSON.stringify({ port: 1234, token: 'a'.repeat(64) }),
      );
      const relay = writeRelayScript(hooksDir, home, {
        PATH: [trustedBin, '/usr/bin', '/bin'].join(delimiter),
      });

      const seen: number[] = [];
      const sessionId = 'claude-code:relay-concurrency';
      const adapter: ProviderAdapter = {
        id: 'claude-code',
        sessionRoots: () => [],
        matchSessionFile: () => undefined,
        createRecordParser: () => ({ parseRecord: () => [] }),
        parseHookPayload: (payload): CanonicalEvent[] => {
          seen.push((payload as { index: number }).index);
          return [
            {
              id: `${sessionId}#hook:${(payload as { index: number }).index}`,
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
      const ingress = new HookIngress({
        adapters: [adapter],
        registry: {
          ingest: () => 1,
          flush: () => true,
        } as unknown as SessionRegistry,
        tailer: { track() {} } as unknown as TranscriptTailer,
        spoolDir: join(home, 'spool'),
        userHome: root,
        log: createLogger('silent'),
      });

      const children = Array.from({ length: 48 }, (_, index) => {
        const file = join(pendingDir, `claude-code-${index}.json`);
        writeFileSync(file, JSON.stringify({ index, body: 'x'.repeat(8192) }));
        return new Promise<void>((resolve, reject) => {
          const child = spawn('/bin/sh', [relay, '--send', 'claude-code', file], { env: {} });
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
          );
        });
      });
      const drain = setInterval(() => ingress.drainSpool(), 1);
      await Promise.all(children);
      clearInterval(drain);
      ingress.drainSpool();

      expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 48 }, (_, i) => i));
      expect(readdirSync(pendingDir).filter((name) => name.includes('.ready.json'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
