import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ConfigValueSource,
  EffectiveOperationalConfig,
  OperationalConfigPatch,
  OperationalConfigSettings,
  OperationsRetentionDays,
  StoredOperationalConfig,
} from '@salidium/protocol';
import {
  EffectiveOperationalConfigSchema,
  OperationalConfigPatchSchema,
  OperationalConfigSettingsSchema,
  StoredOperationalConfigSchema,
} from '@salidium/protocol';
import { readJsonFile, writePrivateJsonAtomic } from './files.ts';

export const DEFAULT_OPERATIONAL_CONFIG: OperationalConfigSettings = {
  history: { days: 7 },
  retention: { days: 'forever' },
  git: { enabled: true },
  providers: { enabled: ['claude-code', 'codex'] },
  explainer: { cadence: 'off', backend: 'auto', model: null },
  health: { sampleIntervalSeconds: 15, historyMinutes: 60 },
  alerts: {
    queueAgeMinutes: 10,
    queueGrowthFiles: 100,
    databaseSizeBytes: 5 * 1024 * 1024 * 1024,
    cooldownMinutes: 30,
    nativeNotifications: false,
  },
  ui: { operationsDetail: 'summary' },
};

export const OPERATIONAL_CONFIG_KEYS = [
  'history.days',
  'retention.days',
  'git.enabled',
  'providers.enabled',
  'explainer.cadence',
  'explainer.backend',
  'explainer.model',
  'health.sampleIntervalSeconds',
  'health.historyMinutes',
  'alerts.queueAgeMinutes',
  'alerts.queueGrowthFiles',
  'alerts.databaseSizeBytes',
  'alerts.cooldownMinutes',
  'alerts.nativeNotifications',
  'ui.operationsDetail',
] as const;
export type OperationalConfigKey = (typeof OPERATIONAL_CONFIG_KEYS)[number];

export interface OperationalConfigRead {
  stored: StoredOperationalConfig;
  recoveredFromPrevious: boolean;
  migrated: boolean;
  warning?: string;
}

/**
 * Persistence seam for operational policy. The file implementation is deliberately local-only,
 * while callers depend on this contract so a hosted control plane can be added without teaching
 * the daemon or HTTP layer about a second source of truth.
 */
export interface OperationalConfigBackend {
  read(options?: { now?: Date; migrate?: boolean }): OperationalConfigRead;
  resolve(options?: {
    environment?: NodeJS.ProcessEnv;
    now?: Date;
    migrate?: boolean;
    retentionFallback?: OperationsRetentionDays;
  }): EffectiveOperationalConfig;
  update(
    patch: OperationalConfigPatch,
    options?: { expectedRevision?: number; now?: Date },
  ): StoredOperationalConfig;
  reset(
    key?: OperationalConfigKey,
    options?: { expectedRevision?: number; now?: Date },
  ): StoredOperationalConfig;
  migrateRetention(policy: OperationsRetentionDays, now?: Date): StoredOperationalConfig;
}

export function operationalConfigPaths(home: string) {
  return {
    current: join(home, 'operations-config.json'),
    previous: join(home, 'operations-config.previous.json'),
    legacy: join(home, 'settings.json'),
  };
}

function emptyConfig(now: Date, revision = 0): StoredOperationalConfig {
  return {
    version: 1,
    revision,
    updatedAt: now.toISOString(),
    settings: {},
  };
}

function legacySettings(path: string): OperationalConfigPatch | undefined {
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('legacy settings are not an object');
  const cadence = raw.explainerCadence;
  const backend = raw.explainerBackend ?? 'auto';
  const model = raw.explainerModel ?? null;
  const parsed = OperationalConfigPatchSchema.safeParse({
    explainer: { cadence, backend, model },
  });
  if (!parsed.success) throw new Error('legacy explainer settings are invalid');
  return parsed.data;
}

/** Pure migration entrypoint so every supported historical shape is independently testable. */
export function migrateOperationalConfig(raw: unknown, now = new Date()): StoredOperationalConfig {
  const current = StoredOperationalConfigSchema.safeParse(raw);
  if (current.success) return current.data;
  const legacy = raw as Record<string, unknown> | null;
  if (!legacy || typeof legacy !== 'object' || legacy.version !== 0)
    throw new Error('unsupported or invalid operational configuration');
  const patch = OperationalConfigPatchSchema.safeParse({
    explainer: {
      cadence: legacy.explainerCadence,
      backend: legacy.explainerBackend ?? 'auto',
      model: legacy.explainerModel ?? null,
    },
  });
  if (!patch.success) throw new Error('operational configuration v0 is invalid');
  return {
    version: 1,
    revision: 1,
    updatedAt: now.toISOString(),
    migratedFrom: 'settings-v0',
    settings: patch.data,
  };
}

export function readOperationalConfig(
  home: string,
  options: { now?: Date; migrate?: boolean } = {},
): OperationalConfigRead {
  const now = options.now ?? new Date();
  const paths = operationalConfigPaths(home);
  if (existsSync(paths.current)) {
    try {
      const raw = readJsonFile(paths.current);
      const stored = migrateOperationalConfig(raw, now);
      if ((raw as { version?: unknown }).version !== 1 && options.migrate) {
        writePrivateJsonAtomic(paths.current, stored, { previousPath: paths.previous });
        return { stored, recoveredFromPrevious: false, migrated: true };
      }
      return { stored, recoveredFromPrevious: false, migrated: false };
    } catch (primaryError) {
      if (existsSync(paths.previous)) {
        try {
          return {
            stored: migrateOperationalConfig(readJsonFile(paths.previous), now),
            recoveredFromPrevious: true,
            migrated: false,
            warning: `current configuration is invalid; using the recoverable previous copy (${String(primaryError)})`,
          };
        } catch {
          /* Report the primary failure below. */
        }
      }
      return {
        stored: emptyConfig(now),
        recoveredFromPrevious: false,
        migrated: false,
        warning: `configuration is invalid; safe defaults are in force (${String(primaryError)})`,
      };
    }
  }

  try {
    const legacy = legacySettings(paths.legacy);
    if (legacy) {
      const stored: StoredOperationalConfig = {
        ...emptyConfig(now, 1),
        migratedFrom: 'settings-v0',
        settings: legacy,
      };
      if (options.migrate) writePrivateJsonAtomic(paths.current, stored);
      return { stored, recoveredFromPrevious: false, migrated: Boolean(options.migrate) };
    }
  } catch (error) {
    return {
      stored: emptyConfig(now),
      recoveredFromPrevious: false,
      migrated: false,
      warning: `legacy settings are invalid; optional explanations are safely off (${String(error)})`,
    };
  }
  return { stored: emptyConfig(now), recoveredFromPrevious: false, migrated: false };
}

function entry<T>(
  value: T,
  source: ConfigValueSource,
  environment?: string,
): { value: T; source: ConfigValueSource; environment?: string } {
  return environment ? { value, source, environment } : { value, source };
}

function value<T>(stored: T | undefined, fallback: T) {
  return stored === undefined ? entry(fallback, 'default') : entry(stored, 'stored');
}

function parseNonnegativeDays(raw: string): number {
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`SALIDIUM_HISTORY_DAYS must be a nonnegative whole number`);
  return parsed;
}

export function resolveOperationalConfig(
  home: string,
  options: {
    environment?: NodeJS.ProcessEnv;
    now?: Date;
    migrate?: boolean;
    retentionFallback?: OperationsRetentionDays;
  } = {},
): EffectiveOperationalConfig {
  const now = options.now ?? new Date();
  const env = options.environment ?? process.env;
  const { stored } = readOperationalConfig(home, { now, migrate: options.migrate });
  const s = stored.settings;
  const history = value(s.history?.days, DEFAULT_OPERATIONAL_CONFIG.history.days);
  const git = value(s.git?.enabled, DEFAULT_OPERATIONAL_CONFIG.git.enabled);
  const cadence = value(s.explainer?.cadence, DEFAULT_OPERATIONAL_CONFIG.explainer.cadence);
  const backend = value(s.explainer?.backend, DEFAULT_OPERATIONAL_CONFIG.explainer.backend);
  const model = value(s.explainer?.model, DEFAULT_OPERATIONAL_CONFIG.explainer.model);

  if (env.SALIDIUM_HISTORY_DAYS !== undefined) {
    history.value = parseNonnegativeDays(env.SALIDIUM_HISTORY_DAYS);
    history.source = 'environment';
    history.environment = 'SALIDIUM_HISTORY_DAYS';
  }
  if (env.SALIDIUM_NO_GIT !== undefined) {
    git.value = env.SALIDIUM_NO_GIT !== '1';
    git.source = 'environment';
    git.environment = 'SALIDIUM_NO_GIT';
  }
  if (env.SALIDIUM_EXPLAINER !== undefined) {
    const mode = env.SALIDIUM_EXPLAINER.trim().toLowerCase();
    if (!['auto', 'claude', 'codex', 'off'].includes(mode))
      throw new Error('SALIDIUM_EXPLAINER must be auto, claude, codex, or off');
    if (mode === 'off') {
      cadence.value = 'off';
      cadence.source = 'environment';
      cadence.environment = 'SALIDIUM_EXPLAINER';
    } else {
      backend.value = mode as 'auto' | 'claude' | 'codex';
      backend.source = 'environment';
      backend.environment = 'SALIDIUM_EXPLAINER';
    }
  }
  if (env.SALIDIUM_EXPLAIN_MODEL !== undefined) {
    const parsed = OperationalConfigSettingsSchema.shape.explainer.shape.model.safeParse(
      env.SALIDIUM_EXPLAIN_MODEL,
    );
    if (!parsed.success) throw new Error('SALIDIUM_EXPLAIN_MODEL must be a valid model name');
    model.value = parsed.data;
    model.source = 'environment';
    model.environment = 'SALIDIUM_EXPLAIN_MODEL';
  }

  return EffectiveOperationalConfigSchema.parse({
    contractVersion: 1,
    schemaVersion: 1,
    revision: stored.revision,
    observedAt: now.toISOString(),
    restartRequired: [],
    values: {
      history: { days: history },
      retention: {
        days: value(
          s.retention?.days,
          options.retentionFallback ?? DEFAULT_OPERATIONAL_CONFIG.retention.days,
        ),
      },
      git: { enabled: git },
      providers: {
        enabled: value(s.providers?.enabled, DEFAULT_OPERATIONAL_CONFIG.providers.enabled),
      },
      explainer: { cadence, backend, model },
      health: {
        sampleIntervalSeconds: value(
          s.health?.sampleIntervalSeconds,
          DEFAULT_OPERATIONAL_CONFIG.health.sampleIntervalSeconds,
        ),
        historyMinutes: value(
          s.health?.historyMinutes,
          DEFAULT_OPERATIONAL_CONFIG.health.historyMinutes,
        ),
      },
      alerts: {
        queueAgeMinutes: value(
          s.alerts?.queueAgeMinutes,
          DEFAULT_OPERATIONAL_CONFIG.alerts.queueAgeMinutes,
        ),
        queueGrowthFiles: value(
          s.alerts?.queueGrowthFiles,
          DEFAULT_OPERATIONAL_CONFIG.alerts.queueGrowthFiles,
        ),
        databaseSizeBytes: value(
          s.alerts?.databaseSizeBytes,
          DEFAULT_OPERATIONAL_CONFIG.alerts.databaseSizeBytes,
        ),
        cooldownMinutes: value(
          s.alerts?.cooldownMinutes,
          DEFAULT_OPERATIONAL_CONFIG.alerts.cooldownMinutes,
        ),
        nativeNotifications: value(
          s.alerts?.nativeNotifications,
          DEFAULT_OPERATIONAL_CONFIG.alerts.nativeNotifications,
        ),
      },
      ui: {
        operationsDetail: value(
          s.ui?.operationsDetail,
          DEFAULT_OPERATIONAL_CONFIG.ui.operationsDetail,
        ),
      },
    },
  });
}

function mergePatch(
  settings: StoredOperationalConfig['settings'],
  patch: OperationalConfigPatch,
): StoredOperationalConfig['settings'] {
  const next = structuredClone(settings);
  for (const group of Object.keys(patch) as Array<keyof OperationalConfigPatch>) {
    const change = patch[group];
    if (!change) continue;
    if (!next[group]) next[group] = {};
    Object.assign(next[group] as object, change);
  }
  return next;
}

export function updateOperationalConfig(
  home: string,
  patch: OperationalConfigPatch,
  options: { expectedRevision?: number; now?: Date } = {},
): StoredOperationalConfig {
  const now = options.now ?? new Date();
  const parsed = OperationalConfigPatchSchema.parse(patch);
  const read = readOperationalConfig(home, { now, migrate: true });
  const current = read.stored;
  if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision)
    throw new Error(`configuration changed (expected revision ${options.expectedRevision})`);
  const next: StoredOperationalConfig = {
    version: 1,
    revision: current.revision + 1,
    updatedAt: now.toISOString(),
    settings: mergePatch(current.settings, parsed),
  };
  StoredOperationalConfigSchema.parse(next);
  const paths = operationalConfigPaths(home);
  writePrivateJsonAtomic(paths.current, next, {
    ...(read.warning ? {} : { previousPath: paths.previous }),
  });
  return next;
}

/** One-time bridge from the schema-6 SQLite metadata setting into the versioned configuration. */
export function migrateRetentionPolicy(
  home: string,
  policy: OperationsRetentionDays,
  now = new Date(),
): StoredOperationalConfig {
  const read = readOperationalConfig(home, { now, migrate: true });
  const current = read.stored;
  if (current.settings.retention?.days !== undefined) return current;
  const next: StoredOperationalConfig = {
    ...current,
    revision: current.revision + 1,
    updatedAt: now.toISOString(),
    migratedFrom: current.migratedFrom ?? 'sqlite-retention',
    settings: mergePatch(current.settings, { retention: { days: policy } }),
  };
  const paths = operationalConfigPaths(home);
  writePrivateJsonAtomic(paths.current, next, {
    ...(read.warning ? {} : { previousPath: paths.previous }),
  });
  return next;
}

function patchForKey(key: OperationalConfigKey, input: unknown): OperationalConfigPatch {
  const [group, field] = key.split('.') as [keyof OperationalConfigPatch, string];
  return { [group]: { [field]: input } } as OperationalConfigPatch;
}

export function setOperationalConfigValue(
  home: string,
  key: OperationalConfigKey,
  input: unknown,
  options: { expectedRevision?: number; now?: Date } = {},
): StoredOperationalConfig {
  return updateOperationalConfig(home, patchForKey(key, input), options);
}

export function resetOperationalConfig(
  home: string,
  key?: OperationalConfigKey,
  options: { expectedRevision?: number; now?: Date } = {},
): StoredOperationalConfig {
  const now = options.now ?? new Date();
  const read = readOperationalConfig(home, { now, migrate: true });
  const current = read.stored;
  if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision)
    throw new Error(`configuration changed (expected revision ${options.expectedRevision})`);
  const settings = structuredClone(current.settings);
  if (key) {
    const [group, field] = key.split('.') as [keyof typeof settings, string];
    const target = settings[group] as Record<string, unknown> | undefined;
    if (target) {
      delete target[field];
      if (Object.keys(target).length === 0) delete settings[group];
    }
  } else {
    for (const group of Object.keys(settings) as Array<keyof typeof settings>)
      delete settings[group];
  }
  const next: StoredOperationalConfig = {
    version: 1,
    revision: current.revision + 1,
    updatedAt: now.toISOString(),
    settings,
  };
  const paths = operationalConfigPaths(home);
  writePrivateJsonAtomic(paths.current, next, {
    ...(read.warning ? {} : { previousPath: paths.previous }),
  });
  return next;
}

export function isOperationalConfigKey(value: string): value is OperationalConfigKey {
  return (OPERATIONAL_CONFIG_KEYS as readonly string[]).includes(value);
}

export function createFileOperationalConfigBackend(home: string): OperationalConfigBackend {
  return {
    read: (options) => readOperationalConfig(home, options),
    resolve: (options) => resolveOperationalConfig(home, options),
    update: (patch, options) => updateOperationalConfig(home, patch, options),
    reset: (key, options) => resetOperationalConfig(home, key, options),
    migrateRetention: (policy, now) => migrateRetentionPolicy(home, policy, now),
  };
}
