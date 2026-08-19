import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
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
import { writeRelayScript } from '@salidium/daemon';

export type HookProviderId = 'claude-code' | 'codex';
export type HookConfigurationStatus = 'configured' | 'not-configured' | 'partial' | 'invalid';

export interface InstallResult {
  provider: HookProviderId;
  settingsPath: string;
  changed: boolean;
  events: string[];
  note?: string;
}

export interface HookInspection {
  provider: HookProviderId;
  settingsPath: string;
  status: HookConfigurationStatus;
  events: string[];
  missingEvents: string[];
  issue?: string;
}

interface HookGroup {
  matcher?: string;
  hooks: unknown[];
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

function readHookMap(file: Record<string, unknown>, path: string): Record<string, HookGroup[]> {
  if (file.hooks === undefined) return {};
  if (typeof file.hooks !== 'object' || file.hooks === null || Array.isArray(file.hooks))
    throw new Error(`${path} has a hooks value that is not an object`);
  const hooks = file.hooks as Record<string, unknown>;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`${path} has a non-array ${event} hook group`);
    for (const group of groups) {
      if (typeof group !== 'object' || group === null || Array.isArray(group))
        throw new Error(`${path} has an invalid ${event} hook group`);
      if (!Array.isArray((group as { hooks?: unknown }).hooks))
        throw new Error(`${path} has a ${event} hook group without a hooks array`);
    }
  }
  return hooks as Record<string, HookGroup[]>;
}

type ReplaceFile = (temporary: string, destination: string) => void;

/** Writes provider settings by replacing one complete, flushed file in the same directory. */
export function writeJsonWithBackup(
  path: string,
  value: unknown,
  replaceFile: ReplaceFile = renameSync,
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.salidium-backup`);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temporary = join(
    directory,
    `.${basename(path)}.salidium-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    const descriptor = openSync(temporary, 'wx', mode);
    try {
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temporary, mode);
    replaceFile(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Never hide the original write, flush, or replace failure. */
    }
    throw error;
  }
}

/** Merges one canonical Salidium hook group per event while preserving every unrelated entry. */
function mergeHookGroups(
  existing: Record<string, HookGroup[]>,
  ours: Record<string, HookGroup[]>,
  isOurs: (spec: unknown) => boolean,
): { hooks: Record<string, HookGroup[]>; changed: boolean } {
  const out: Record<string, HookGroup[]> = {};
  const events = new Set([...Object.keys(existing), ...Object.keys(ours)]);
  for (const event of events) {
    const kept = (existing[event] ?? [])
      .map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !isOurs(hook)) }))
      .filter((group) => group.hooks.length > 0);
    const merged = [...kept, ...(ours[event] ?? [])];
    if (merged.length > 0) out[event] = merged;
  }
  return { hooks: out, changed: !isDeepStrictEqual(existing, out) };
}

function settingsPath(provider: HookProviderId, userHome: string, env: NodeJS.ProcessEnv): string {
  return provider === 'claude-code'
    ? join(env.CLAUDE_CONFIG_DIR ?? join(userHome, '.claude'), 'settings.json')
    : join(env.CODEX_HOME ?? join(userHome, '.codex'), 'hooks.json');
}

export function relayCommand(salidiumHome: string, provider: HookProviderId): string {
  const script = join(salidiumHome, 'hooks', 'relay.sh');
  if (/\r|\n/.test(script)) throw new Error('Salidium home path must not contain newlines');
  // relay.sh is installed mode 0700 with an absolute /bin/sh shebang. Invoking that trusted,
  // absolute file directly prevents a project-controlled `sh` earlier on PATH from intercepting
  // every provider hook before the relay has a chance to install its sanitized PATH.
  return `SALIDIUM_HOOK=1 '${script.replace(/'/g, `'\\''`)}' ${provider}`;
}

interface RelayInspection {
  healthy: boolean;
  issue?: string;
}

function inspectRelayScript(salidiumHome: string): RelayInspection {
  const path = join(salidiumHome, 'hooks', 'relay.sh');
  if (!existsSync(path)) return { healthy: false, issue: 'relay script is missing' };
  try {
    const mode = statSync(path).mode;
    if ((mode & 0o111) === 0) return { healthy: false, issue: 'relay script is not executable' };
    const text = readFileSync(path, 'utf8');
    const quotedHome = salidiumHome.replace(/'/g, `'\\''`);
    const markers = [
      '#!/bin/sh\n',
      '# Salidium hook relay',
      `HOME_DIR='${quotedHome}'`,
      'PATH=',
      '[ -n "$SALIDIUM_INTERNAL" ] && exit 0',
      'if [ "$1" = "--send" ]',
    ];
    if (!markers.every((marker) => text.includes(marker)))
      return { healthy: false, issue: 'relay script is stale' };
    return { healthy: true };
  } catch (error) {
    return {
      healthy: false,
      issue: `relay script cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function relaySnapshot(salidiumHome: string): { text: string; mode: number } | undefined {
  const path = join(salidiumHome, 'hooks', 'relay.sh');
  try {
    return { text: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 };
  } catch {
    return undefined;
  }
}

function desiredHooks(provider: HookProviderId, salidiumHome: string): Record<string, HookGroup[]> {
  const command = relayCommand(salidiumHome, provider);
  return provider === 'claude-code'
    ? buildClaudeCodeHooks(command)
    : buildCodexHooks(command).hooks;
}

function salidiumPredicate(provider: HookProviderId): (spec: unknown) => boolean {
  return provider === 'claude-code' ? isClaudeSalidiumHook : isCodexSalidiumHook;
}

export function inspectHooks(
  provider: HookProviderId,
  userHome: string,
  salidiumHome: string,
  env: NodeJS.ProcessEnv = process.env,
): HookInspection {
  const path = settingsPath(provider, userHome, env);
  const ours = desiredHooks(provider, salidiumHome);
  const events = Object.keys(ours);
  try {
    const existing = readHookMap(readJson(path), path);
    const isOurs = salidiumPredicate(provider);
    const plan = mergeHookGroups(existing, ours, isOurs);
    const ownedEvents = new Set<string>();
    for (const [event, groups] of Object.entries(existing)) {
      if (groups.some((group) => group.hooks.some(isOurs))) ownedEvents.add(event);
    }
    const incompleteEvents = new Set<string>();
    for (const event of new Set([...Object.keys(existing), ...events])) {
      const current = (existing[event] ?? []).flatMap((group) => group.hooks.filter(isOurs));
      const desired = (ours[event] ?? []).flatMap((group) => group.hooks);
      if (!isDeepStrictEqual(current, desired)) incompleteEvents.add(event);
    }
    let status: HookConfigurationStatus = plan.changed
      ? ownedEvents.size > 0
        ? 'partial'
        : 'not-configured'
      : 'configured';
    const relay = inspectRelayScript(salidiumHome);
    if (ownedEvents.size > 0 && !relay.healthy) status = 'partial';
    return {
      provider,
      settingsPath: path,
      status,
      events,
      missingEvents: [...incompleteEvents],
      issue: status === 'partial' ? relay.issue : undefined,
    };
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

function mutateHooks(
  provider: HookProviderId,
  userHome: string,
  salidiumHome: string,
  remove: boolean,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): InstallResult {
  if (!remove && platform === 'win32') {
    throw new Error(
      'native Windows uses transcript history only; POSIX live hooks were not installed',
    );
  }
  const path = settingsPath(provider, userHome, env);
  const file = readJson(path);
  const existing = readHookMap(file, path);
  const ours = remove ? {} : desiredHooks(provider, salidiumHome);
  const merged = mergeHookGroups(existing, ours, salidiumPredicate(provider));
  let relayChanged = false;
  if (!remove) {
    const before = relaySnapshot(salidiumHome);
    writeRelayScript(join(salidiumHome, 'hooks'), salidiumHome, env);
    relayChanged = !isDeepStrictEqual(before, relaySnapshot(salidiumHome));
  }
  if (merged.changed) writeJsonWithBackup(path, { ...file, hooks: merged.hooks });
  return {
    provider,
    settingsPath: path,
    changed: merged.changed || relayChanged,
    events: Object.keys(ours),
    note:
      provider === 'codex' && !remove && merged.changed
        ? 'Open /hooks in Codex and trust the new Salidium hooks once.'
        : undefined,
  };
}

export function installClaudeCodeHooks(
  userHome: string,
  salidiumHome: string,
  remove = false,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): InstallResult {
  return mutateHooks('claude-code', userHome, salidiumHome, remove, env, platform);
}

export function installCodexHooks(
  userHome: string,
  salidiumHome: string,
  remove = false,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): InstallResult {
  return mutateHooks('codex', userHome, salidiumHome, remove, env, platform);
}

export function hooksInstalled(
  userHome: string,
  env: NodeJS.ProcessEnv = process.env,
): { claudeCode: boolean; codex: boolean } {
  const has = (provider: HookProviderId) => {
    const path = settingsPath(provider, userHome, env);
    try {
      const hooks = readHookMap(readJson(path), path);
      const isOurs = salidiumPredicate(provider);
      return Object.values(hooks).some((groups) =>
        groups.some((group) => group.hooks.some(isOurs)),
      );
    } catch {
      return false;
    }
  };
  return { claudeCode: has('claude-code'), codex: has('codex') };
}
