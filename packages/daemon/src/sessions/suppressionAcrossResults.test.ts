import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalEvent } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DaemonHandle, startDaemon } from '../daemon.ts';
import { MAX_INGEST_PAYLOAD_BYTES } from '../ingest/limits.ts';

/**
 * A call can complete twice, and the structural suppression of credential dumps has to survive it.
 *
 * The hook channel and the provider's own record use distinct event ids so the store keeps both,
 * and a Codex command that outlived its call gets a late result when the polls come back. The
 * command a call ran was remembered only until its first completion, so whichever result landed
 * second was redacted with nothing to ask about, and a `printenv` was stored whole — then written
 * over the suppressed marker in the reduced state by the upgrade path, and served to the UI.
 */
const tmp = mkdtempSync(join(tmpdir(), 'salidium-suppress-'));
const SESSION = 'codex:suppress-test';
const SECRET = 'INTERNAL_THING=zzzsecretzzz\nPLAIN=value\n';
let daemon: DaemonHandle;

const base = {
  sessionId: SESSION,
  ts: '2026-08-18T00:00:00.000Z',
  tsSource: 'provider' as const,
  source: { provider: 'codex' as const, channel: 'transcript' as const },
};
const result = (exit: CanonicalEvent extends never ? never : object) => ({
  kind: 'command' as const,
  ...exit,
  outputExcerpt: SECRET,
  outputChars: SECRET.length,
  truncated: false,
});

beforeAll(async () => {
  daemon = await startDaemon({
    home: join(tmp, 'salidium'),
    userHome: join(tmp, 'home'),
    port: 0,
    providers: ['codex'],
    gitEnrichment: false,
    historyDays: 0,
    logLevel: 'silent',
  });
});

afterAll(async () => {
  await daemon.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('credential-dump suppression', () => {
  it('holds for a second result on the same call, and for the state it upgrades', () => {
    const c = daemon.registry.get(SESSION, { cwd: '/repo' });
    c.ingest([
      { ...base, id: `${SESSION}#session:start`, kind: 'session.started', cwd: '/repo' },
      {
        ...base,
        id: `${SESSION}#tool:c1:call`,
        kind: 'tool.called',
        callId: 'c1',
        toolName: 'exec',
        input: { kind: 'command', command: 'printenv' },
        title: 'Run: printenv',
      },
      {
        ...base,
        id: `${SESSION}#tool:c1:result`,
        kind: 'tool.completed',
        callId: 'c1',
        toolName: 'exec',
        result: result({ exit: { observation: 'unknown' } }),
        isError: false,
      },
      // The late result: a different id, so the store keeps both.
      {
        ...base,
        id: `${SESSION}#tool:c1:result:final`,
        kind: 'tool.completed',
        callId: 'c1',
        toolName: 'exec',
        result: result({ exit: { code: 0, observation: 'explicit' } }),
        isError: false,
      },
    ] as CanonicalEvent[]);
    c.flush();

    const completions = daemon.registry
      .eventsAfter(SESSION, -1, undefined, 100)
      .filter((e) => e.kind === 'tool.completed');
    expect(completions).toHaveLength(2);
    for (const e of completions) {
      const r = (e as { result: { kind: string; outputExcerpt: string } }).result;
      expect(r.outputExcerpt).toContain('contents suppressed');
      expect(r.outputExcerpt).not.toContain('zzzsecretzzz');
    }

    // The upgrade path writes the newer result into state; it must not undo the suppression.
    const activity = daemon.registry.snapshot(SESSION)?.state.activities.c1;
    const stateResult = activity?.result as { outputExcerpt?: string } | undefined;
    expect(stateResult?.outputExcerpt).not.toContain('zzzsecretzzz');
  });

  it('suppresses sensitive MCP results and raw records while preserving an ordinary read', async () => {
    const rawPath = join(tmp, 'provider-rollout.jsonl');
    const rawSecret = 'INTERNAL_THING=zzzsecretzzz';
    const rawLines = [
      JSON.stringify({ type: 'tool_call', arguments: { path: '/repo/.env' } }),
      JSON.stringify({ type: 'tool_result', content: rawSecret }),
      JSON.stringify({ type: 'tool_call', arguments: { path: '/repo/src/config.ts' } }),
      JSON.stringify({ type: 'tool_result', content: 'ordinary configuration' }),
    ];
    writeFileSync(rawPath, rawLines.join('\n'));
    const rawRef = (line: number) => ({
      path: rawPath,
      line,
      recordHash: `sha256:${createHash('sha256')
        .update(rawLines[line] ?? '')
        .digest('hex')}`,
    });
    const c = daemon.registry.get(SESSION, { cwd: '/repo' });
    const mcpEvents: CanonicalEvent[] = [
      {
        ...base,
        id: `${SESSION}#tool:m1:call`,
        source: { provider: 'codex', channel: 'rollout', ref: rawRef(0) },
        kind: 'tool.called',
        callId: 'm1',
        toolName: 'mcp__filesystem__read_file',
        input: {
          kind: 'mcp',
          server: 'filesystem',
          tool: 'read_file',
          argsExcerpt: JSON.stringify({ path: '/repo/.env' }),
        },
        title: 'Read file',
      },
      {
        ...base,
        id: `${SESSION}#tool:m1:result`,
        source: { provider: 'codex', channel: 'rollout', ref: rawRef(1) },
        kind: 'tool.completed',
        callId: 'm1',
        toolName: 'mcp__filesystem__read_file',
        result: { kind: 'generic', excerpt: rawSecret },
        isError: false,
      },
      {
        ...base,
        id: `${SESSION}#tool:m2:call`,
        source: { provider: 'codex', channel: 'rollout', ref: rawRef(2) },
        kind: 'tool.called',
        callId: 'm2',
        toolName: 'mcp__filesystem__read_file',
        input: {
          kind: 'mcp',
          server: 'filesystem',
          tool: 'read_file',
          argsExcerpt: JSON.stringify({ path: '/repo/src/config.ts' }),
        },
        title: 'Read file',
      },
      {
        ...base,
        id: `${SESSION}#tool:m2:result`,
        source: { provider: 'codex', channel: 'rollout', ref: rawRef(3) },
        kind: 'tool.completed',
        callId: 'm2',
        toolName: 'mcp__filesystem__read_file',
        result: { kind: 'generic', excerpt: 'ordinary configuration' },
        isError: false,
      },
    ];
    c.ingest(mcpEvents);
    c.flush();

    const stored = daemon.registry.eventsAfter(SESSION, -1, undefined, 100);
    const secretResult = stored.find((event) => event.id === `${SESSION}#tool:m1:result`);
    expect(secretResult).toMatchObject({
      kind: 'tool.completed',
      result: {
        kind: 'generic',
        excerpt: '[contents suppressed: sensitive file or credential dump]',
      },
    });
    expect(JSON.stringify(secretResult)).not.toContain('zzzsecretzzz');

    const raw = async (id: string) => {
      const response = await fetch(
        `http://127.0.0.1:${daemon.port}/api/sessions/${encodeURIComponent(SESSION)}/raw/${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${daemon.token}` } },
      );
      return (await response.json()) as { raw: unknown; reason?: string };
    };
    expect((await raw(`${SESSION}#tool:m1:call`)).raw).toBeNull();
    expect((await raw(`${SESSION}#tool:m1:result`)).raw).toBeNull();
    expect(await raw(`${SESSION}#tool:m2:result`)).toMatchObject({
      raw: { type: 'tool_result', content: 'ordinary configuration' },
    });
  });

  it('refuses to buffer an oversized provider record for raw drill-through', async () => {
    const rawPath = join(tmp, 'oversized-provider-record.jsonl');
    writeFileSync(rawPath, Buffer.alloc(MAX_INGEST_PAYLOAD_BYTES + 1, 0x78));
    const eventId = `${SESSION}#notification:oversized-source`;
    const c = daemon.registry.get(SESSION, { cwd: '/repo' });
    c.ingest([
      {
        ...base,
        id: eventId,
        source: { provider: 'codex', channel: 'rollout', ref: { path: rawPath, line: 0 } },
        kind: 'notification',
        message: 'provider emitted an oversized record',
      },
    ] as CanonicalEvent[]);
    c.flush();

    const response = await fetch(
      `http://127.0.0.1:${daemon.port}/api/sessions/${encodeURIComponent(SESSION)}/raw/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${daemon.token}` } },
    );
    expect(await response.json()).toMatchObject({
      raw: null,
      reason: `provider record exceeds ${MAX_INGEST_PAYLOAD_BYTES} bytes; raw suppressed`,
    });
  });

  it('does not serve a different record after the provider rewrites the recorded line', async () => {
    const rawPath = join(tmp, 'rewritten-provider-record.jsonl');
    const original = JSON.stringify({ uuid: 'original-record', content: 'original evidence' });
    writeFileSync(rawPath, `${original}\n`);
    const eventId = `${SESSION}#notification:rewritten-source`;
    const c = daemon.registry.get(SESSION, { cwd: '/repo' });
    c.ingest([
      {
        ...base,
        id: eventId,
        source: {
          provider: 'codex',
          channel: 'rollout',
          ref: {
            path: rawPath,
            line: 0,
            recordId: 'original-record',
            recordHash: `sha256:${createHash('sha256').update(original).digest('hex')}`,
          },
        },
        kind: 'notification',
        message: 'original evidence',
      },
    ] as CanonicalEvent[]);
    c.flush();

    const fetchRaw = async () => {
      const response = await fetch(
        `http://127.0.0.1:${daemon.port}/api/sessions/${encodeURIComponent(SESSION)}/raw/${encodeURIComponent(eventId)}`,
        { headers: { Authorization: `Bearer ${daemon.token}` } },
      );
      return (await response.json()) as { raw: unknown; reason?: string };
    };
    expect(await fetchRaw()).toMatchObject({
      raw: { uuid: 'original-record', content: 'original evidence' },
    });

    writeFileSync(
      rawPath,
      `${JSON.stringify({ uuid: 'replacement-record', content: 'unrelated replacement' })}\n`,
    );

    expect(await fetchRaw()).toMatchObject({
      raw: null,
      reason: 'provider record changed since ingestion',
    });
  });

  it('fails closed for legacy Codex rows until re-ingestion captures a raw fingerprint', async () => {
    const rawPath = join(tmp, 'legacy-unfingerprinted-rollout.jsonl');
    writeFileSync(rawPath, '{"content":"mutable current line"}\n');
    const eventId = `${SESSION}#notification:legacy-unfingerprinted`;
    const c = daemon.registry.get(SESSION, { cwd: '/repo' });
    c.ingest([
      {
        ...base,
        id: eventId,
        source: { provider: 'codex', channel: 'rollout', ref: { path: rawPath, line: 0 } },
        kind: 'notification',
        message: 'legacy evidence',
      },
    ] as CanonicalEvent[]);
    c.flush();

    const response = await fetch(
      `http://127.0.0.1:${daemon.port}/api/sessions/${encodeURIComponent(SESSION)}/raw/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${daemon.token}` } },
    );
    expect(await response.json()).toMatchObject({
      raw: null,
      reason: 'raw fingerprint unavailable; re-ingest this session to verify the provider line',
    });
  });
});
