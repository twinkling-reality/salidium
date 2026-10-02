import { createRedactor, redactEvent } from '@salidium/core';
import type { CanonicalEvent, ToolInput, ToolResult } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { mapToolInput, mapToolResult } from './toolMapping.ts';

describe('MCP path metadata', () => {
  it('captures a sensitive path before the display excerpt is truncated', () => {
    const mapped = mapToolInput('mcp__filesystem__read_file', {
      padding: 'x'.repeat(400),
      path: '/repo/.env.production',
    });

    expect(mapped.input).toMatchObject({
      kind: 'mcp',
      pathArgs: ['/repo/.env.production'],
    });
    if (mapped.input.kind !== 'mcp') throw new Error('expected MCP input');
    expect(mapped.input.argsExcerpt).not.toContain('.env.production');
  });
});

describe('encoded sensitive paths', () => {
  const base = {
    id: 'claude-code:test#result:1',
    sessionId: 'claude-code:test',
    provider: 'claude-code',
    ts: '2026-10-02T00:00:00.000Z',
    tsSource: 'provider',
    source: { provider: 'claude-code', channel: 'transcript' },
    kind: 'tool.completed',
    callId: 'c1',
    isError: false,
  } as const;
  const stored = (toolName: string, result: ToolResult, input: ToolInput) =>
    redactEvent({ ...base, toolName, result } as CanonicalEvent, createRedactor(), {
      inputForCall: () => input,
    }).event;

  it.each([
    '/repo/.ENV',
    '/repo//./.env.',
    '/repo/src/../.ssh/id_rsa',
    '/Users/me/.SSH/ID_ED25519',
    '/repo/%2Eenv',
    'file:///repo/.%65nv',
  ])('suppresses a Read of %s', (path) => {
    const { input } = mapToolInput('Read', { file_path: path });
    const { result } = mapToolResult('Read', { file_path: path }, undefined, 'SECRET=1');
    expect(stored('Read', result, input)).toMatchObject({
      result: { kind: 'fileRead', suppressed: true },
    });
  });

  it.each([
    { uri: 'file:///repo/%2Eenv' },
    { path: 'file://localhost/repo/.%65nv.local' },
    { paths: ['/repo/a.ts', 'file:///Users/me/%2Essh/id_rsa'] },
    { uri: '/repo/%ZZ/secrets' },
    { url: 'file:///repo/%E0%A4%A' },
  ])('suppresses an MCP read of %j', (args) => {
    const { input } = mapToolInput('mcp__filesystem__read_file', args);
    const event = stored(
      'mcp__filesystem__read_file',
      { kind: 'generic', excerpt: 'SECRET=1' },
      input,
    );
    expect(JSON.stringify(event)).not.toContain('SECRET=1');
  });

  it.each(['/repo/docs/100%.md', '/repo/%ZZ/readme.md'])(
    'reads a literal percent in the native path %s and keeps it',
    (path) => {
      const mcp = mapToolInput('mcp__filesystem__read_file', { path }).input;
      expect(mcp.kind === 'mcp' && mcp.pathArgsUndecodable).toBeFalsy();
      const kept = stored('mcp__filesystem__read_file', { kind: 'generic', excerpt: 'plain' }, mcp);
      expect(kept).toMatchObject({ result: { kind: 'generic', excerpt: 'plain' } });
      const { input } = mapToolInput('Read', { file_path: path });
      const { result } = mapToolResult('Read', { file_path: path }, undefined, '');
      expect(stored('Read', result, input)).not.toMatchObject({ result: { suppressed: true } });
    },
  );

  it('keeps an ordinary encoded read', () => {
    const args = { uri: 'file:///repo/src/%63onfig.ts' };
    const { input } = mapToolInput('mcp__filesystem__read_file', args);
    const event = stored(
      'mcp__filesystem__read_file',
      { kind: 'generic', excerpt: 'plain' },
      input,
    );
    expect(event).toMatchObject({ result: { kind: 'generic', excerpt: 'plain' } });
  });
});
