import { createHash } from 'node:crypto';
import { existsSync, opendirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CollectionStatus,
  EffectiveOperationalConfig,
  HistoryUpdate,
  MaintenanceState,
  OperationsHealthSnapshot,
  QueueInspection,
} from '@salidium/protocol';
import { OperationsHealthSnapshotSchema, QueueInspectionSchema } from '@salidium/protocol';
import { MAX_HOOK_ABSOLUTE_PENDING_FILES, UNATTRIBUTED_SUFFIX } from '../ingest/limits.ts';
import type { HealthHistorySample, SalidiumStore } from '../storage/salidiumStore.ts';

type DerivedEstimate = NonNullable<OperationsHealthSnapshot['estimates']['queueVelocity']>;
type HookHealth = OperationsHealthSnapshot['hooks'][number];

/**
 * Manual or hostile files beyond the relay's hard ceiling do not turn a status read into a DoS. The
 * margin must exceed MAX_QUARANTINED_FILES, so a full quarantine beside a full queue stays exact.
 */
export const MAX_QUEUE_STATUS_FILES = MAX_HOOK_ABSOLUTE_PENDING_FILES + 1024;
export const MAX_HEALTH_SAMPLES = 17_280;

function quarantinedFile(name: string): boolean {
  return name.endsWith('.oversized') || name.endsWith(UNATTRIBUTED_SUFFIX);
}

function queueFile(name: string, legacy: boolean): boolean {
  if (legacy) return name.endsWith('.jsonl') || name.endsWith('.jsonl.processing');
  return (
    quarantinedFile(name) ||
    name.endsWith('.ready.json') ||
    name.endsWith('.ready.json.processing') ||
    (name.endsWith('.json') && !name.endsWith('.oversized')) ||
    name.endsWith('.json.processing')
  );
}

function queueState(
  name: string,
  legacy: boolean,
): 'ready' | 'processing' | 'legacy' | 'quarantined' {
  if (legacy) return 'legacy';
  if (quarantinedFile(name)) return 'quarantined';
  return name.endsWith('.processing') ? 'processing' : 'ready';
}

function providerFromName(name: string): string | null {
  const separator = name.indexOf('_');
  if (separator > 0) return name.slice(0, separator).replaceAll('~', '/');
  for (const provider of ['claude-code', 'codex'])
    if (name.startsWith(`${provider}-`)) return provider;
  const daily = /^(.+?)\.\d{8}\.jsonl/.exec(name);
  return daily?.[1] ?? null;
}

/** Waiting entries list before quarantined ones, so even a one-entry view names the oldest wait. */
function compareEntries(
  left: QueueInspection['entries'][number],
  right: QueueInspection['entries'][number],
): number {
  const waiting = Number(left.state === 'quarantined') - Number(right.state === 'quarantined');
  return waiting || left.queuedAt.localeCompare(right.queuedAt);
}

/**
 * When the oldest envelope still waiting to be stored was queued. A quarantined file is kept as
 * evidence but will never drain, so it must not hold queue age at the day it was set aside.
 */
export function oldestWaitingAt(queue: QueueInspection): string | null {
  const first = queue.entries[0];
  return first && first.state !== 'quarantined' ? first.queuedAt : null;
}

/**
 * Reads metadata only, never queued payloads. Totals are either exact or absent: crossing the
 * explicit scan ceiling is reported as unavailable rather than returning a partial number as fact.
 * The totals count what is waiting to be stored. Quarantined files are counted on their own, since
 * nothing a drain does will reduce them.
 */
export function inspectQueue(
  home: string,
  options: { entryLimit?: number; scanLimit?: number; now?: Date } = {},
): QueueInspection {
  const entryLimit = Math.min(Math.max(Math.trunc(options.entryLimit ?? 25), 0), 200);
  const scanLimit = Math.min(
    Math.max(Math.trunc(options.scanLimit ?? MAX_QUEUE_STATUS_FILES), 1),
    MAX_QUEUE_STATUS_FILES,
  );
  const candidates = [
    { path: join(home, 'spool', 'pending'), legacy: false },
    { path: join(home, 'spool'), legacy: true },
  ];
  let files = 0;
  let bytes = 0;
  let quarantinedFiles = 0;
  let quarantinedBytes = 0;
  let scanned = 0;
  let exactTotals = true;
  const entries: QueueInspection['entries'] = [];

  outer: for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    let directory: ReturnType<typeof opendirSync> | undefined;
    try {
      directory = opendirSync(candidate.path);
      for (;;) {
        const item = directory.readSync();
        if (!item) break;
        if (!item.isFile() || !queueFile(item.name, candidate.legacy)) continue;
        scanned += 1;
        if (scanned > scanLimit) {
          exactTotals = false;
          break outer;
        }
        try {
          const metadata = statSync(join(candidate.path, item.name));
          const state = queueState(item.name, candidate.legacy);
          if (state === 'quarantined') {
            quarantinedFiles += 1;
            quarantinedBytes += metadata.size;
          } else {
            files += 1;
            bytes += metadata.size;
          }
          if (entryLimit > 0) {
            entries.push({
              id: item.name,
              provider: providerFromName(item.name),
              state,
              bytes: metadata.size,
              queuedAt: metadata.mtime.toISOString(),
            });
            entries.sort(compareEntries);
            if (entries.length > entryLimit) entries.pop();
          }
        } catch {
          // A concurrently drained file is absent from this exact point-in-time observation.
        }
      }
    } catch {
      exactTotals = false;
      break;
    } finally {
      directory?.closeSync();
    }
  }

  return QueueInspectionSchema.parse({
    contractVersion: 1,
    observedAt: (options.now ?? new Date()).toISOString(),
    totalFiles: exactTotals ? files : null,
    totalBytes: exactTotals ? bytes : null,
    quarantinedFiles: exactTotals ? quarantinedFiles : null,
    quarantinedBytes: exactTotals ? quarantinedBytes : null,
    entries,
    entriesTruncated: !exactTotals || files + quarantinedFiles > entries.length,
    exactTotals,
  });
}

function estimate(
  value: number,
  unit: DerivedEstimate['unit'],
  windowSeconds: number,
  samples: number,
): DerivedEstimate {
  return { value, unit, sampleWindowSeconds: windowSeconds, samples, basis: 'derived' };
}

function endpoints<T extends number | null>(
  samples: HealthHistorySample[],
  pick: (sample: HealthHistorySample) => T,
): [HealthHistorySample, HealthHistorySample] | undefined {
  const usable = samples.filter((sample) => pick(sample) !== null);
  const first = usable[0];
  const last = usable.at(-1);
  if (!first || !last || first === last) return undefined;
  if (Date.parse(last.observedAt) - Date.parse(first.observedAt) < 10_000) return undefined;
  return [first, last];
}

/** Net rates over the retained sample window; no interpolation is presented as observation. */
export function calculateHealthEstimates(
  samples: HealthHistorySample[],
): OperationsHealthSnapshot['estimates'] {
  const queue = endpoints(samples, (sample) => sample.queueFiles);
  const storage = endpoints(samples, (sample) => sample.storeBytes);
  let queueVelocity: DerivedEstimate | null = null;
  let drainRate: DerivedEstimate | null = null;
  let timeToEmpty: DerivedEstimate | null = null;
  let storageGrowth: DerivedEstimate | null = null;

  if (queue) {
    const [first, last] = queue;
    const seconds = (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 1000;
    const velocity = (((last.queueFiles ?? 0) - (first.queueFiles ?? 0)) * 60) / seconds;
    queueVelocity = estimate(velocity, 'files/minute', seconds, samples.length);
    if (velocity < 0) {
      drainRate = estimate(-velocity, 'files/minute', seconds, samples.length);
      if ((last.queueFiles ?? 0) > 0)
        timeToEmpty = estimate(
          ((last.queueFiles ?? 0) / -velocity) * 60,
          'seconds',
          seconds,
          samples.length,
        );
    }
  }
  if (storage) {
    const [first, last] = storage;
    const seconds = (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 1000;
    storageGrowth = estimate(
      (((last.storeBytes ?? 0) - (first.storeBytes ?? 0)) * 60) / seconds,
      'bytes/minute',
      seconds,
      samples.length,
    );
  }
  return { queueVelocity, drainRate, storageGrowth, timeToEmpty };
}

function latestGapFingerprint(collection: CollectionStatus): string | null {
  const gap = collection.gaps.active.at(-1) ?? collection.gaps.recovered.at(-1);
  if (!gap) return null;
  return createHash('sha256')
    .update(JSON.stringify([gap.reason, gap.provider, gap.event, gap.pressure, gap.firstDroppedAt]))
    .digest('hex')
    .slice(0, 16);
}

export interface HealthSnapshotInput {
  home: string;
  queue?: QueueInspection;
  collection: CollectionStatus;
  daemon: OperationsHealthSnapshot['daemon'];
  hooks: HookHealth[];
  maintenance: MaintenanceState | null;
  historyUpdate?: HistoryUpdate | null;
  config: EffectiveOperationalConfig;
  history: HealthHistorySample[];
  schemaVersion: number | null;
  layoutVersion: number | null;
  now?: Date;
}

export function createHealthSnapshot(input: HealthSnapshotInput): OperationsHealthSnapshot {
  const now = input.now ?? new Date();
  const queue = input.queue ?? inspectQueue(input.home, { entryLimit: 1, now });
  const databasePath = join(input.home, 'salidium.db');
  let databaseBytes: number | null = null;
  let walBytes: number | null = null;
  try {
    databaseBytes = statSync(databasePath).size;
    walBytes = existsSync(`${databasePath}-wal`) ? statSync(`${databasePath}-wal`).size : 0;
  } catch {
    /* The store is explicitly unavailable rather than zero. */
  }
  const activeGaps = input.collection.gaps.active.length;
  const totalGaps =
    activeGaps + input.collection.gaps.recovered.length + input.collection.gaps.omittedEpisodes;
  const current: HealthHistorySample = {
    observedAt: now.toISOString(),
    queueFiles: queue.totalFiles,
    queueBytes: queue.totalBytes,
    storeBytes: databaseBytes === null || walBytes === null ? null : databaseBytes + walBytes,
    activeGaps,
    totalGaps,
    daemonState: input.daemon.state,
    collectionState: input.collection.state,
    maintenancePhase: input.maintenance?.phase ?? null,
  };
  const since = now.getTime() - input.config.values.health.historyMinutes.value * 60_000;
  const history = [
    ...input.history.filter((sample) => Date.parse(sample.observedAt) >= since),
    current,
  ];
  const queueOldestAt = oldestWaitingAt(queue);
  const queueAgeMs = queueOldestAt ? now.getTime() - Date.parse(queueOldestAt) : 0;
  const maintenanceNeedsRecovery =
    input.maintenance?.phase === 'failure' || input.maintenance?.phase === 'recovery';
  const hookProblem = input.hooks.some(
    (hook) =>
      hook.configuration === 'invalid' || hook.trust === 'untrusted' || hook.trust === 'modified',
  );
  const critical = input.daemon.state === 'unresponsive' || input.collection.health === 'runaway';
  const attention =
    activeGaps > 0 ||
    maintenanceNeedsRecovery ||
    hookProblem ||
    queueAgeMs >= input.config.values.alerts.queueAgeMinutes.value * 60_000 ||
    (databaseBytes !== null &&
      databaseBytes + (walBytes ?? 0) >= input.config.values.alerts.databaseSizeBytes.value);

  return OperationsHealthSnapshotSchema.parse({
    contractVersion: 1,
    observedAt: now.toISOString(),
    overall: critical ? 'critical' : attention ? 'attention' : 'healthy',
    daemon: input.daemon,
    collection: {
      state: input.collection.state,
      pausedAt: input.collection.pause?.pausedAt ?? null,
      pauseExpiresAt: input.collection.pause?.expiresAt ?? null,
      pauseReason: input.collection.pause?.reason ?? null,
    },
    queue: {
      availability: queue.exactTotals ? 'exact' : 'unavailable',
      files: queue.totalFiles,
      bytes: queue.totalBytes,
      oldestAt: queueOldestAt,
      ...(queue.exactTotals
        ? {}
        : { reason: `queue exceeds the ${MAX_QUEUE_STATUS_FILES} file safety ceiling` }),
    },
    store: {
      availability: databaseBytes === null ? 'unavailable' : 'exact',
      databaseBytes,
      walBytes,
      totalBytes: current.storeBytes,
      schemaVersion: input.schemaVersion,
      layoutVersion: input.layoutVersion,
      integrity: databaseBytes === null ? 'unavailable' : 'not-checked',
      retention: input.collection.store.retention,
      lastIngestAt: input.collection.store.lastIngestAt,
    },
    gaps: {
      active: activeGaps,
      recovered: input.collection.gaps.recovered.length,
      omitted: input.collection.gaps.omittedEpisodes,
      latestFingerprint: latestGapFingerprint(input.collection),
      activeEpisodes: input.collection.gaps.active,
      recoveredEpisodes: input.collection.gaps.recovered,
    },
    maintenance: input.maintenance,
    historyUpdate: input.historyUpdate ?? null,
    hooks: input.hooks,
    estimates: calculateHealthEstimates(history),
    history: {
      retentionMinutes: input.config.values.health.historyMinutes.value,
      retainedSamples: history.length,
    },
  });
}

export function sampleFromSnapshot(snapshot: OperationsHealthSnapshot): HealthHistorySample {
  return {
    observedAt: snapshot.observedAt,
    queueFiles: snapshot.queue.files,
    queueBytes: snapshot.queue.bytes,
    storeBytes: snapshot.store.totalBytes,
    activeGaps: snapshot.gaps.active,
    totalGaps: snapshot.gaps.active + snapshot.gaps.recovered + snapshot.gaps.omitted,
    daemonState: snapshot.daemon.state,
    collectionState: snapshot.collection.state,
    maintenancePhase: snapshot.maintenance?.phase ?? null,
  };
}

export function retainHealthSample(
  store: SalidiumStore,
  snapshot: OperationsHealthSnapshot,
  config: EffectiveOperationalConfig,
): void {
  const retentionMs = config.values.health.historyMinutes.value * 60_000;
  const cutoff = new Date(Date.parse(snapshot.observedAt) - retentionMs).toISOString();
  const configuredMaximum =
    Math.ceil(
      (config.values.health.historyMinutes.value * 60) /
        config.values.health.sampleIntervalSeconds.value,
    ) + 1;
  store.appendHealthSample(
    sampleFromSnapshot(snapshot),
    cutoff,
    Math.min(Math.max(configuredMaximum, 2), MAX_HEALTH_SAMPLES),
  );
}

export function collectionStatusFromHealth(snapshot: OperationsHealthSnapshot): CollectionStatus {
  return {
    observedAt: snapshot.observedAt,
    state: snapshot.collection.state,
    pause:
      snapshot.collection.pausedAt &&
      snapshot.collection.pauseExpiresAt &&
      snapshot.collection.pauseReason
        ? {
            pausedAt: snapshot.collection.pausedAt,
            expiresAt: snapshot.collection.pauseExpiresAt,
            reason: snapshot.collection.pauseReason,
          }
        : null,
    queue: {
      files: snapshot.queue.files ?? 0,
      bytes: snapshot.queue.bytes ?? 0,
      oldestAt: snapshot.queue.oldestAt,
    },
    store: {
      bytes: snapshot.store.totalBytes,
      retention: snapshot.store.retention,
      lastIngestAt: snapshot.store.lastIngestAt,
    },
    health:
      snapshot.overall === 'critical'
        ? 'runaway'
        : snapshot.gaps.active > 0
          ? 'attention'
          : 'healthy',
    gaps: {
      active: snapshot.gaps.activeEpisodes,
      recovered: snapshot.gaps.recoveredEpisodes,
      omittedEpisodes: snapshot.gaps.omitted,
    },
  };
}
