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
import {
  HOOK_SHED_FIRST_FILE,
  HOOK_SHED_RETAIN_FILE,
  HOOK_SHED_SECOND_FILE,
  MAX_HOOK_ABSOLUTE_PENDING_FILES,
  MAX_HOOK_PENDING_FILES,
  MAX_HOOK_SHED_FIRST_PENDING_FILES,
  MAX_HOOK_SHED_SECOND_PENDING_FILES,
  MAX_INGEST_PAYLOAD_BYTES,
  TRUNCATED_HOOK_PAYLOAD_KEY,
} from './ingest/limits.ts';
import type { TranscriptTailer } from './ingest/transcriptTailer.ts';
import { createLogger } from './logging/logger.ts';
import type { SessionRegistry } from './sessions/sessionRegistry.ts';

describe('the installed hook relay', () => {
  it('honours pause before reading stdin or starting a sender', () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-relay-pause-'));
    try {
      const home = join(root, 'state');
      const relay = writeRelayScript(join(home, 'hooks'), home);
      writeFileSync(join(home, 'hooks-paused'), '{"reason":"manual"}\n');
      const result = spawnSync('/bin/sh', [relay, 'claude-code', 'Stop', 'lifecycle'], {
        input: '{"hook_event_name":"Stop"}',
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(existsSync(join(home, 'spool', 'pending'))).toBe(false);
      const source = readFileSync(relay, 'utf8');
      expect(source.indexOf('[ -e "$HOME_DIR/hooks-paused" ]')).toBeGreaterThan(0);
      expect(source.indexOf('[ -e "$HOME_DIR/hooks-paused" ]')).toBeLessThan(
        source.indexOf('head -c'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
        breakerFile: join(home, 'hooks-off'),
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
        breakerFile: join(home, 'hooks-off'),
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

      expect(readdirSync(pendingDir)).toEqual([]);
      expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 48 }, (_, i) => i));
      expect(readdirSync(pendingDir).filter((name) => name.includes('.ready.json'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent quota checks so ready envelopes cannot overrun the hard ceiling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-relay-quota-'));
    try {
      const home = join(root, 'state');
      const pendingDir = join(home, 'spool', 'pending');
      const relay = writeRelayScript(join(home, 'hooks'), home, { PATH: '/bin:/usr/bin' });
      mkdirSync(pendingDir, { recursive: true });
      for (let index = 0; index < MAX_HOOK_PENDING_FILES - 1; index++)
        writeFileSync(join(pendingDir, `claude-code-seed-${index}.ready.json`), '{}');

      const senders = Array.from({ length: 48 }, (_, index) => {
        const file = join(pendingDir, `claude-code-race-${index}.json`);
        writeFileSync(file, JSON.stringify({ index }));
        return new Promise<void>((resolve, reject) => {
          const child = spawn(
            '/bin/sh',
            [relay, '--send', 'claude-code', 'Notification', 'retain', file],
            { env: {} },
          );
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
          );
        });
      });
      await Promise.all(senders);

      const entries = readdirSync(pendingDir);
      expect(entries.filter((name) => name.endsWith('.ready.json'))).toHaveLength(
        MAX_HOOK_PENDING_FILES,
      );
      expect(entries.some((name) => name === '.quota-lock')).toBe(false);
      expect(existsSync(join(home, HOOK_SHED_RETAIN_FILE))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not reclaim a replacement lock after the observed owner exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-relay-replaced-lock-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const home = join(root, 'state');
      const pending = join(home, 'spool', 'pending');
      mkdirSync(pending, { recursive: true });
      const relay = writeRelayScript(join(home, 'hooks'), home, { PATH: '/bin:/usr/bin' });
      const lock = join(pending, '.quota-lock');
      const deadOwner = spawnSync('/bin/sh', ['-c', 'exit 0']).pid;
      writeFileSync(lock, `${deadOwner}\n`);
      const input = join(pending, 'claude-code-replacement.json');
      writeFileSync(input, '{}');
      // Pause after reading the owner, then resume only after a new live owner has
      // replaced the lock. These barriers expose the race without relying on timing.
      const generated = readFileSync(relay, 'utf8');
      const barrier = 'if ! kill -0 "$LOCK_OWNER" 2>/dev/null; then';
      expect(generated).toContain(barrier);
      writeFileSync(
        relay,
        generated
          .replace(
            barrier,
            `: > "$HOME_DIR/observed"\nwhile [ ! -e "$HOME_DIR/continue" ]; do sleep 0.01; done\n${barrier}`,
          )
          .replace(
            '[ "$QUOTA_ATTEMPTS" -lt 5000 ]',
            ': > "$HOME_DIR/examined"\n    [ "$QUOTA_ATTEMPTS" -lt 5000 ]',
          ),
      );
      child = spawn('/bin/sh', [relay, '--send', 'claude-code', input], { env: {} });
      const exited = new Promise((resolve) => child?.once('exit', resolve));
      const waitFor = async (name: string) => {
        for (let i = 0; i < 300 && !existsSync(join(home, name)); i++) await sleep(10);
        expect(existsSync(join(home, name))).toBe(true);
      };
      await waitFor('observed');
      writeFileSync(lock, `${process.pid}\n`);
      writeFileSync(join(home, 'continue'), '');
      await waitFor('examined');
      expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`);
      expect(existsSync(input.replace('.json', '.ready.json'))).toBe(false);
      rmSync(lock);
      expect(await exited).toBe(0);
      expect(existsSync(input.replace('.json', '.ready.json'))).toBe(true);
    } finally {
      child?.kill('SIGTERM');
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The regression that matters most, and the cheapest one to state: an earlier relay measured the
   * offline spool by running `wc -c` on every file in it, which made one hook's cost proportional
   * to the queue depth it was joining. Nothing about the delivered payload was wrong, so no
   * behavioural test caught it. This one reads the generated text instead.
   */
  it('measures the offline spool without spawning a process per pending file', () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-relay-cost-'));
    try {
      const home = join(root, 'state');
      const script = readFileSync(
        writeRelayScript(join(home, 'hooks'), home, { PATH: '/bin' }),
        'utf8',
      );
      const sendBranch = script.slice(script.indexOf('if [ "$1" = "--send" ]'));

      const loopOverPending = /\bfor\b[^\n]*\$(?:\{)?PENDING/.test(sendBranch);
      expect(loopOverPending).toBe(false);
      expect(sendBranch).not.toMatch(/wc -c < "\$ITEM"/);
      expect(sendBranch).toContain('set -- "$PENDING"/*.ready.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits without reading stdin while the breaker is tripped', () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-relay-breaker-'));
    try {
      const home = join(root, 'state');
      const pendingDir = join(home, 'spool', 'pending');
      const relay = writeRelayScript(join(home, 'hooks'), home, { PATH: '/bin:/usr/bin' });
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'hooks-off'), '{"reason":"pending-files"}\n');

      const result = spawnSync('/bin/sh', [relay, 'claude-code'], {
        env: {},
        encoding: 'utf8',
        input: JSON.stringify({ hook: 'dropped while tripped' }),
      });

      expect(result.status).toBe(0);
      expect(existsSync(pendingDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sheds tool observations in order while preserving lifecycle capacity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-relay-ceiling-'));
    try {
      const home = join(root, 'state');
      const pendingDir = join(home, 'spool', 'pending');
      const relay = writeRelayScript(join(home, 'hooks'), home, { PATH: '/bin:/usr/bin' });
      mkdirSync(pendingDir, { recursive: true });
      for (let i = 0; i < MAX_HOOK_SHED_FIRST_PENDING_FILES; i++)
        writeFileSync(join(pendingDir, `claude-code-${i}.ready.json`), '{}');

      const pre = join(pendingDir, 'claude-code-pre.json');
      writeFileSync(pre, JSON.stringify({ hook_event_name: 'PreToolUse' }));
      const preResult = spawnSync(
        '/bin/sh',
        [relay, '--send', 'claude-code', 'PreToolUse', 'shed-first', pre],
        { env: {}, encoding: 'utf8' },
      );
      expect(preResult.status).toBe(0);
      expect(existsSync(pre)).toBe(false);
      expect(JSON.parse(readFileSync(join(home, HOOK_SHED_FIRST_FILE), 'utf8'))).toMatchObject({
        event: 'PreToolUse',
        exactCount: null,
      });

      for (let i = MAX_HOOK_SHED_FIRST_PENDING_FILES; i < MAX_HOOK_SHED_SECOND_PENDING_FILES; i++)
        writeFileSync(join(pendingDir, `claude-code-${i}.ready.json`), '{}');
      const post = join(pendingDir, 'claude-code-post.json');
      writeFileSync(post, JSON.stringify({ hook_event_name: 'PostToolUse' }));
      const postResult = spawnSync(
        '/bin/sh',
        [relay, '--send', 'claude-code', 'PostToolUse', 'shed-second', post],
        { env: {}, encoding: 'utf8' },
      );
      expect(postResult.status).toBe(0);
      expect(existsSync(post)).toBe(false);
      expect(JSON.parse(readFileSync(join(home, HOOK_SHED_SECOND_FILE), 'utf8'))).toMatchObject({
        event: 'PostToolUse',
        exactCount: null,
      });

      for (let i = MAX_HOOK_SHED_SECOND_PENDING_FILES; i < MAX_HOOK_PENDING_FILES; i++)
        writeFileSync(join(pendingDir, `claude-code-${i}.ready.json`), '{}');
      const ordinary = join(pendingDir, 'claude-code-ordinary.json');
      writeFileSync(ordinary, JSON.stringify({ hook_event_name: 'Notification' }));
      const ordinaryResult = spawnSync(
        '/bin/sh',
        [relay, '--send', 'claude-code', 'Notification', 'retain', ordinary],
        { env: {}, encoding: 'utf8' },
      );
      expect(ordinaryResult.status).toBe(0);
      expect(existsSync(ordinary)).toBe(false);
      expect(JSON.parse(readFileSync(join(home, HOOK_SHED_RETAIN_FILE), 'utf8'))).toMatchObject({
        reason: 'ordinary-capacity-full',
        exactCount: null,
      });

      const lifecycle = join(pendingDir, 'claude-code-lifecycle.json');
      writeFileSync(lifecycle, JSON.stringify({ hook_event_name: 'Stop' }));
      const lifecycleResult = spawnSync(
        '/bin/sh',
        [relay, '--send', 'claude-code', 'Stop', 'lifecycle', lifecycle],
        { env: {}, encoding: 'utf8' },
      );
      expect(lifecycleResult.status).toBe(0);
      expect(existsSync(lifecycle)).toBe(false);
      expect(existsSync(join(pendingDir, 'claude-code-lifecycle.ready.json'))).toBe(true);

      for (let i = MAX_HOOK_PENDING_FILES + 1; i < MAX_HOOK_ABSOLUTE_PENDING_FILES; i++)
        writeFileSync(join(pendingDir, `claude-code-${i}.ready.json`), '{}');
      const terminal = join(pendingDir, 'claude-code-terminal.json');
      writeFileSync(terminal, JSON.stringify({ hook_event_name: 'SessionEnd' }));
      const terminalResult = spawnSync(
        '/bin/sh',
        [relay, '--send', 'claude-code', 'SessionEnd', 'lifecycle', terminal],
        { env: {}, encoding: 'utf8' },
      );

      expect(terminalResult.status).toBe(0);
      expect(existsSync(terminal)).toBe(false);
      expect(readdirSync(pendingDir)).toHaveLength(MAX_HOOK_ABSOLUTE_PENDING_FILES);
      const breaker = JSON.parse(readFileSync(join(home, 'hooks-off'), 'utf8'));
      expect(breaker).toMatchObject({
        reason: 'lifecycle-reserve-full',
        event: 'SessionEnd',
        exactCount: null,
      });

      const result = spawnSync('/bin/sh', [relay, 'claude-code', 'SessionEnd', 'lifecycle'], {
        env: {},
        encoding: 'utf8',
        input: JSON.stringify({ hook_event_name: 'SessionEnd' }),
      });
      expect(result.status).toBe(0);
      expect(readdirSync(pendingDir)).toHaveLength(MAX_HOOK_ABSOLUTE_PENDING_FILES);

      // The hard breaker stays until ordinary capacity is available again.
      const ingress = new HookIngress({
        adapters: [],
        registry: { ingest: () => 1, flush: () => true } as unknown as SessionRegistry,
        tailer: { track() {} } as unknown as TranscriptTailer,
        spoolDir: join(home, 'spool'),
        breakerFile: join(home, 'hooks-off'),
        userHome: root,
        log: createLogger('silent'),
      });
      ingress.drainSpool();
      expect(existsSync(join(home, 'hooks-off'))).toBe(true);
      rmSync(pendingDir, { recursive: true, force: true });
      mkdirSync(pendingDir);
      ingress.drainSpool();
      expect(existsSync(join(home, 'hooks-off'))).toBe(false);
      expect(existsSync(join(home, HOOK_SHED_RETAIN_FILE))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
