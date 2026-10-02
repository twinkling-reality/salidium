import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isOperationalConfigKey,
  migrateOperationalConfig,
  operationalConfigPaths,
  readOperationalConfig,
  resetOperationalConfig,
  resolveOperationalConfig,
  setOperationalConfigValue,
  updateOperationalConfig,
} from './configuration.ts';

const directories: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-operations-config-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('operational configuration', () => {
  it('preserves the v0.3 history-day domain for existing environments', () => {
    const resolved = resolveOperationalConfig(home(), {
      environment: { SALIDIUM_HISTORY_DAYS: String(Number.MAX_SAFE_INTEGER) },
    });
    expect(resolved.values.history.days.value).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('resolves defaults, stored choices, then environment values with an explicit source', () => {
    const dir = home();
    updateOperationalConfig(
      dir,
      {
        history: { days: 30 },
        git: { enabled: false },
        explainer: { backend: 'claude' },
      },
      { now: new Date('2026-09-04T10:00:00.000Z') },
    );

    const resolved = resolveOperationalConfig(dir, {
      environment: {
        SALIDIUM_HISTORY_DAYS: '2',
        SALIDIUM_EXPLAINER: 'codex',
        SALIDIUM_EXPLAIN_MODEL: 'gpt-5.6-sol',
      },
      now: new Date('2026-09-04T10:01:00.000Z'),
    });

    expect(resolved.values.history.days).toEqual({
      value: 2,
      source: 'environment',
      environment: 'SALIDIUM_HISTORY_DAYS',
    });
    expect(resolved.values.git.enabled).toEqual({ value: false, source: 'stored' });
    expect(resolved.values.explainer.backend).toEqual({
      value: 'codex',
      source: 'environment',
      environment: 'SALIDIUM_EXPLAINER',
    });
    expect(resolved.values.explainer.cadence).toEqual({ value: 'off', source: 'default' });
    expect(resolved.values.retention.days).toEqual({ value: 'forever', source: 'default' });
    expect(resolved.values.alerts.nativeNotifications).toEqual({
      value: false,
      source: 'default',
    });
  });

  it('migrates legacy settings once and keeps the old file as rollback evidence', () => {
    const dir = home();
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        explainerCadence: 'session',
        explainerBackend: 'codex',
        explainerModel: 'gpt-5',
      }),
    );

    const read = readOperationalConfig(dir, {
      migrate: true,
      now: new Date('2026-09-04T11:00:00.000Z'),
    });

    expect(read.migrated).toBe(true);
    expect(read.stored).toMatchObject({
      version: 1,
      revision: 1,
      migratedFrom: 'settings-v0',
      settings: {
        explainer: { cadence: 'session', backend: 'codex', model: 'gpt-5' },
      },
    });
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
    expect(statSync(operationalConfigPaths(dir).current).mode & 0o777).toBe(0o600);
  });

  it('migrates the explicit v0 shape through a pure versioned migration', () => {
    expect(
      migrateOperationalConfig(
        {
          version: 0,
          explainerCadence: 'turn',
          explainerBackend: 'auto',
          explainerModel: null,
        },
        new Date('2026-09-04T12:00:00.000Z'),
      ),
    ).toMatchObject({
      version: 1,
      revision: 1,
      migratedFrom: 'settings-v0',
      settings: { explainer: { cadence: 'turn', backend: 'auto', model: null } },
    });
  });

  it('reads every 0.6.x-shaped configuration unchanged and never rewrites it', () => {
    const full = {
      history: { days: 14 },
      retention: { days: 90 },
      git: { enabled: false },
      providers: { enabled: ['claude-code'] },
      explainer: { cadence: 'turn', backend: 'auto', model: null },
      health: { sampleIntervalSeconds: 30, historyMinutes: 120 },
      alerts: {
        queueAgeMinutes: 20,
        queueGrowthFiles: 200,
        databaseSizeBytes: 2_000_000_000,
        cooldownMinutes: 60,
        nativeNotifications: true,
      },
      ui: { operationsDetail: 'expanded' },
    };
    const shapes = [
      { version: 1, revision: 0, updatedAt: '2026-09-26T10:00:00.000Z', settings: {} },
      { version: 1, revision: 4, updatedAt: '2026-09-26T10:00:00.000Z', settings: full },
      ...(['auto', 'claude', 'codex'] as const).map((backend, index) => ({
        version: 1,
        revision: 2 + index,
        updatedAt: '2026-09-26T10:00:00.000Z',
        migratedFrom: index === 0 ? 'settings-v0' : 'sqlite-retention',
        settings: { explainer: { cadence: 'session', backend, model: 'some-model' } },
      })),
    ];
    for (const shape of shapes) {
      const dir = home();
      const path = operationalConfigPaths(dir).current;
      const text = JSON.stringify(shape);
      writeFileSync(path, text);
      const read = readOperationalConfig(dir, { migrate: true });
      expect(read.warning).toBeUndefined();
      expect(read.migrated).toBe(false);
      expect(read.stored).toEqual(shape);
      expect(readFileSync(path, 'utf8')).toBe(text);
      expect(() => resolveOperationalConfig(dir)).not.toThrow();
    }
  });

  it('stores the local Ollama writer as an explicit choice with its own source labels', () => {
    const dir = home();
    // A file written before `ollama` existed still reads, and a v0 file can name the new value.
    writeFileSync(
      operationalConfigPaths(dir).current,
      JSON.stringify({
        version: 1,
        revision: 3,
        updatedAt: '2026-09-04T12:00:00.000Z',
        settings: { explainer: { cadence: 'session', backend: 'codex', model: null } },
      }),
    );
    expect(resolveOperationalConfig(dir).values.explainer.backend).toEqual({
      value: 'codex',
      source: 'stored',
    });
    expect(
      migrateOperationalConfig({
        version: 0,
        explainerCadence: 'turn',
        explainerBackend: 'ollama',
        explainerModel: 'qwen:1b',
      }).settings.explainer,
    ).toEqual({ cadence: 'turn', backend: 'ollama', model: 'qwen:1b' });

    setOperationalConfigValue(dir, 'explainer.backend', 'ollama');
    setOperationalConfigValue(dir, 'explainer.model', 'qwen:1b');
    const stored = resolveOperationalConfig(dir).values.explainer;
    expect(stored.backend).toEqual({ value: 'ollama', source: 'stored' });
    expect(stored.model).toEqual({ value: 'qwen:1b', source: 'stored' });

    const forced = resolveOperationalConfig(dir, {
      environment: { SALIDIUM_EXPLAINER: 'ollama' },
    }).values.explainer.backend;
    expect(forced).toEqual({
      value: 'ollama',
      source: 'environment',
      environment: 'SALIDIUM_EXPLAINER',
    });

    expect(() => setOperationalConfigValue(dir, 'explainer.backend', 'local')).toThrow();
    resetOperationalConfig(dir, 'explainer.backend');
    expect(resolveOperationalConfig(dir).values.explainer.backend).toEqual({
      value: 'auto',
      source: 'default',
    });
  });

  it('retains the last valid configuration and recovers from it when the primary is damaged', () => {
    const dir = home();
    setOperationalConfigValue(dir, 'health.historyMinutes', 120, {
      now: new Date('2026-09-04T12:00:00.000Z'),
    });
    setOperationalConfigValue(dir, 'health.historyMinutes', 180, {
      now: new Date('2026-09-04T12:01:00.000Z'),
    });
    const paths = operationalConfigPaths(dir);
    expect(JSON.parse(readFileSync(paths.previous, 'utf8'))).toMatchObject({
      settings: { health: { historyMinutes: 120 } },
    });

    writeFileSync(paths.current, '{broken');
    const recovered = readOperationalConfig(dir);
    expect(recovered.recoveredFromPrevious).toBe(true);
    expect(recovered.stored.settings.health?.historyMinutes).toBe(120);
    expect(recovered.warning).toMatch(/recoverable previous copy/);

    setOperationalConfigValue(dir, 'alerts.queueAgeMinutes', 25);
    expect(JSON.parse(readFileSync(paths.previous, 'utf8'))).toMatchObject({
      settings: { health: { historyMinutes: 120 } },
    });
    expect(readOperationalConfig(dir).stored).toMatchObject({
      settings: { health: { historyMinutes: 120 }, alerts: { queueAgeMinutes: 25 } },
    });
  });

  it('validates writes, revisions, and reset-to-default behavior', () => {
    const dir = home();
    const first = setOperationalConfigValue(dir, 'alerts.queueAgeMinutes', 20);
    expect(first.revision).toBe(1);
    expect(() =>
      setOperationalConfigValue(dir, 'alerts.queueAgeMinutes', 0, {
        expectedRevision: first.revision,
      }),
    ).toThrow();
    expect(() =>
      setOperationalConfigValue(dir, 'alerts.queueAgeMinutes', 30, { expectedRevision: 0 }),
    ).toThrow(/configuration changed/);

    resetOperationalConfig(dir, 'alerts.queueAgeMinutes', { expectedRevision: first.revision });
    expect(resolveOperationalConfig(dir).values.alerts.queueAgeMinutes).toEqual({
      value: 10,
      source: 'default',
    });
    expect(isOperationalConfigKey('alerts.queueAgeMinutes')).toBe(true);
    expect(isOperationalConfigKey('relay.breakerThreshold')).toBe(false);

    setOperationalConfigValue(dir, 'providers.enabled', []);
    expect(resolveOperationalConfig(dir).values.providers.enabled.value).toEqual([]);

    setOperationalConfigValue(dir, 'alerts.nativeNotifications', true);
    expect(resolveOperationalConfig(dir).values.alerts.nativeNotifications).toEqual({
      value: true,
      source: 'stored',
    });
  });
});
