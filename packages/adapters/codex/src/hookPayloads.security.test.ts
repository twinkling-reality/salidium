import { createRedactor, redactEvent } from '@salidium/core';
import { type CanonicalEvent, makeSessionId, type ToolInput } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from './codexAdapter.ts';
import { mapCodexToolInput } from './hookPayloads.ts';

describe('MCP path metadata', () => {
  it('captures a sensitive path before the display excerpt is truncated', () => {
    const mapped = mapCodexToolInput('mcp__filesystem__read_file', {
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
  const threadId = '01a00b4a-d527-75c2-bb45-db3d42e77300';
  const sessionId = makeSessionId('codex', threadId);

  /** One rollout call and its output, parsed and then stored as the daemon stores them. */
  function storedCall(name: string, args: unknown, output: string): CanonicalEvent[] {
    const at = (s: number) => new Date(Date.parse('2026-10-02T00:00:00.000Z') + s * 1000);
    const lines = [
      {
        timestamp: at(0).toISOString(),
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: at(0).toISOString(),
          cwd: '/repo',
          cli_version: '0.148.0',
        },
      },
      {
        timestamp: at(1).toISOString(),
        type: 'response_item',
        payload: {
          type: 'function_call',
          name,
          arguments: JSON.stringify(args),
          call_id: 'call_1',
        },
      },
      {
        timestamp: at(2).toISOString(),
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_1', output },
      },
    ].map((line) => JSON.stringify(line));
    const parser = codexAdapter.createRecordParser({
      sessionId,
      providerSessionId: threadId,
      path: '/tmp/rollout.jsonl',
      observedAt: at(3).toISOString(),
    });
    const events = lines.flatMap((line, i) => parser.parseRecord(line, i));
    const inputs = new Map<string, ToolInput>();
    for (const e of events) if (e.kind === 'tool.called') inputs.set(e.callId, e.input);
    const redactor = createRedactor();
    return events.map(
      (e) =>
        redactEvent(e, redactor, {
          inputForCall: (id) => inputs.get(id),
          commandForCall: (id) => {
            const input = inputs.get(id);
            return input?.kind === 'command' ? input.command : undefined;
          },
        }).event,
    );
  }

  it.each([
    { uri: 'file:///repo/%2Eenv' },
    { path: 'file://localhost/repo/.%65nv.production' },
    { path: '/Users/me/.SSH/ID_RSA.' },
    { paths: ['/repo/a.ts', '/repo//./%2Enpmrc'] },
  ])('suppresses a rollout MCP read of %j', (args) => {
    const events = storedCall('mcp__filesystem__read_file', args, 'SYNTHETIC_SECRET=not-real');
    expect(events.some((e) => e.kind === 'tool.completed')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('SYNTHETIC_SECRET');
  });

  it.each(['cat .ENV', 'cat ./.env.', 'head -n 5 ~/.AWS//credentials'])(
    'suppresses the output of %s',
    (cmd) => {
      const events = storedCall(
        'exec_command',
        { cmd, workdir: '/repo' },
        'Process exited with code 0\nOutput:\nSYNTHETIC_SECRET=not-real',
      );
      expect(events.some((e) => e.kind === 'tool.completed')).toBe(true);
      expect(JSON.stringify(events)).not.toContain('SYNTHETIC_SECRET');
    },
  );

  it('keeps an ordinary encoded MCP read', () => {
    const events = storedCall(
      'mcp__filesystem__read_file',
      { uri: 'file:///repo/src/%63onfig.ts' },
      'ordinary configuration',
    );
    expect(JSON.stringify(events)).toContain('ordinary configuration');
  });

  it('carries an encoded path through the hook mapping', () => {
    const mapped = mapCodexToolInput('mcp__filesystem__read_file', {
      padding: 'x'.repeat(400),
      uri: 'file:///repo/%2Eenv',
    });
    expect(mapped.input).toMatchObject({ kind: 'mcp', pathArgs: ['file:///repo/%2Eenv'] });
    const result: CanonicalEvent = {
      id: `${sessionId}#tool:h1:result`,
      sessionId,
      provider: 'codex',
      ts: '2026-10-02T00:00:00.000Z',
      tsSource: 'provider',
      source: { provider: 'codex', channel: 'hook' },
      kind: 'tool.completed',
      callId: 'h1',
      toolName: 'mcp__filesystem__read_file',
      result: { kind: 'generic', excerpt: 'SYNTHETIC_SECRET=not-real' },
      isError: false,
    };
    const stored = redactEvent(result, createRedactor(), { inputForCall: () => mapped.input });
    expect(JSON.stringify(stored.event)).not.toContain('SYNTHETIC_SECRET');
  });
});
