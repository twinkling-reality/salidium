import type { CanonicalEvent } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { redactEvent } from './redactEvent.ts';
import { createRedactor } from './redactText.ts';
import { isSensitiveMcpFileRead } from './sensitivePaths.ts';

describe('generated explanation redaction', () => {
  it('redacts every model-written string before the event is persisted or broadcast', () => {
    const secret = `sk-ant-api03-${'x'.repeat(93)}AA`;
    const event: CanonicalEvent = {
      kind: 'salidium.explanation',
      id: 'claude-code:test#explanation:1',
      sessionId: 'claude-code:test',
      provider: 'claude-code',
      ts: '2026-08-18T00:00:00.000Z',
      tsSource: 'ingest',
      source: { provider: 'claude-code', channel: 'salidium' },
      basedOnSeq: 1,
      model: secret,
      what: { summary: secret, currently: secret },
      why: {
        summary: secret,
        lanes: [{ title: secret, steps: [secret] }],
        chain: [secret],
      },
      how: { summary: secret, root: secret, steps: [secret] },
      approachChange: {
        from: secret,
        fromSteps: [secret, secret],
        why: secret,
        to: secret,
        toSteps: [secret, secret],
      },
    };

    const redacted = redactEvent(event, createRedactor());
    expect(redacted.findings).toBeGreaterThan(0);
    expect(JSON.stringify(redacted.event)).not.toContain(secret);
    expect(JSON.stringify(redacted.event)).toContain('[ANTHROPIC_KEY#');
  });
});

describe('MCP file-read suppression', () => {
  const completed: CanonicalEvent = {
    id: 'claude-code:test#result:mcp-1',
    sessionId: 'claude-code:test',
    provider: 'claude-code',
    ts: '2026-08-18T00:00:00.000Z',
    tsSource: 'provider',
    source: { provider: 'claude-code', channel: 'transcript' },
    kind: 'tool.completed',
    callId: 'mcp-1',
    toolName: 'mcp__filesystem__read_file',
    result: { kind: 'generic', excerpt: 'INTERNAL_THING=zzzsecretzzz' },
    isError: false,
  };

  it('suppresses arbitrary names and values returned by a sensitive MCP file read', () => {
    const input = {
      kind: 'mcp' as const,
      server: 'filesystem',
      tool: 'read_file',
      argsExcerpt: JSON.stringify({ path: '/repo/.env.production' }),
    };

    expect(isSensitiveMcpFileRead(input)).toBe(true);
    const redacted = redactEvent(completed, createRedactor(), { inputForCall: () => input });
    expect(redacted.event).toMatchObject({
      kind: 'tool.completed',
      result: {
        kind: 'generic',
        excerpt: '[contents suppressed: sensitive file or credential dump]',
      },
    });
    expect(JSON.stringify(redacted.event)).not.toContain('zzzsecretzzz');
  });

  it('recognizes nested, multiple and clipped path arguments without suppressing ordinary MCPs', () => {
    expect(
      isSensitiveMcpFileRead({
        kind: 'mcp',
        server: 'filesystem',
        tool: 'readMultipleFiles',
        argsExcerpt: JSON.stringify({
          request: { paths: ['/repo/src/a.ts', 'C:\\Users\\me\\.ssh\\id_rsa'] },
        }),
      }),
    ).toBe(true);
    expect(
      isSensitiveMcpFileRead({
        kind: 'mcp',
        server: 'filesystem',
        tool: 'read_file',
        argsExcerpt: '{"path":"/repo/.env","other":',
      }),
    ).toBe(true);

    const input = {
      kind: 'mcp' as const,
      server: 'filesystem',
      tool: 'read_file',
      argsExcerpt: JSON.stringify({ path: '/repo/src/config.ts' }),
    };
    const preserved = redactEvent(completed, createRedactor(), { inputForCall: () => input });
    expect(preserved.event).toMatchObject({
      kind: 'tool.completed',
      result: { kind: 'generic', excerpt: 'INTERNAL_THING=zzzsecretzzz' },
    });
    expect(
      isSensitiveMcpFileRead({
        kind: 'mcp',
        server: 'database',
        tool: 'query',
        argsExcerpt: JSON.stringify({ path: '/repo/.env', sql: 'select 1' }),
      }),
    ).toBe(false);
  });

  it('uses pre-truncation path metadata when the sensitive argument is absent from the excerpt', () => {
    const input = {
      kind: 'mcp' as const,
      server: 'filesystem',
      tool: 'read_file',
      pathArgs: ['/repo/.env.production'],
      argsExcerpt: JSON.stringify({ padding: 'x'.repeat(300) }).slice(0, 300),
    };

    expect(input.argsExcerpt).not.toContain('.env');
    expect(isSensitiveMcpFileRead(input)).toBe(true);
    const redacted = redactEvent(completed, createRedactor(), { inputForCall: () => input });
    expect(redacted.event).toMatchObject({
      kind: 'tool.completed',
      result: {
        kind: 'generic',
        excerpt: '[contents suppressed: sensitive file or credential dump]',
      },
    });
  });

  it('suppresses an over-bound path list rather than trusting omitted metadata', () => {
    expect(
      isSensitiveMcpFileRead({
        kind: 'mcp',
        server: 'filesystem',
        tool: 'read_multiple_files',
        pathArgs: Array.from({ length: 32 }, (_, index) => `/repo/src/file-${index}.ts`),
        pathArgsTruncated: true,
        argsExcerpt: '{"paths":["/repo/src/file-0.ts"',
      }),
    ).toBe(true);
  });
});

describe('command credential-output suppression', () => {
  it('suppresses arbitrary values from a named printenv lookup', () => {
    const secret = 'Q7v9pL2xN8cR4mT6bY1wK5dF3sH0jZ';
    const completed: CanonicalEvent = {
      id: 'codex:test#result:env-1',
      sessionId: 'codex:test',
      provider: 'codex',
      ts: '2026-08-18T00:00:00.000Z',
      tsSource: 'provider',
      source: { provider: 'codex', channel: 'transcript' },
      kind: 'tool.completed',
      callId: 'env-1',
      toolName: 'exec_command',
      result: {
        kind: 'command',
        exit: { observation: 'explicit', code: 0 },
        outputExcerpt: secret,
        outputChars: secret.length,
        truncated: false,
      },
      isError: false,
    };

    const redacted = redactEvent(completed, createRedactor(), {
      commandForCall: () => 'printenv CUSTOM_TOKEN',
    });
    expect(JSON.stringify(redacted.event)).not.toContain(secret);
    expect(redacted.event).toMatchObject({
      result: { outputExcerpt: '[contents suppressed: sensitive file or credential dump]' },
    });
  });
});
