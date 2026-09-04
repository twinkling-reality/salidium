import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalAlert, OperationsHealthSnapshot } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AlertSink,
  acknowledgeLocalAlert,
  evaluateLocalAlerts,
  readLocalAlerts,
} from './alerts.ts';
import { resolveOperationalConfig } from './configuration.ts';

const directories: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-alerts-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function snapshot(at = '2026-09-04T12:00:00.000Z'): OperationsHealthSnapshot {
  return {
    contractVersion: 1,
    observedAt: at,
    overall: 'healthy',
    daemon: { state: 'running', pid: 42, startedAt: at, version: '1.0.0' },
    collection: { state: 'active', pausedAt: null, pauseExpiresAt: null, pauseReason: null },
    queue: { availability: 'exact', files: 0, bytes: 0, oldestAt: null },
    store: {
      availability: 'exact',
      databaseBytes: 1,
      walBytes: 0,
      totalBytes: 1,
      schemaVersion: 7,
      layoutVersion: 1,
      integrity: 'not-checked',
      retention: 'forever',
      lastIngestAt: null,
    },
    gaps: {
      active: 0,
      recovered: 0,
      omitted: 0,
      latestFingerprint: null,
      activeEpisodes: [],
      recoveredEpisodes: [],
    },
    maintenance: null,
    hooks: [],
    estimates: { queueVelocity: null, drainRate: null, storageGrowth: null, timeToEmpty: null },
    history: { retentionMinutes: 60, retainedSamples: 1 },
  };
}

class CapturingSink implements AlertSink {
  readonly alerts: LocalAlert[] = [];
  publish(alert: LocalAlert): void {
    this.alerts.push(structuredClone(alert));
  }
}

describe('local alert policy transitions', () => {
  it('deduplicates, acknowledges, recovers, and applies cooldown on reactivation', async () => {
    const dir = home();
    const config = resolveOperationalConfig(dir, { environment: {} });
    const sink = new CapturingSink();
    const firstSnapshot = snapshot();
    firstSnapshot.queue = {
      availability: 'exact',
      files: 3,
      bytes: 30,
      oldestAt: '2026-09-04T11:40:00.000Z',
    };

    const first = await evaluateLocalAlerts(dir, firstSnapshot, config, {
      now: new Date(firstSnapshot.observedAt),
      sink,
    });
    expect(first.active).toHaveLength(1);
    expect(first.active[0]).toMatchObject({
      kind: 'queue-age',
      state: 'active',
      notificationEligible: true,
    });
    expect(sink.alerts).toHaveLength(1);

    const repeated = await evaluateLocalAlerts(dir, firstSnapshot, config, {
      now: new Date('2026-09-04T12:01:00.000Z'),
      sink,
    });
    expect(repeated.active).toHaveLength(1);
    expect(repeated.active[0]?.id).toBe(first.active[0]?.id);
    expect(repeated.active[0]?.notificationEligible).toBe(false);
    expect(sink.alerts).toHaveLength(1);

    const acknowledged = acknowledgeLocalAlert(
      dir,
      first.active[0]?.id ?? '',
      new Date('2026-09-04T12:02:00.000Z'),
    );
    expect(acknowledged.active[0]?.state).toBe('acknowledged');
    const stillPresent = await evaluateLocalAlerts(dir, firstSnapshot, config, {
      now: new Date('2026-09-04T12:03:00.000Z'),
      sink,
    });
    expect(stillPresent.active[0]?.state).toBe('acknowledged');

    const healthy = snapshot('2026-09-04T12:04:00.000Z');
    const recovered = await evaluateLocalAlerts(dir, healthy, config, {
      now: new Date(healthy.observedAt),
      sink,
    });
    expect(recovered.active).toHaveLength(0);
    expect(recovered.recent[0]?.state).toBe('recovered');
    expect(sink.alerts.at(-1)?.state).toBe('recovered');

    const reactivated = await evaluateLocalAlerts(dir, firstSnapshot, config, {
      now: new Date('2026-09-04T12:05:00.000Z'),
      sink,
    });
    expect(reactivated.active[0]).toMatchObject({
      kind: 'queue-age',
      state: 'active',
      notificationEligible: false,
    });
    expect(sink.alerts.filter((alert) => alert.state === 'active')).toHaveLength(1);
  });

  it('alerts once for a gap fingerprint and keeps unsafe hook trust active until it changes', async () => {
    const dir = home();
    const config = resolveOperationalConfig(dir, { environment: {} });
    const changed = snapshot();
    changed.gaps = {
      active: 1,
      recovered: 0,
      omitted: 0,
      latestFingerprint: 'gap-one',
      activeEpisodes: [],
      recoveredEpisodes: [],
    };
    changed.hooks = [
      {
        id: 'codex',
        name: 'Codex',
        detected: true,
        configuration: 'configured',
        trust: 'modified',
      },
    ];

    const first = await evaluateLocalAlerts(dir, changed, config);
    expect(first.active.map((alert) => alert.kind).sort()).toEqual([
      'collection-gap',
      'hook-trust-change',
    ]);
    const repeated = await evaluateLocalAlerts(dir, changed, config, {
      now: new Date('2026-09-04T12:01:00.000Z'),
    });
    expect(repeated.active).toHaveLength(2);

    const repaired = snapshot('2026-09-04T12:02:00.000Z');
    repaired.gaps = changed.gaps;
    const changedHook = changed.hooks[0];
    if (!changedHook) throw new Error('test fixture has no hook');
    repaired.hooks = [{ ...changedHook, trust: 'trusted' }];
    const recovered = await evaluateLocalAlerts(dir, repaired, config);
    expect(recovered.active.map((alert) => alert.kind)).toEqual(['collection-gap']);
    expect(
      recovered.recent.some(
        (alert) => alert.kind === 'hook-trust-change' && alert.state === 'recovered',
      ),
    ).toBe(true);

    const gapClosed = snapshot('2026-09-04T12:03:00.000Z');
    gapClosed.gaps = { ...changed.gaps, active: 0, recovered: 1 };
    const closed = await evaluateLocalAlerts(dir, gapClosed, config);
    expect(closed.active).toHaveLength(0);
    expect(
      closed.recent.some((alert) => alert.kind === 'collection-gap' && alert.state === 'recovered'),
    ).toBe(true);
    expect(readLocalAlerts(dir).recent.length).toBeGreaterThan(0);
  });

  it('covers growth, store size, daemon health, and maintenance failure as recoverable episodes', async () => {
    const dir = home();
    const config = resolveOperationalConfig(dir, { environment: {} });
    const failed = snapshot();
    failed.daemon.state = 'unresponsive';
    failed.store.databaseBytes = 5 * 1024 * 1024 * 1024;
    failed.store.totalBytes = failed.store.databaseBytes;
    failed.estimates.queueVelocity = {
      value: 101,
      unit: 'files/minute',
      sampleWindowSeconds: 60,
      samples: 5,
      basis: 'derived',
    };
    failed.maintenance = {
      version: 1,
      operationId: 'failed-maintenance',
      kind: 'storage-optimize',
      phase: 'failure',
      startedAt: failed.observedAt,
      updatedAt: failed.observedAt,
      progress: null,
      message: 'verification failed',
      failure: 'digest mismatch',
    };

    const active = await evaluateLocalAlerts(dir, failed, config);
    expect(active.active.map((alert) => alert.kind).sort()).toEqual([
      'daemon-health',
      'database-size',
      'maintenance-failure',
      'queue-growth',
    ]);

    const recovered = await evaluateLocalAlerts(dir, snapshot('2026-09-04T12:01:00.000Z'), config);
    expect(recovered.active).toHaveLength(0);
    expect(recovered.recent.filter((alert) => alert.state === 'recovered')).toHaveLength(4);
  });

  it('treats interrupted recovery as actionable and bounds persisted failure detail', async () => {
    const dir = home();
    const config = resolveOperationalConfig(dir, { environment: {} });
    const interrupted = snapshot();
    interrupted.maintenance = {
      version: 1,
      operationId: 'interrupted-maintenance',
      kind: 'storage-optimize',
      phase: 'recovery',
      startedAt: interrupted.observedAt,
      updatedAt: interrupted.observedAt,
      progress: null,
      message: 'x'.repeat(1_000),
      resumedFrom: 'optimize',
    };

    const observed = await evaluateLocalAlerts(dir, interrupted, config);
    expect(observed.active).toHaveLength(1);
    expect(observed.active[0]).toMatchObject({
      kind: 'maintenance-failure',
      title: 'Maintenance needs recovery',
    });
    expect(observed.active[0]?.detail).toHaveLength(500);
  });

  it('bounds alert and cooldown-ledger growth under changing gap fingerprints', async () => {
    const dir = home();
    const config = resolveOperationalConfig(dir, { environment: {} });
    for (let index = 0; index < 250; index++) {
      const observed = snapshot(
        new Date(Date.parse('2026-09-04T12:00:00.000Z') + index * 1_000).toISOString(),
      );
      observed.gaps = {
        active: 1,
        recovered: 0,
        omitted: 0,
        latestFingerprint: `gap-${index}`,
        activeEpisodes: [],
        recoveredEpisodes: [],
      };
      await evaluateLocalAlerts(dir, observed, config);
    }

    const ledger = JSON.parse(readFileSync(join(dir, 'operations-alerts.json'), 'utf8')) as {
      alerts: unknown[];
      notifications: Record<string, string>;
    };
    expect(ledger.alerts).toHaveLength(100);
    expect(Object.keys(ledger.notifications)).toHaveLength(200);
  });
});
