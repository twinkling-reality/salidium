import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IntegrationContext, ProviderIntegration } from './integrations.ts';
import { runFirstRunOnboarding } from './onboarding.ts';

const temporaryDirectories: string[] = [];

function contextFor(...providers: Array<'claude-code' | 'codex'>): IntegrationContext {
  const userHome = mkdtempSync(join(tmpdir(), 'salidium-onboarding-'));
  temporaryDirectories.push(userHome);
  if (providers.includes('claude-code')) mkdirSync(join(userHome, '.claude'), { recursive: true });
  if (providers.includes('codex')) mkdirSync(join(userHome, '.codex'), { recursive: true });
  return {
    userHome,
    salidiumHome: join(userHome, '.salidium'),
    env: { PATH: '' },
  };
}

function outputHarness(interactive = true, answer = true) {
  let output = '';
  let prompts = 0;
  return {
    io: {
      interactive,
      async confirm() {
        prompts++;
        return answer;
      },
      write(text: string) {
        output += text;
      },
    },
    output: () => output,
    prompts: () => prompts,
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('first-run onboarding', () => {
  it('asks once for both providers, configures them, validates them, and stays quiet on repeat', async () => {
    const context = contextFor('claude-code', 'codex');
    const first = outputHarness();
    const result = await runFirstRunOnboarding(context, first.io, { firstRun: true });

    expect(first.prompts()).toBe(1);
    expect(result.consent).toBe('approved');
    expect(result.changed.map((change) => change.provider)).toEqual(['claude-code', 'codex']);
    /*
     * Nothing needs attention. Not "every validation is ok": Codex also carries a standing `info`
     * caveat, because a hook it has not been shown is configured on disk and inert in the agent,
     * and that is a fact about a healthy install rather than a problem with one.
     */
    expect(result.validations.some((validation) => validation.level === 'attention')).toBe(false);
    expect(
      result.validations.some(
        (validation) =>
          validation.level === 'info' && /open \/hooks in Codex/.test(validation.message),
      ),
    ).toBe(true);
    expect(first.output()).toMatch(/Detected: Claude Code, Codex/);
    expect(first.output()).toMatch(/Permission requested/);
    expect(first.output()).toMatch(/Codex requires one more action/);
    expect(existsSync(join(context.userHome, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(context.userHome, '.codex', 'hooks.json'))).toBe(true);

    const repeat = outputHarness();
    const repeated = await runFirstRunOnboarding(context, repeat.io);
    expect(repeat.prompts()).toBe(0);
    expect(repeated.consent).toBe('not-needed');
    expect(repeated.changed).toEqual([]);
    expect(repeat.output()).toBe('');
  });

  it.each([
    ['Claude Code', 'claude-code', '.claude/settings.json'],
    ['Codex', 'codex', '.codex/hooks.json'],
  ] as const)('configures a detected %s-only setup', async (name, provider, relativePath) => {
    const context = contextFor(provider);
    const harness = outputHarness();
    const result = await runFirstRunOnboarding(context, harness.io, { firstRun: true });

    expect(result.detected.map((integration) => integration.name)).toEqual([name]);
    expect(result.changed).toHaveLength(1);
    expect(existsSync(join(context.userHome, relativePath))).toBe(true);
  });

  it('handles no detected providers without prompting or writing provider configuration', async () => {
    const context = contextFor();
    const harness = outputHarness();
    const result = await runFirstRunOnboarding(context, harness.io, { firstRun: true });

    expect(result.detected).toEqual([]);
    expect(harness.prompts()).toBe(0);
    expect(harness.output()).toMatch(/no supported coding agents/);
    expect(existsSync(join(context.userHome, '.claude'))).toBe(false);
    expect(existsSync(join(context.userHome, '.codex'))).toBe(false);
  });

  it('preserves consent when the user declines', async () => {
    const context = contextFor('claude-code');
    const harness = outputHarness(true, false);
    const result = await runFirstRunOnboarding(context, harness.io, { firstRun: true });

    expect(result.consent).toBe('declined');
    expect(result.changed).toEqual([]);
    expect(existsSync(join(context.userHome, '.claude', 'settings.json'))).toBe(false);
    expect(harness.output()).toMatch(/No provider settings changed/);
    expect(result.validations.some((validation) => validation.level === 'attention')).toBe(true);
  });

  it('never prompts in a non-interactive terminal and supports explicit automation consent', async () => {
    const context = contextFor('codex');
    const skipped = outputHarness(false);
    const first = await runFirstRunOnboarding(context, skipped.io, { firstRun: true });
    expect(first.consent).toBe('non-interactive');
    expect(skipped.prompts()).toBe(0);
    expect(existsSync(join(context.userHome, '.codex', 'hooks.json'))).toBe(false);
    expect(skipped.output()).toMatch(/Re-run with --yes/);

    const automated = outputHarness(false);
    const second = await runFirstRunOnboarding(context, automated.io, {
      assumeYes: true,
    });
    expect(second.consent).toBe('approved');
    expect(automated.prompts()).toBe(0);
    expect(readFileSync(join(context.userHome, '.codex', 'hooks.json'), 'utf8')).toMatch(
      /SALIDIUM_HOOK=1/,
    );
  });

  it('uses native Windows providers in history-only mode without prompting or writing POSIX hooks', async () => {
    const context = { ...contextFor('claude-code', 'codex'), platform: 'win32' as const };
    const harness = outputHarness(false);
    const result = await runFirstRunOnboarding(context, harness.io, {
      assumeYes: true,
      firstRun: true,
    });

    expect(result.detected.map((provider) => provider.id)).toEqual(['claude-code', 'codex']);
    expect(result.consent).toBe('not-needed');
    expect(result.changed).toEqual([]);
    expect(result.validations.every((validation) => validation.level === 'info')).toBe(true);
    expect(harness.prompts()).toBe(0);
    expect(harness.output()).toMatch(/History-only on native Windows/);
    expect(harness.output()).toMatch(/POSIX live hooks are not installed/);
    expect(existsSync(join(context.userHome, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(context.userHome, '.codex', 'hooks.json'))).toBe(false);
  });

  it('prompts only for the unconfigured provider in a mixed setup', async () => {
    const context = contextFor('claude-code', 'codex');
    const first = outputHarness(false);
    await runFirstRunOnboarding(context, first.io, { assumeYes: true });
    rmSync(join(context.userHome, '.codex', 'hooks.json'));

    const recovery = outputHarness();
    const result = await runFirstRunOnboarding(context, recovery.io);
    expect(recovery.prompts()).toBe(1);
    expect(result.changed.map((change) => change.provider)).toEqual(['codex']);
    expect(recovery.output()).toMatch(/Already connected: Claude Code/);
  });

  it('reports a provider write failure without aborting first run', async () => {
    const context = contextFor();
    const harness = outputHarness(false);
    const failingProvider: ProviderIntegration = {
      id: 'codex',
      name: 'Codex',
      stateDirectory: () => join(context.userHome, '.codex'),
      historyDirectories: () => [],
      liveHooksSupported: () => true,
      detect: () => ({ detected: true, commandFound: true, stateFound: false }),
      inspect: () => ({
        provider: 'codex',
        settingsPath: join(context.userHome, '.codex', 'hooks.json'),
        status: 'not-configured',
        events: ['SessionStart'],
        missingEvents: ['SessionStart'],
      }),
      install: () => {
        throw new Error('settings file is read-only');
      },
      remove: () => {
        throw new Error('not used');
      },
      validate: () => [{ level: 'attention', message: 'Codex is not connected' }],
      guidance: () => [],
    };

    const result = await runFirstRunOnboarding(context, harness.io, {
      assumeYes: true,
      integrations: [failingProvider],
    });
    expect(result.changed).toEqual([]);
    expect(harness.output()).toMatch(/could not be connected: settings file is read-only/);
    expect(harness.output()).toMatch(/Codex is not connected/);
  });
});
