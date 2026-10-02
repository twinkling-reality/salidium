import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectionStatus } from '@salidium/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_HOOK_ABSOLUTE_PENDING_FILES, MAX_QUARANTINED_FILES } from '../ingest/limits.ts';
import type { HealthHistorySample } from '../storage/salidiumStore.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { resolveOperationalConfig } from './configuration.ts';
import {
  calculateHealthEstimates,
  createHealthSnapshot,
  inspectQueue,
  MAX_QUEUE_STATUS_FILES,
  oldestWaitingAt,
  retainHealthSample,
} from './health.ts';

const directories: string[] = [];

function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-health-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function sample(
  at: string,
  queueFiles: number | null,
  storeBytes: number | null,
): HealthHistorySample {
  return {
    observedAt: at,
    queueFiles,
    queueBytes: queueFiles === null ? null : queueFiles * 10,
    storeBytes,
    activeGaps: 0,
    totalGaps: 0,
    daemonState: 'running',
    collectionState: 'active',
    maintenancePhase: null,
  };
}

function collection(observedAt: string): CollectionStatus {
  return {
    observedAt,
    state: 'active',
    pause: null,
    queue: { files: 0, bytes: 0, oldestAt: null },
    store: { bytes: 0, retention: 'forever', lastIngestAt: null },
    health: 'healthy',
    gaps: { active: [], recovered: [], omittedEpisodes: 0 },
  };
}

describe('bounded operational health', () => {
  it('calculates signed net velocity, net drain, storage growth, and time to empty', () => {
    const estimates = calculateHealthEstimates([
      sample('2026-09-04T10:00:00.000Z', 120, 1_000),
      sample('2026-09-04T10:01:00.000Z', 90, 1_600),
      sample('2026-09-04T10:02:00.000Z', 60, 2_200),
    ]);

    expect(estimates.queueVelocity).toMatchObject({
      value: -30,
      unit: 'files/minute',
      basis: 'derived',
    });
    expect(estimates.drainRate?.value).toBe(30);
    expect(estimates.storageGrowth?.value).toBe(600);
    expect(estimates.timeToEmpty?.value).toBe(120);
  });

  it('withholds estimates until two exact samples span at least ten seconds', () => {
    expect(calculateHealthEstimates([sample('2026-09-04T10:00:00.000Z', 1, 10)])).toEqual({
      queueVelocity: null,
      drainRate: null,
      storageGrowth: null,
      timeToEmpty: null,
    });
    expect(
      calculateHealthEstimates([
        sample('2026-09-04T10:00:00.000Z', null, null),
        sample('2026-09-04T10:01:00.000Z', 1, 10),
      ]).queueVelocity,
    ).toBeNull();
  });

  it('streams metadata for a queue beyond the relay ceiling without reading payloads into memory', () => {
    const dir = home();
    const pending = join(dir, 'spool', 'pending');
    mkdirSync(pending, { recursive: true });
    for (let i = 0; i < 2_250; i++)
      writeFileSync(join(pending, `codex_${i}.ready.json`), String(i % 10));

    const observed = inspectQueue(dir, {
      entryLimit: 3,
      now: new Date('2026-09-04T10:00:00.000Z'),
    });

    expect(observed.exactTotals).toBe(true);
    expect(observed.totalFiles).toBe(2_250);
    expect(observed.entries).toHaveLength(3);
    expect(observed.entriesTruncated).toBe(true);
  });

  it('keeps a full queue beside a full quarantine inside the exact scan ceiling', () => {
    expect(MAX_HOOK_ABSOLUTE_PENDING_FILES + MAX_QUARANTINED_FILES).toBeLessThan(
      MAX_QUEUE_STATUS_FILES,
    );
  });

  it('returns no partial total when the safety ceiling is crossed', () => {
    const dir = home();
    const pending = join(dir, 'spool', 'pending');
    mkdirSync(pending, { recursive: true });
    for (let i = 0; i < 3; i++) writeFileSync(join(pending, `codex_${i}.ready.json`), 'x');

    const observed = inspectQueue(dir, { entryLimit: 2, scanLimit: 2 });
    expect(observed.exactTotals).toBe(false);
    expect(observed.totalFiles).toBeNull();
    expect(observed.totalBytes).toBeNull();
  });

  it('keeps quarantined payload metadata visible without reading its contents', () => {
    const dir = home();
    const pending = join(dir, 'spool', 'pending');
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, 'codex_1.ready.json.processing.oversized'), 'private payload');

    const observed = inspectQueue(dir);
    expect(observed).toMatchObject({
      exactTotals: true,
      totalFiles: 0,
      quarantinedFiles: 1,
      quarantinedBytes: 15,
      entries: [{ provider: 'codex', state: 'quarantined', bytes: 15 }],
      entriesTruncated: false,
    });
    expect(JSON.stringify(observed)).not.toContain('private payload');
  });

  /*
   * The shape found on a real machine: envelopes from a process-table exhaustion whose names lost
   * their provider, sitting weeks older than everything around them. Once quarantined they are
   * evidence, not waiting work, so they must neither hold queue age at that day nor count as input
   * a drain or a storage optimization is still waiting for.
   */
  it('measures queue age from waiting work, not from quarantined evidence', () => {
    const dir = home();
    const pending = join(dir, 'spool', 'pending');
    mkdirSync(pending, { recursive: true });
    const plant = (name: string, body: string, at: string) => {
      writeFileSync(join(pending, name), body);
      utimesSync(join(pending, name), new Date(at), new Date(at));
    };
    plant(
      '_1788981330-49817-147de426.json.unattributed',
      'synthetic one',
      '2026-09-09T19:15:30.000Z',
    );
    plant('_1788981852-8914-.json.unattributed', 'synthetic two', '2026-09-09T19:24:12.000Z');
    plant('claude-code_1790954716-1-a.ready.json', 'synthetic three', '2026-10-02T15:25:16.000Z');
    plant('claude-code_1790954717-2-b.json', 'synthetic four', '2026-10-02T15:25:17.000Z');
    const now = new Date('2026-10-02T15:30:00.000Z');

    const listed = inspectQueue(dir, { now });
    expect(listed).toMatchObject({
      exactTotals: true,
      totalFiles: 2,
      totalBytes: 29,
      quarantinedFiles: 2,
      quarantinedBytes: 26,
      entriesTruncated: false,
    });
    expect(listed.entries.map((entry) => [entry.provider, entry.state, entry.queuedAt])).toEqual([
      ['claude-code', 'ready', '2026-10-02T15:25:16.000Z'],
      ['claude-code', 'ready', '2026-10-02T15:25:17.000Z'],
      [null, 'quarantined', '2026-09-09T19:15:30.000Z'],
      [null, 'quarantined', '2026-09-09T19:24:12.000Z'],
    ]);

    // Health and status read a one-entry view. It must still name the oldest waiting envelope.
    const single = inspectQueue(dir, { entryLimit: 1, now });
    expect(oldestWaitingAt(single)).toBe('2026-10-02T15:25:16.000Z');
    expect(single.entriesTruncated).toBe(true);
    const snapshot = createHealthSnapshot({
      home: dir,
      collection: collection(now.toISOString()),
      daemon: { state: 'running', pid: 42, startedAt: now.toISOString(), version: '1.0.0' },
      hooks: [],
      maintenance: null,
      config: resolveOperationalConfig(dir, { environment: {}, now }),
      history: [],
      schemaVersion: 8,
      layoutVersion: 1,
      now,
    });
    expect(snapshot.queue).toMatchObject({
      files: 2,
      bytes: 29,
      oldestAt: '2026-10-02T15:25:16.000Z',
    });

    // With nothing waiting, quarantined files leave no oldest item at all.
    rmSync(join(pending, 'claude-code_1790954716-1-a.ready.json'));
    rmSync(join(pending, 'claude-code_1790954717-2-b.json'));
    const quarantinedOnly = inspectQueue(dir, { entryLimit: 1, now });
    expect(quarantinedOnly).toMatchObject({ totalFiles: 0, quarantinedFiles: 2 });
    expect(oldestWaitingAt(quarantinedOnly)).toBeNull();
  });

  it('retains aggregate samples by both time and a hard row bound', () => {
    const dir = home();
    const store = new SqliteStore(join(dir, 'salidium.db'));
    try {
      const config = resolveOperationalConfig(dir, {
        environment: {},
        now: new Date('2026-09-04T10:00:00.000Z'),
      });
      for (let minute = 0; minute < 5; minute++) {
        const now = new Date(Date.parse('2026-09-04T10:00:00.000Z') + minute * 60_000);
        const snapshot = createHealthSnapshot({
          home: dir,
          collection: collection(now.toISOString()),
          daemon: { state: 'running', pid: 42, startedAt: now.toISOString(), version: '1.0.0' },
          hooks: [],
          maintenance: null,
          config,
          history: [],
          schemaVersion: 7,
          layoutVersion: 1,
          now,
        });
        retainHealthSample(store, snapshot, config);
      }
      const rows = store.healthSamples('2026-09-04T00:00:00.000Z', 10);
      expect(rows).toHaveLength(5);
      expect(rows[0]?.daemonState).toBe('running');
      expect(rows[0]).not.toHaveProperty('sessionId');
    } finally {
      store.close();
    }
  });

  it('reports an interrupted maintenance recovery as needing attention', () => {
    const dir = home();
    const now = new Date('2026-09-04T10:00:00.000Z');
    const result = createHealthSnapshot({
      home: dir,
      collection: collection(now.toISOString()),
      daemon: { state: 'running', pid: 42, startedAt: now.toISOString(), version: '1.0.0' },
      hooks: [],
      maintenance: {
        version: 1,
        operationId: 'interrupted',
        kind: 'storage-optimize',
        phase: 'recovery',
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        progress: null,
        message: 'Maintenance was interrupted.',
        resumedFrom: 'optimize',
      },
      config: resolveOperationalConfig(dir, { environment: {}, now }),
      history: [],
      schemaVersion: 8,
      layoutVersion: 1,
      now,
    });

    expect(result.overall).toBe('attention');
  });
});
