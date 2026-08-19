import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IntegrationContext } from './integrations.ts';
import { ProviderIntegrationRegistry, providerIntegrations } from './integrations.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-integrations-'));
  temporaryDirectories.push(path);
  return path;
}

function executable(path: string): void {
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o700);
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('provider integration boundaries', () => {
  it('rejects duplicate setup descriptors', () => {
    const integration = providerIntegrations[0];
    expect(integration).toBeDefined();
    if (!integration) return;
    const registry = new ProviderIntegrationRegistry([integration]);
    expect(() => registry.register(integration)).toThrow(/already registered/);
  });

  it('ignores project package bins while detecting an absolute installed provider command', () => {
    const root = temporaryDirectory();
    const projectBin = join(root, 'project', 'node_modules', '.bin');
    const installedBin = join(root, 'installed', 'bin');
    mkdirSync(projectBin, { recursive: true });
    mkdirSync(installedBin, { recursive: true });
    executable(join(projectBin, 'claude'));
    executable(join(installedBin, 'claude'));
    const claude = providerIntegrations.find((provider) => provider.id === 'claude-code');
    expect(claude).toBeDefined();

    const context: IntegrationContext = {
      userHome: join(root, 'home'),
      salidiumHome: join(root, 'state'),
      env: { PATH: projectBin },
    };
    expect(claude?.detect(context)).toEqual({
      detected: false,
      commandFound: false,
      stateFound: false,
    });
    context.env = { PATH: [projectBin, installedBin].join(delimiter) };
    expect(claude?.detect(context)).toEqual({
      detected: true,
      commandFound: true,
      stateFound: false,
    });
  });

  it('reports native Windows as history-only instead of a broken live-hook setup', () => {
    const root = temporaryDirectory();
    const codexHome = join(root, '.codex');
    mkdirSync(codexHome, { recursive: true });
    const codex = providerIntegrations.find((provider) => provider.id === 'codex');
    const context: IntegrationContext = {
      userHome: root,
      salidiumHome: join(root, '.salidium'),
      env: { PATH: '', CODEX_HOME: codexHome },
      platform: 'win32',
    };

    expect(codex?.detect(context).detected).toBe(true);
    expect(codex?.liveHooksSupported(context)).toBe(false);
    expect(codex?.validate(context)).toEqual([
      expect.objectContaining({ level: 'info', message: expect.stringMatching(/history-only/) }),
    ]);
    expect(() => codex?.install(context)).toThrow(/history only|history-only/);
  });
});
