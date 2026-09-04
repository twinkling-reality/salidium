import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  buildClaudeCodeHooks,
  isSalidiumHook as isClaudeSalidiumHook,
} from '@salidium/adapter-claude-code';
import { buildCodexHooks, isSalidiumHook as isCodexSalidiumHook } from '@salidium/adapter-codex';

export type BuiltInHookProvider = 'claude-code' | 'codex';
export type HookConfigurationStatus = 'configured' | 'not-configured' | 'partial' | 'invalid';

interface HookGroup {
  matcher?: string;
  hooks: unknown[];
}

export interface HookConfigurationInspection {
  provider: BuiltInHookProvider;
  settingsPath: string;
  status: HookConfigurationStatus;
  events: string[];
  missingEvents: string[];
  issue?: string;
}

export function inspectBuiltInHooks(
  provider: BuiltInHookProvider,
  userHome: string,
  salidiumHome: string,
  env: NodeJS.ProcessEnv = process.env,
): HookConfigurationInspection {
  const path = hookSettingsPath(provider, userHome, env);
  const desired = desiredHooks(provider, salidiumHome);
  const events = Object.keys(desired);
  try {
    const existing = readHookMap(readJson(path), path);
    const isOurs = hookPredicate(provider);
    const ownedEvents = new Set<string>();
    const missingEvents: string[] = [];
    for (const [event, groups] of Object.entries(existing)) {
      if (groups.some((group) => group.hooks.some(isOurs))) ownedEvents.add(event);
    }
    for (const event of new Set([...Object.keys(existing), ...events])) {
      const current = (existing[event] ?? []).flatMap((group) => group.hooks.filter(isOurs));
      const wanted = (desired[event] ?? []).flatMap((group) => group.hooks);
      if (!isDeepStrictEqual(current, wanted)) missingEvents.push(event);
    }
    const status: HookConfigurationStatus =
      missingEvents.length === 0
        ? 'configured'
        : ownedEvents.size > 0
          ? 'partial'
          : 'not-configured';
    return { provider, settingsPath: path, status, events, missingEvents };
  } catch (error) {
    return {
      provider,
      settingsPath: path,
      status: 'invalid',
      events,
      missingEvents: events,
      issue: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Removes only Salidium-owned hook specs and preserves every unrelated group and setting. */
export function disconnectBuiltInHooks(
  provider: BuiltInHookProvider,
  userHome: string,
  env: NodeJS.ProcessEnv = process.env,
): { changed: boolean; settingsPath: string } {
  const path = hookSettingsPath(provider, userHome, env);
  const file = readJson(path);
  const existing = readHookMap(file, path);
  const isOurs = hookPredicate(provider);
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(existing)) {
    const kept = groups
      .map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !isOurs(hook)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  if (isDeepStrictEqual(existing, hooks)) return { changed: false, settingsPath: path };
  writeJsonWithBackup(path, { ...file, hooks });
  return { changed: true, settingsPath: path };
}

function desiredHooks(
  provider: BuiltInHookProvider,
  salidiumHome: string,
): Record<string, HookGroup[]> {
  const script = join(salidiumHome, 'hooks', 'relay.sh');
  if (/\r|\n/.test(script)) throw new Error('Salidium home path must not contain newlines');
  const command = `SALIDIUM_HOOK=1 '${script.replace(/'/g, `'\\''`)}' ${provider}`;
  return provider === 'claude-code'
    ? buildClaudeCodeHooks(command)
    : buildCodexHooks(command).hooks;
}

function hookSettingsPath(
  provider: BuiltInHookProvider,
  userHome: string,
  env: NodeJS.ProcessEnv,
): string {
  return provider === 'claude-code'
    ? join(env.CLAUDE_CONFIG_DIR ?? join(userHome, '.claude'), 'settings.json')
    : join(env.CODEX_HOME ?? join(userHome, '.codex'), 'hooks.json');
}

function hookPredicate(provider: BuiltInHookProvider): (spec: unknown) => boolean {
  return provider === 'claude-code' ? isClaudeSalidiumHook : isCodexSalidiumHook;
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path} is not a JSON object`);
  return value as Record<string, unknown>;
}

function readHookMap(file: Record<string, unknown>, path: string): Record<string, HookGroup[]> {
  if (file.hooks === undefined) return {};
  if (!file.hooks || typeof file.hooks !== 'object' || Array.isArray(file.hooks))
    throw new Error(`${path} has a hooks value that is not an object`);
  const hooks = file.hooks as Record<string, unknown>;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`${path} has a non-array ${event} hook group`);
    for (const group of groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group))
        throw new Error(`${path} has an invalid ${event} hook group`);
      if (!Array.isArray((group as { hooks?: unknown }).hooks))
        throw new Error(`${path} has a ${event} hook group without a hooks array`);
    }
  }
  return hooks as Record<string, HookGroup[]>;
}

function writeJsonWithBackup(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) copyFileSync(path, `${path}.salidium-backup`);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temporary = join(dirname(path), `.${basename(path)}.salidium-${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Keep the original write failure. */
    }
    throw error;
  }
}
