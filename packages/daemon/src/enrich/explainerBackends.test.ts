import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeInvocation,
  buildCodexInvocation,
  chooseExplainerBackendId,
  configuredExplainerMode,
  DEFAULT_CODEX_EXPLAINER_MODEL,
  type ExplainerBackendRequest,
  effectiveExplainerMode,
  effectiveExplainerModel,
  MAX_EXPLAINER_PROCESSES,
  resolveExplainerBackend,
} from './explainerBackends.ts';

const request: ExplainerBackendRequest = {
  prompt: '[salidium-explainer] Explain this.',
  evidence: '{"ask":"Fix it"}',
  schema: { type: 'object' },
  timeoutMs: 60_000,
};

describe('explainer backend selection', () => {
  it('uses the source provider when both local CLIs are available', () => {
    const available = new Set(['claude', 'codex']);
    expect(chooseExplainerBackendId('claude-code', 'auto', available)).toBe('claude');
    expect(chooseExplainerBackendId('codex', 'auto', available)).toBe('codex');
  });

  it('falls back to the available local CLI in auto mode', () => {
    expect(chooseExplainerBackendId('claude-code', 'auto', new Set(['codex']))).toBe('codex');
    expect(chooseExplainerBackendId('codex', 'auto', new Set(['claude']))).toBe('claude');
  });

  it('does not substitute another provider when one is explicitly configured', () => {
    expect(chooseExplainerBackendId('codex', 'claude', new Set(['codex']))).toBeUndefined();
  });

  it('keeps the original opt-out and rejects unknown configuration', () => {
    expect(configuredExplainerMode({ SALIDIUM_EXPLAIN: '0' })).toBe('off');
    expect(configuredExplainerMode({ SALIDIUM_EXPLAINER: 'ollama' })).toBe('invalid');
  });

  it('uses stored helper and model choices unless the launch environment overrides them', () => {
    expect(effectiveExplainerMode('codex', {})).toBe('codex');
    expect(effectiveExplainerMode('codex', { SALIDIUM_EXPLAINER: 'claude' })).toBe('claude');
    expect(effectiveExplainerModel('gpt-5.6-luna', {})).toBe('gpt-5.6-luna');
    expect(effectiveExplainerModel('gpt-5.6-luna', { SALIDIUM_EXPLAIN_MODEL: 'gpt-5.6-sol' })).toBe(
      'gpt-5.6-sol',
    );
  });
});

describe('built-in backend invocations', () => {
  it('keeps the Claude CLI on the same bounded structured-output contract', () => {
    const invocation = buildClaudeInvocation(request, '/trusted/bin/claude');
    expect(invocation.command).toBe('/trusted/bin/claude');
    expect(invocation.args).toContain('--json-schema');
    expect(invocation.args).toContain('--safe-mode');
    expect(invocation.args).toContain('--no-session-persistence');
    expect(invocation.args).toContain('--tools');
    expect(invocation.args[invocation.args.indexOf('--tools') + 1]).toBe('');
    expect(invocation.args.join(' ')).not.toContain(request.prompt);
    expect(invocation.args.join(' ')).not.toContain(request.evidence);
    expect(invocation.input).toContain(request.prompt);
    expect(invocation.input).toContain(request.evidence);
  });

  it('executes the same trusted absolute command that provider detection resolved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-explainer-command-'));
    const command = join(root, 'claude');
    const previousHome = process.env.SALIDIUM_HOME;
    try {
      writeFileSync(command, '#!/bin/sh\ncat >/dev/null\nprintf %s "$0"\n');
      chmodSync(command, 0o700);
      process.env.SALIDIUM_HOME = join(root, 'state');
      const backend = resolveExplainerBackend('claude-code', {
        PATH: root,
        SALIDIUM_EXPLAINER: 'claude',
      });
      expect(backend).toBeDefined();
      await expect(backend?.generate(request)).resolves.toMatchObject({
        output: realpathSync(command),
      });
    } finally {
      if (previousHome === undefined) delete process.env.SALIDIUM_HOME;
      else process.env.SALIDIUM_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('kills a provider process when the explanation is canceled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-explainer-abort-'));
    const command = join(root, 'claude');
    const previousHome = process.env.SALIDIUM_HOME;
    try {
      writeFileSync(command, '#!/bin/sh\nexec /bin/sleep 30\n');
      chmodSync(command, 0o700);
      process.env.SALIDIUM_HOME = join(root, 'state');
      const backend = resolveExplainerBackend('claude-code', {
        PATH: root,
        SALIDIUM_EXPLAINER: 'claude',
      });
      expect(backend).toBeDefined();
      const controller = new AbortController();
      const startedAt = Date.now();
      const pending = backend?.generate({ ...request, signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toThrow('explainer canceled');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      if (previousHome === undefined) delete process.env.SALIDIUM_HOME;
      else process.env.SALIDIUM_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never starts more than two explainer processes globally', async () => {
    expect(MAX_EXPLAINER_PROCESSES).toBe(2);
    const root = mkdtempSync(join(tmpdir(), 'salidium-explainer-cap-'));
    const command = join(root, 'claude');
    const previousHome = process.env.SALIDIUM_HOME;
    try {
      writeFileSync(command, '#!/bin/sh\nexec /bin/sleep 30\n');
      chmodSync(command, 0o700);
      process.env.SALIDIUM_HOME = join(root, 'state');
      const backend = resolveExplainerBackend('claude-code', {
        PATH: root,
        SALIDIUM_EXPLAINER: 'claude',
      });
      expect(backend).toBeDefined();
      const controllers = [new AbortController(), new AbortController()];
      const running = controllers.map((controller) =>
        backend?.generate({ ...request, signal: controller.signal }),
      );
      await expect(backend?.generate(request)).rejects.toThrow('explainer process limit reached');
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(running);
    } finally {
      if (previousHome === undefined) delete process.env.SALIDIUM_HOME;
      else process.env.SALIDIUM_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases process capacity when local helper setup fails before spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'salidium-explainer-setup-'));
    const command = join(root, 'claude');
    const blockedHome = join(root, 'blocked-home');
    const previousHome = process.env.SALIDIUM_HOME;
    try {
      writeFileSync(command, '#!/bin/sh\ncat >/dev/null\nprintf ok\n');
      chmodSync(command, 0o700);
      writeFileSync(blockedHome, 'not a directory');
      process.env.SALIDIUM_HOME = blockedHome;
      const backend = resolveExplainerBackend('claude-code', {
        PATH: root,
        SALIDIUM_EXPLAINER: 'claude',
      });
      expect(backend).toBeDefined();
      await expect(backend?.generate(request)).rejects.toThrow();
      await expect(backend?.generate(request)).rejects.toThrow();

      process.env.SALIDIUM_HOME = join(root, 'state');
      await expect(backend?.generate(request)).resolves.toMatchObject({ output: 'ok' });
    } finally {
      if (previousHome === undefined) delete process.env.SALIDIUM_HOME;
      else process.env.SALIDIUM_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs Codex ephemerally and tool-free, and reads the prompt from stdin', () => {
    const invocation = buildCodexInvocation(
      request,
      '/tmp/explanation-schema.json',
      '/trusted/bin/codex',
    );
    expect(invocation.command).toBe('/trusted/bin/codex');
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        'exec',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '-c',
        'tools.web_search=false',
        'tools.view_image=false',
        '--disable',
        'shell_tool',
        'unified_exec',
        'hooks',
        'apps',
        'plugins',
        'multi_agent',
        'multi_agent_v2',
        'browser_use',
        'computer_use',
        'image_generation',
        'code_mode_host',
        'workspace_dependencies',
        '--output-schema',
      ]),
    );
    expect(invocation.args.filter((arg) => arg === '--disable').length).toBeGreaterThan(10);
    expect(invocation.args.at(-1)).toBe('-');
    expect(invocation.input).toContain(request.evidence);
    expect(invocation.model).toBe(DEFAULT_CODEX_EXPLAINER_MODEL);
  });
});
