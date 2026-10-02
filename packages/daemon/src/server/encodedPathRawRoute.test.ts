import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapToolInput, mapToolResult } from '@salidium/adapter-claude-code';
import { mapCodexToolInput } from '@salidium/adapter-codex';
import type { CanonicalEvent, ToolInput, ToolResult } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DaemonHandle, startDaemon } from '../daemon.ts';

/**
 * A sensitive file named in another spelling (a percent-encoded `file:` URI, a different case, a
 * trailing dot, doubled separators, a `.` or `..` segment) is suppressed in the stored event and
 * refused by the raw view, for each file-backed provider, while an ordinary read stays visible.
 * The inputs come from each provider's own mapping; the raw records sit in a provider-style file.
 */
const tmp = mkdtempSync(join(tmpdir(), 'salidium-encoded-path-'));
const SECRET = 'SYNTHETIC_SECRET=not-real';
let daemon: DaemonHandle;

beforeAll(async () => {
  daemon = await startDaemon({
    home: join(tmp, 'salidium'),
    userHome: join(tmp, 'home'),
    port: 0,
    providers: ['claude-code', 'codex'],
    gitEnrichment: false,
    historyDays: 0,
    logLevel: 'silent',
  });
});

afterAll(async () => {
  await daemon.stop();
  rmSync(tmp, { recursive: true, force: true });
});

type Provider = 'claude-code' | 'codex';

/** A provider's file read and MCP read, mapped the way its parser maps them. */
const mappings: Record<
  Provider,
  {
    read: (path: string) => { toolName: string; input: ToolInput; result: ToolResult };
    mcp: (args: Record<string, unknown>) => ToolInput;
  }
> = {
  'claude-code': {
    read: (path) => ({
      toolName: 'Read',
      input: mapToolInput('Read', { file_path: path }).input,
      result: mapToolResult('Read', { file_path: path }, undefined, SECRET).result,
    }),
    mcp: (args) => mapToolInput('mcp__filesystem__read_file', args).input,
  },
  codex: {
    // Codex's own file read is `view_image`; its result is the image, so it completes generic.
    read: (path) => ({
      toolName: 'view_image',
      input: mapCodexToolInput('view_image', { path }).input,
      result: { kind: 'generic', excerpt: SECRET },
    }),
    mcp: (args) => mapCodexToolInput('mcp__filesystem__read_file', args).input,
  },
};

const SENSITIVE = [
  '/repo/%2Eenv',
  'file:///repo/.%65nv',
  'file://localhost/repo/%2Eenv.production',
  '/repo/.ENV',
  '/repo//./.env.',
  '/repo/src/../.ssh/id_rsa',
  '/Users/me/.SSH/ID_ED25519',
  'file:///Users/me/%2Eaws/credentials',
  'file:///repo/%E0%A4%A',
];

let counter = 0;

/** Ingests one call and its result, each citing a line of a provider file holding the secret. */
function ingest(
  provider: Provider,
  toolName: string,
  input: ToolInput,
  result: ToolResult | { failed: string },
): { session: string; call: string; done: string } {
  const n = counter++;
  const session = `${provider}:encoded-${n}`;
  const rawPath = join(tmp, `${provider}-${n}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'tool_call', name: toolName, input }),
    JSON.stringify({ type: 'tool_result', content: SECRET }),
  ];
  writeFileSync(rawPath, lines.join('\n'));
  const ref = (line: number) => ({
    path: rawPath,
    line,
    recordHash: `sha256:${createHash('sha256')
      .update(lines[line] ?? '')
      .digest('hex')}`,
  });
  const base = {
    sessionId: session,
    ts: '2026-10-02T00:00:00.000Z',
    tsSource: 'provider' as const,
  };
  const channel = provider === 'codex' ? ('rollout' as const) : ('transcript' as const);
  const call = `${session}#tool:c1:call`;
  const done = `${session}#tool:c1:result`;
  const c = daemon.registry.get(session, { cwd: '/repo' });
  c.ingest([
    {
      ...base,
      id: call,
      source: { provider, channel, ref: ref(0) },
      kind: 'tool.called',
      callId: 'c1',
      toolName,
      input,
      title: toolName,
    },
    'failed' in result
      ? {
          ...base,
          id: done,
          source: { provider, channel, ref: ref(1) },
          kind: 'tool.failed',
          callId: 'c1',
          toolName,
          errorExcerpt: result.failed,
          cause: 'error',
        }
      : {
          ...base,
          id: done,
          source: { provider, channel, ref: ref(1) },
          kind: 'tool.completed',
          callId: 'c1',
          toolName,
          result,
          isError: false,
        },
  ] as CanonicalEvent[]);
  c.flush();
  return { session, call, done };
}

async function raw(session: string, id: string): Promise<{ raw: unknown; reason?: string }> {
  const response = await fetch(
    `http://127.0.0.1:${daemon.port}/api/sessions/${encodeURIComponent(session)}/raw/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${daemon.token}` } },
  );
  return (await response.json()) as { raw: unknown; reason?: string };
}

function stored(session: string, id: string): CanonicalEvent | undefined {
  return daemon.registry.eventsAfter(session, -1, undefined, 100).find((e) => e.id === id);
}

async function expectSuppressed(ids: { session: string; call: string; done: string }) {
  expect(JSON.stringify(stored(ids.session, ids.done))).not.toContain(SECRET);
  for (const id of [ids.call, ids.done]) {
    const answer = await raw(ids.session, id);
    expect(answer.raw).toBeNull();
    expect(answer.reason).toMatch(/^suppressed/);
  }
}

describe.each(['claude-code', 'codex'] as const)('encoded sensitive paths (%s)', (provider) => {
  const map = mappings[provider];

  it.each(SENSITIVE)('suppresses a file read of %s and its raw records', async (path) => {
    const { toolName, input, result } = map.read(path);
    const ids = ingest(provider, toolName, input, result);
    await expectSuppressed(ids);
    if (provider === 'claude-code')
      expect(stored(ids.session, ids.done)).toMatchObject({
        result: { kind: 'fileRead', suppressed: true },
      });
  });

  it.each(SENSITIVE)('suppresses an MCP read of %s and its raw records', async (path) => {
    const input = map.mcp({ uri: path });
    const ids = ingest(provider, 'mcp__filesystem__read_file', input, {
      kind: 'generic',
      excerpt: SECRET,
    });
    await expectSuppressed(ids);
  });

  it('suppresses a move out of an encoded sensitive path and its raw records', async () => {
    const ids = ingest(
      provider,
      'apply_patch',
      { kind: 'fileEdit', path: '/repo/notes.txt' },
      {
        kind: 'fileChanges',
        changes: [
          {
            path: '/repo/notes.txt',
            movedFrom: 'file:///repo/%2Eenv',
            change: 'move',
            hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [`+${SECRET}`] }],
            linesAdded: 1,
            linesRemoved: 0,
            applied: true,
          },
        ],
      },
    );
    expect(JSON.stringify(stored(ids.session, ids.done))).not.toContain(SECRET);
    const answer = await raw(ids.session, ids.done);
    expect(answer.raw).toBeNull();
  });

  it.each(['/repo/.ENV', 'file:///repo/%2Enpmrc', '/repo//./.env.'])(
    'refuses the raw record of a write to %s',
    async (path) => {
      const ids = ingest(
        provider,
        'Write',
        { kind: 'fileWrite', path },
        { kind: 'generic', excerpt: 'written' },
      );
      expect((await raw(ids.session, ids.call)).raw).toBeNull();
    },
  );

  it('suppresses a failed dump of an encoded sensitive file and its raw records', async () => {
    const command = "cat $'\\x2eenv'; exit 1";
    const input =
      provider === 'codex'
        ? mapCodexToolInput('exec_command', { cmd: command }).input
        : mapToolInput('Bash', { command }).input;
    const ids = ingest(provider, 'Bash', input, { failed: `Exit code 1\n${SECRET}` });
    await expectSuppressed(ids);
  });

  it('keeps an ordinary encoded read and its raw records', async () => {
    const input = map.mcp({ uri: 'file:///repo/src/%63onfig.ts' });
    const ids = ingest(provider, 'mcp__filesystem__read_file', input, {
      kind: 'generic',
      excerpt: 'ordinary configuration',
    });
    expect(JSON.stringify(stored(ids.session, ids.done))).toContain('ordinary configuration');
    const answer = await raw(ids.session, ids.done);
    expect(answer.raw).toMatchObject({ type: 'tool_result' });
  });
});

describe('a search inside an encoded sensitive file (claude-code)', () => {
  it.each(['/repo/.ENV', 'file:///repo/%2Eenv', '/Users/me/.ssh//id_rsa.'])(
    'suppresses a Grep of %s and its raw records',
    async (path) => {
      const args = { pattern: '.', path, output_mode: 'content' };
      const { input } = mapToolInput('Grep', args);
      const { result } = mapToolResult('Grep', args, undefined, SECRET);
      await expectSuppressed(ingest('claude-code', 'Grep', input, result));
    },
  );
});
