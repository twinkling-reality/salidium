import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectHooks,
  installClaudeCodeHooks,
  installCodexHooks,
  relayCommand,
  writeJsonWithBackup,
} from './hookInstaller.ts';

const temporaryDirectories: string[] = [];

function temporaryHome(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-hooks-'));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('provider hook configuration', () => {
  it('merges idempotently, preserves unrelated Claude settings, and removes only Salidium hooks', () => {
    const userHome = temporaryHome();
    const salidiumHome = join(userHome, 'salidium-state');
    const claudeDirectory = join(userHome, '.claude');
    const settingsPath = join(claudeDirectory, 'settings.json');
    mkdirSync(claudeDirectory, { recursive: true });
    const original = {
      model: 'custom-model',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            label: 'keep me',
            hooks: [{ type: 'command', command: 'other-tool check', timeout: 30 }],
          },
        ],
      },
    };
    writeFileSync(settingsPath, `${JSON.stringify(original, null, 2)}\n`);

    const installed = installClaudeCodeHooks(userHome, salidiumHome);
    expect(installed.changed).toBe(true);
    expect(inspectHooks('claude-code', userHome, salidiumHome).status).toBe('configured');
    expect(existsSync(join(salidiumHome, 'hooks', 'relay.sh'))).toBe(true);
    const merged = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof original;
    expect(merged.model).toBe('custom-model');
    expect(merged.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    expect(JSON.parse(readFileSync(`${settingsPath}.salidium-backup`, 'utf8'))).toEqual(original);

    const afterFirstInstall = readFileSync(settingsPath, 'utf8');
    expect(installClaudeCodeHooks(userHome, salidiumHome).changed).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe(afterFirstInstall);

    const removed = installClaudeCodeHooks(userHome, salidiumHome, true);
    expect(removed.changed).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(original);
  });

  it('recognizes partial Codex configuration and repairs it without duplicating hooks', () => {
    const userHome = temporaryHome();
    const salidiumHome = join(userHome, '.salidium-test');
    const codexDirectory = join(userHome, '.codex');
    const hooksPath = join(codexDirectory, 'hooks.json');
    mkdirSync(codexDirectory, { recursive: true });

    installCodexHooks(userHome, salidiumHome);
    const configured = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    const removedEvent = Object.keys(configured.hooks)[0];
    expect(removedEvent).toBeTruthy();
    if (removedEvent) delete configured.hooks[removedEvent];
    writeFileSync(hooksPath, `${JSON.stringify(configured, null, 2)}\n`);

    const partial = inspectHooks('codex', userHome, salidiumHome);
    expect(partial.status).toBe('partial');
    expect(partial.missingEvents).toContain(removedEvent);
    expect(installCodexHooks(userHome, salidiumHome).changed).toBe(true);
    expect(inspectHooks('codex', userHome, salidiumHome).status).toBe('configured');
    expect(installCodexHooks(userHome, salidiumHome).changed).toBe(false);
  });

  it('refuses to overwrite malformed provider hook structures', () => {
    const userHome = temporaryHome();
    const salidiumHome = join(userHome, '.salidium');
    const claudeDirectory = join(userHome, '.claude');
    const settingsPath = join(claudeDirectory, 'settings.json');
    mkdirSync(claudeDirectory, { recursive: true });
    const malformed = '{\n  "hooks": { "PreToolUse": "not-an-array" }\n}\n';
    writeFileSync(settingsPath, malformed);

    const inspection = inspectHooks('claude-code', userHome, salidiumHome);
    expect(inspection.status).toBe('invalid');
    expect(() => installClaudeCodeHooks(userHome, salidiumHome)).toThrow(/non-array/);
    expect(readFileSync(settingsPath, 'utf8')).toBe(malformed);
    expect(existsSync(`${settingsPath}.salidium-backup`)).toBe(false);
  });

  it('keeps the original provider JSON when the atomic replacement fails', () => {
    const userHome = temporaryHome();
    const directory = join(userHome, '.claude');
    const settingsPath = join(directory, 'settings.json');
    mkdirSync(directory, { recursive: true });
    const original = '{\n  "model": "keep-me"\n}\n';
    writeFileSync(settingsPath, original, { mode: 0o600 });

    expect(() =>
      writeJsonWithBackup(settingsPath, { model: 'replacement' }, () => {
        throw new Error('injected replace failure');
      }),
    ).toThrow(/injected replace failure/);

    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
    expect(readFileSync(`${settingsPath}.salidium-backup`, 'utf8')).toBe(original);
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('creates a new provider settings file with private permissions', () => {
    const userHome = temporaryHome();
    const settingsPath = join(userHome, '.codex', 'hooks.json');
    writeJsonWithBackup(settingsPath, { hooks: {} });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ hooks: {} });
    if (process.platform !== 'win32') expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['missing', (path: string) => rmSync(path)],
    ['stale', (path: string) => writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 })],
    ['non-executable', (path: string) => chmodSync(path, 0o600)],
  ] as const)('repairs a %s relay even when provider JSON is already current', (_name, damage) => {
    const userHome = temporaryHome();
    const salidiumHome = join(userHome, '.salidium');
    const relay = join(salidiumHome, 'hooks', 'relay.sh');
    const settings = join(userHome, '.claude', 'settings.json');
    installClaudeCodeHooks(userHome, salidiumHome);
    const settingsBefore = readFileSync(settings, 'utf8');

    damage(relay);
    const damaged = inspectHooks('claude-code', userHome, salidiumHome);
    expect(damaged.status).toBe('partial');
    expect(damaged.issue).toMatch(/relay script/);

    const repaired = installClaudeCodeHooks(userHome, salidiumHome);
    expect(repaired.changed).toBe(true);
    expect(inspectHooks('claude-code', userHome, salidiumHome).status).toBe('configured');
    expect(readFileSync(settings, 'utf8')).toBe(settingsBefore);
    expect(readFileSync(relay, 'utf8')).toContain('Salidium hook relay');
    expect(statSync(relay).mode & 0o111).not.toBe(0);
  });

  it('refuses POSIX relay installation on native Windows without touching settings', () => {
    const userHome = temporaryHome();
    const salidiumHome = join(userHome, '.salidium');
    expect(() => installCodexHooks(userHome, salidiumHome, false, { PATH: '' }, 'win32')).toThrow(
      /history only|history-only/,
    );
    expect(existsSync(join(userHome, '.codex', 'hooks.json'))).toBe(false);
    expect(existsSync(join(salidiumHome, 'hooks', 'relay.sh'))).toBe(false);
  });

  it('invokes the absolute relay without resolving sh from the caller PATH', () => {
    const userHome = temporaryHome();
    const salidiumHome = join(userHome, '.salidium');
    const attackerBin = join(userHome, 'project', 'node_modules', '.bin');
    const marker = join(userHome, 'path-sh-was-run');
    mkdirSync(attackerBin, { recursive: true });
    const fakeSh = join(attackerBin, 'sh');
    writeFileSync(fakeSh, `#!/bin/sh\nprintf intercepted > '${marker}'\nexit 77\n`, {
      mode: 0o700,
    });
    installClaudeCodeHooks(userHome, salidiumHome, false, { PATH: '/usr/bin:/bin' });

    const result = spawnSync('/bin/sh', ['-c', relayCommand(salidiumHome, 'claude-code')], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, PATH: attackerBin },
    });

    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
