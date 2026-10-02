import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { claudeCodeProvider } from '@salidium/adapter-claude-code';
import { codexProvider } from '@salidium/adapter-codex';
import {
  type ProviderDescriptor,
  ProviderRegistry,
  trustedPathEntries,
} from '@salidium/adapter-kit';
import { openCodeProvider } from '@salidium/adapter-opencode';
import type { ExperimentalContractEntry } from '@salidium/consumer-contract';
import type { RunState } from '@salidium/core';
import { projectMapContractEntry } from '@salidium/project-map';
import {
  type CollectionStatus,
  type DaemonInfo,
  type EffectiveOperationalConfig,
  type ExplainerBackend,
  type ExplainerCadence,
  type ExplainerSettings,
  type ExplainerSettingsRequest,
  type OllamaModels,
  OPERATIONS_CONTRACT_VERSION,
  type OperationalConfigPatch,
  type OperationsHealthSnapshot,
  type OperationsOverview,
  type PersonalizationSettingsRequest,
  PROTOCOL_VERSION,
  type StorageComposition,
} from '@salidium/protocol';
import { type DaemonConfig, daemonPaths, resolveDaemonConfig } from './config/daemonConfig.ts';
import {
  deletePersonalization,
  EMPTY_PERSONALIZATION,
  nextPersonalization,
  readPersonalization,
  writePersonalization,
} from './config/personalization.ts';
import { ConsumerCredentialVerifier } from './consumer/credentials.ts';
import {
  consumerDiscovery,
  experimentalContracts,
  removeConsumerDiscovery,
  writeConsumerDiscovery,
} from './consumer/discovery.ts';
import { createConsumerRoutes } from './consumer/routes.ts';
import { explainedConfiguration } from './enrich/explainerBackends.ts';
import { listOllamaModels } from './enrich/ollamaBackend.ts';
import { personalizeExplanation } from './enrich/personalizeExplanation.ts';
import { FileLocationEnricher } from './enrichers/fileLocation.ts';
import { GitSnapshotEnricher } from './enrichers/gitSnapshot.ts';
import { type CodexHookTrust, inspectCodexHookTrust } from './ingest/codexHookTrust.ts';
import {
  expireCollectionPause,
  observeCollectionStatus,
  pauseCollection,
  readCollectionPause,
  resumeCollection,
} from './ingest/collectionState.ts';
import {
  disconnectBuiltInHooks,
  type HookConfigurationInspection,
  inspectBuiltInHooks,
} from './ingest/hookConfiguration.ts';
import { HookIngress } from './ingest/hookIngress.ts';
import {
  HOOK_BREAKER_FILE,
  HOOK_PAUSE_FILE,
  HOOK_QUOTA_LOCK_FILE,
  HOOK_QUOTA_REAPING_DIR,
  HOOK_SHED_FIRST_FILE,
  HOOK_SHED_RETAIN_FILE,
  HOOK_SHED_SECOND_FILE,
  MAX_HOOK_ABSOLUTE_PENDING_FILES,
  MAX_HOOK_PENDING_FILES,
  MAX_HOOK_SHED_FIRST_PENDING_FILES,
  MAX_HOOK_SHED_SECOND_PENDING_FILES,
  MAX_INGEST_PAYLOAD_BYTES,
  TRUNCATED_HOOK_PAYLOAD_KEY,
} from './ingest/limits.ts';
import { StoreTailer } from './ingest/storeTailer.ts';
import { TranscriptTailer } from './ingest/transcriptTailer.ts';
import { createSessionLinks } from './links/sessionLinks.ts';
import { createLogger } from './logging/logger.ts';
import {
  type AlertSink,
  acknowledgeLocalAlert,
  evaluateLocalAlerts,
  readLocalAlerts,
} from './operations/alerts.ts';
import {
  createFileOperationalConfigBackend,
  DEFAULT_OPERATIONAL_CONFIG,
  isOperationalConfigKey,
  readOperationalConfig,
  updateOperationalConfig,
} from './operations/configuration.ts';
import { writePrivateJsonAtomic, writePrivateTextAtomic } from './operations/files.ts';
import {
  createHealthSnapshot,
  inspectQueue,
  oldestWaitingAt,
  retainHealthSample,
} from './operations/health.ts';
import { readMaintenanceState, runQueueDrainMaintenance } from './operations/maintenance.ts';
import { NativeAlertSink } from './operations/nativeNotifications.ts';
import { createProjectMapRoutes } from './projectMap/routes.ts';
import { DaemonProjectMapService } from './projectMap/service.ts';
import { createHttpServer } from './server/httpServer.ts';
import { HistoryWarmup } from './sessions/historyWarmup.ts';
import { effectiveCadence } from './sessions/sessionCoordinator.ts';
import { SessionRegistry } from './sessions/sessionRegistry.ts';
import { inspectStoreLayout } from './storage/optimizeStore.ts';
import type { SalidiumStoreFactory } from './storage/salidiumStore.ts';
import { createSqliteStore, SCHEMA_VERSION } from './storage/sqliteStore.ts';

export interface DaemonHandle {
  config: DaemonConfig;
  port: number;
  token: string;
  registry: SessionRegistry;
  hooks: HookIngress;
  tailer: TranscriptTailer;
  collectionStatus(): CollectionStatus;
  operationsSnapshot(): OperationsHealthSnapshot;
  pauseCollection(reason?: 'manual' | 'stop'): CollectionStatus;
  resumeCollection(): CollectionStatus;
  stop(): Promise<void>;
}

export interface DaemonJson {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  version: string;
  /** Absent on old daemon records; callers must restart before using a mismatched runtime. */
  protocolVersion?: string;
  storeSchemaVersion?: number;
}

export type StartDaemonOptions = Partial<DaemonConfig> & {
  version?: string;
  /**
   * Explicit adapter set for an embedding application. Salidium never searches a project or
   * node_modules for executable plug-ins; callers must load and pass reviewed descriptors.
   */
  providerDescriptors?: readonly ProviderDescriptor[];
  /**
   * Experimental local contracts to list in consumer discovery, given the port the daemon listens
   * on. Called once, after the port is known, so `consumer.json` and the discovery endpoint agree
   * for the instance's whole life. Defaults to none.
   */
  experimentalContracts?: (context: { port: number }) => readonly unknown[];
  /** Test seam: false leaves stored sessions to be re-derived on first open only. */
  historyWarmup?: boolean;
  /** Internal persistence seam; SQLite is the production authority and default. */
  storeFactory?: SalidiumStoreFactory;
  /** Test/embedding seam; the native desktop sink is used when notification policy enables it. */
  alertSink?: AlertSink;
  /** Test/embedding seam. Production retention sweeps run once per hour. */
  retentionSweepIntervalMs?: number;
  /** Test/fixture seam for the one derivation that reads the wall clock; see `CoordinatorOptions.now`. */
  now?: () => number;
};

/*
 * Every built-in is registered; `providers.enabled` in the operations config decides which are
 * read. OpenCode is registered but not enabled by default.
 */
const BUILT_IN_PROVIDERS: readonly ProviderDescriptor[] = [
  claudeCodeProvider,
  codexProvider,
  openCodeProvider,
];
const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000;

const require = createRequire(import.meta.url);
const VERSION: string = (() => {
  try {
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

/**
 * Compatibility view of the explainer choices that outlive a restart.
 *
 * Operational choices live in the versioned `operations-config.json`, separate from
 * `daemon.json`: that file is written fresh on every start so the CLI and hook relay can locate a
 * running daemon. The compatibility type remains for the older explainer API surface.
 *
 * Not in `daemon.json`'s directory config either. `DaemonConfig` is resolved from flags and the
 * environment on each start — it describes how this process was launched, and a stop the reader
 * picked in a browser is not that.
 */
export interface StoredSettings {
  explainerCadence: ExplainerCadence;
  explainerBackend: ExplainerBackend;
  explainerModel: string | null;
}

/**
 * Compatibility projection for callers that predate the versioned operational configuration.
 * The legacy settings file is read only by the migration in `readOperationalConfig`; every new
 * write has one authority and a recoverable previous copy.
 */
export function readSettings(home: string, onInvalid?: (reason: string) => void): StoredSettings {
  const read = readOperationalConfig(home, { migrate: true });
  if (read.warning) onInvalid?.(read.warning);
  return {
    explainerCadence:
      read.stored.settings.explainer?.cadence ?? DEFAULT_OPERATIONAL_CONFIG.explainer.cadence,
    explainerBackend:
      read.stored.settings.explainer?.backend ?? DEFAULT_OPERATIONAL_CONFIG.explainer.backend,
    explainerModel:
      read.stored.settings.explainer?.model ?? DEFAULT_OPERATIONAL_CONFIG.explainer.model,
  };
}

export function writeSettings(home: string, settings: StoredSettings): void {
  updateOperationalConfig(home, {
    explainer: {
      cadence: settings.explainerCadence,
      backend: settings.explainerBackend,
      model: settings.explainerModel,
    },
  });
}

export function readDaemonJson(home: string): DaemonJson | undefined {
  const p = daemonPaths(home).daemonJson;
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as DaemonJson;
  } catch {
    return undefined;
  }
}

/** Locates the built UI (packages/ui/dist) relative to this package, if present. */
/**
 * Where the built UI is, in both layouts this code runs in.
 *
 * Published, everything is one bundled script with `ui/` beside it. In the workspace the daemon
 * runs from its own `dist/` (or `src/`) and the UI is a sibling package. The bundle's own layout
 * is checked first: in a workspace *both* resolve, and if the sibling wins there the published
 * arrangement is never exercised until a user hits a 404 that no test would have caught.
 */
export function defaultUiDist(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, 'ui'),
    join(here, '..', 'ui'),
    join(here, '..', '..', 'ui', 'dist'),
    join(here, '..', '..', '..', 'ui', 'dist'),
  ]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}

export async function startDaemon(overrides: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const runtimeVersion = overrides.version ?? VERSION;
  const bootstrap = resolveDaemonConfig(overrides);
  const configBackend = createFileOperationalConfigBackend(bootstrap.home);
  const launchOperations = configBackend.resolve({ migrate: true });
  const config = resolveDaemonConfig({
    ...overrides,
    home: bootstrap.home,
    historyDays: overrides.historyDays ?? launchOperations.values.history.days.value,
    gitEnrichment: overrides.gitEnrichment ?? launchOperations.values.git.enabled.value,
    providers: overrides.providers ?? launchOperations.values.providers.enabled.value,
  });
  const paths = daemonPaths(config.home);
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.spoolDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.hooksDir, { recursive: true, mode: 0o700 });
  // mkdir's mode applies only on creation. Repair permissive directories from older installs on
  // every start before any token, hook payload or session record is written beneath them.
  chmodSync(config.home, 0o700);
  chmodSync(paths.spoolDir, 0o700);
  chmodSync(paths.hooksDir, 0o700);
  const log = createLogger(config.logLevel, process.env.SALIDIUM_LOG_FILE ?? undefined);
  const alertSink =
    overrides.alertSink ??
    new NativeAlertSink({
      onError: (error) =>
        log.warn('native notification could not be delivered', { err: String(error) }),
    });
  const providerRegistry = new ProviderRegistry(
    overrides.providerDescriptors ?? BUILT_IN_PROVIDERS,
  );
  const adapters = providerRegistry.adaptersFor(config.providers);

  const store = (overrides.storeFactory ?? createSqliteStore)(paths.db);
  const persistedOperations = configBackend.read({ migrate: true });
  if (
    persistedOperations.stored.settings.retention?.days === undefined &&
    store.retentionPolicy() !== DEFAULT_OPERATIONAL_CONFIG.retention.days
  )
    configBackend.migrateRetention(store.retentionPolicy());
  const operationalConfig = (): EffectiveOperationalConfig => {
    const effective = configBackend.resolve({
      migrate: true,
      retentionFallback: store.retentionPolicy(),
    });
    const restartRequired: string[] = [];
    if (effective.values.history.days.value !== config.historyDays)
      restartRequired.push('history.days');
    if (effective.values.git.enabled.value !== config.gitEnrichment)
      restartRequired.push('git.enabled');
    if (effective.values.providers.enabled.value.join('\0') !== config.providers.join('\0'))
      restartRequired.push('providers.enabled');
    return { ...effective, restartRequired };
  };
  const initiallyEffective = operationalConfig();
  if (store.retentionPolicy() !== initiallyEffective.values.retention.days.value)
    store.setRetentionPolicy(initiallyEffective.values.retention.days.value);
  /*
   * The stop is read once, here, and the environment is folded into it once, here. Everything
   * downstream is handed a single answer to "when does the explainer run", so there is no second
   * place that can decide differently — which is how the env escape and a stored preference would
   * otherwise drift apart.
   */
  const stored = readSettings(config.home, (reason) =>
    log.warn('settings invalid; optional explanations disabled', { reason }),
  );
  let personalization = readPersonalization(config.home, (reason) =>
    log.warn('personalization invalid; profile ignored', { reason }),
  );
  const personalizationCalls = new Map<string, AbortController>();
  const abortPersonalization = () => {
    for (const controller of personalizationCalls.values()) controller.abort();
    personalizationCalls.clear();
  };
  const activeExplainer = () =>
    explainedConfiguration(stored.explainerBackend, stored.explainerModel, process.env);
  const registry = new SessionRegistry(store, {
    explainerCadence: effectiveCadence(stored.explainerCadence),
    // The coordinator resolves this against the environment itself, so the stored choice, not a
    // default, decides the writer on every path that can generate an explanation.
    explainerChoice: () => ({ backend: stored.explainerBackend, model: stored.explainerModel }),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  const explainerSettings = (): ExplainerSettings => {
    const active = activeExplainer();
    const usage = registry.explainerUsage();
    // Spread rather than `usage: undefined`: the field is absent when nothing was observed, and an
    // explicit undefined would serialise the same but read as a value that happens to be missing.
    return {
      cadence: stored.explainerCadence,
      backend: stored.explainerBackend,
      model: stored.explainerModel,
      envOff: active.mode === 'off',
      backendLocked: active.backendLocked,
      modelLocked: active.modelLocked,
      activeBackend: active.mode === 'off' || active.mode === 'invalid' ? null : active.mode,
      activeModel: active.model ?? null,
      availableBackends: active.availableBackends,
      routes: active.routes,
      ...(active.ollama ? { ollama: active.ollama } : {}),
      usageStatus: store.usageBackfillProgress?.().complete === false ? 'preparing' : 'ready',
      ...(usage ? { usage } : {}),
    };
  };
  registry.onPersistError = (sessionId, err) =>
    log.warn('persist failed; will retry', { sessionId, err: String(err) });
  const tailer = new TranscriptTailer({
    adapters,
    registry,
    store,
    log,
    storeProviders: providerRegistry
      .list()
      .filter((descriptor) => descriptor.storeSource)
      .map((descriptor) => descriptor.adapter.id),
  });
  const storeTailer = new StoreTailer({
    providers: config.providers.flatMap((id) => {
      const source = providerRegistry.get(id)?.storeSource;
      return source ? [{ id, source }] : [];
    }),
    registry,
    store,
    log,
  });
  let collectionPaused = existsSync(paths.pauseFile);
  if (collectionPaused) {
    tailer.pause();
    storeTailer.pause();
  }
  const hooks = new HookIngress({
    adapters,
    registry,
    tailer,
    spoolDir: paths.spoolDir,
    breakerFile: paths.breakerFile,
    collectionEnabled: () => !collectionPaused,
    userHome: config.userHome,
    log,
  });
  const git = new GitSnapshotEnricher(registry, log);
  // After a reducer upgrade, stored sessions are re-derived in the background rather than on
  // first open. Maintenance and a collection pause both hold it.
  const historyWarmup = new HistoryWarmup({
    store,
    log,
    isLive: (sessionId) => registry.peek(sessionId) !== undefined,
    isPaused: () => {
      if (collectionPaused) return true;
      const phase = readMaintenanceState(config.home)?.phase;
      return phase !== undefined && phase !== 'idle' && phase !== 'completed';
    },
  });
  const locations = new FileLocationEnricher(registry, log);
  const token = randomBytes(32).toString('hex');
  const startedAt = new Date().toISOString();

  const descriptorsById = new Map(
    providerRegistry.list().map((descriptor) => [descriptor.adapter.id, descriptor] as const),
  );
  let codexHookTrust: CodexHookTrust = 'unknown';
  const hookInspections = (): HookConfigurationInspection[] =>
    adapters.flatMap((adapter) =>
      adapter.id === 'claude-code' || adapter.id === 'codex'
        ? [inspectBuiltInHooks(adapter.id, config.userHome, config.home)]
        : [],
    );
  const info = (): DaemonInfo => ({
    name: 'salidium',
    version: runtimeVersion,
    pid: process.pid,
    startedAt,
    home: config.home,
    providers: adapters.map((a) => {
      const inspection =
        a.id === 'claude-code' || a.id === 'codex'
          ? inspectBuiltInHooks(a.id, config.userHome, config.home)
          : undefined;
      return {
        id: a.id,
        displayName: descriptorsById.get(a.id)?.displayName ?? a.id,
        hooksInstalled: inspection?.status === 'configured',
        ...(inspection ? { hookStatus: inspection.status } : {}),
        hookTrust: a.id === 'codex' ? codexHookTrust : 'not-applicable',
        sourcesWatched: tailer.countForProvider(a.id) + storeTailer.countForProvider(a.id),
      };
    }),
  });

  const collectionStatus = (): CollectionStatus => {
    const latest = registry.listSessions()[0];
    const inspections = hookInspections();
    return observeCollectionStatus({
      home: config.home,
      retention: store.retentionPolicy(),
      lastIngestAt: latest?.lastEventAt ?? latest?.startedAt,
      daemonReachable: true,
      anyHooksConfigured: inspections.some((inspection) => inspection.status !== 'not-configured'),
    });
  };
  const setCollectionPaused = (reason: 'manual' | 'stop' = 'manual'): CollectionStatus => {
    pauseCollection(config.home, reason);
    collectionPaused = true;
    tailer.pause();
    storeTailer.pause();
    return collectionStatus();
  };
  const setCollectionActive = (): CollectionStatus => {
    resumeCollection(config.home);
    collectionPaused = false;
    tailer.resume();
    storeTailer.resume();
    hooks.drainSpool();
    return collectionStatus();
  };

  const storeLayout = inspectStoreLayout(paths.db);
  const operationsSnapshot = (): OperationsHealthSnapshot => {
    const effective = operationalConfig();
    const now = new Date();
    const queue = inspectQueue(config.home, { entryLimit: 1, now });
    const cutoff = new Date(
      now.getTime() - effective.values.health.historyMinutes.value * 60_000,
    ).toISOString();
    const sampleLimit = Math.min(
      Math.ceil(
        (effective.values.health.historyMinutes.value * 60) /
          effective.values.health.sampleIntervalSeconds.value,
      ) + 1,
      17_280,
    );
    const daemonInfo = info();
    const latest = registry.listSessions()[0];
    const collection = observeCollectionStatus({
      home: config.home,
      retention: store.retentionPolicy(),
      lastIngestAt: latest?.lastEventAt ?? latest?.startedAt,
      daemonReachable: true,
      anyHooksConfigured: daemonInfo.providers.some(
        (provider) => provider.hookStatus && provider.hookStatus !== 'not-configured',
      ),
      queue: {
        files: queue.totalFiles ?? 0,
        bytes: queue.totalBytes ?? 0,
        oldestAt: oldestWaitingAt(queue),
      },
      now,
    });
    return createHealthSnapshot({
      home: config.home,
      queue,
      collection,
      daemon: {
        state: 'running',
        pid: process.pid,
        startedAt,
        version: runtimeVersion,
      },
      hooks: daemonInfo.providers.map((provider) => ({
        id: provider.id,
        name: provider.displayName ?? provider.id,
        detected: true,
        configuration: provider.hookStatus ?? 'unavailable',
        trust: provider.hookTrust ?? 'unknown',
      })),
      maintenance: readMaintenanceState(config.home, now),
      historyUpdate: (() => {
        const progress = historyWarmup.progress();
        return progress
          ? {
              state: progress.state,
              sessionsUpdated: progress.updated,
              sessionsTotal: progress.total,
              reducerVersion: progress.reducerVersion,
            }
          : null;
      })(),
      config: effective,
      history: store.healthSamples(cutoff, sampleLimit),
      schemaVersion: storeLayout.schemaVersion,
      layoutVersion: storeLayout.layoutVersion,
      now,
    });
  };
  const operationsOverview = (): OperationsOverview => ({
    contractVersion: 1,
    config: operationalConfig(),
    health: operationsSnapshot(),
    alerts: readLocalAlerts(config.home),
  });
  let refreshHealthSampling: (() => void) | undefined;
  const applyOperationalConfig = (): EffectiveOperationalConfig => {
    const effective = operationalConfig();
    if (store.retentionPolicy() !== effective.values.retention.days.value)
      store.setRetentionPolicy(effective.values.retention.days.value);
    const nextSettings = readSettings(config.home);
    Object.assign(stored, nextSettings);
    registry.setExplainerCadence(effectiveCadence(stored.explainerCadence));
    // A timer already waiting on the old cadence cannot observe a shorter live interval until it
    // fires. Replace it after every successful config write and evaluate once now so newly lowered
    // alert thresholds are effective in this response cycle rather than one old interval later.
    refreshHealthSampling?.();
    return effective;
  };

  /*
   * The last measurement of what the store is made of, and the worker computing the next one.
   *
   * Held in memory rather than written to disk: it is a description of the file as it was at one
   * moment, it costs ten seconds rather than an hour to produce again, and a stale one restored
   * across a restart would be the same mistake the menu bar made with its maintenance record.
   */
  let composition: StorageComposition = {
    contractVersion: OPERATIONS_CONTRACT_VERSION,
    state: 'absent',
    computedAt: null,
    elapsedMs: null,
    fileBytes: null,
    sessions: null,
    parts: [],
    projects: [],
    projectsOmitted: 0,
    failure: null,
  };
  let compositionWorker: Worker | undefined;
  const analyzeStorage = (): StorageComposition => {
    if (compositionWorker) return composition;
    /*
     * Prefer the worker that belongs to this package, and fall back to the CLI's private
     * subcommand when it is not on disk.
     *
     * Its absence is precisely the packaged case: the published CLI is one bundled file, so a
     * sibling module cannot be there and the only entry point that exists is the CLI itself. Its
     * presence is the embedded case, where `process.argv[1]` is whatever started the host process
     * and spawning that would run the host's own entry point again. The end-to-end fixture calls
     * `startDaemon` in the Playwright worker, which is exactly that, and it reported "the
     * measurement produced no result" until this looked for its own worker first.
     */
    const sibling = new URL('./storage/compositionWorker.js', import.meta.url);
    const worker = existsSync(fileURLToPath(sibling))
      ? new Worker(sibling, { workerData: paths.db })
      : (() => {
          const runtime = process.argv[1];
          if (!runtime) return undefined;
          return new Worker(resolve(runtime), {
            argv: ['__storage-composition', paths.db],
          });
        })();
    if (!worker) {
      composition = {
        ...composition,
        state: 'failed',
        failure: 'Salidium could not locate a runtime to measure the store with.',
      };
      return composition;
    }
    compositionWorker = worker;
    worker.unref();
    composition = { ...composition, state: 'running', failure: null };
    worker.once('message', (message: StorageComposition) => {
      composition = message;
    });
    worker.once('error', (error) => {
      log.warn('storage composition worker failed', { err: String(error) });
      composition = { ...composition, state: 'failed', failure: String(error).slice(0, 500) };
    });
    worker.once('exit', (code) => {
      if (compositionWorker === worker) compositionWorker = undefined;
      // A nonzero exit with no message is the only way this ends without either branch above.
      if (code !== 0 && composition.state === 'running')
        composition = {
          ...composition,
          state: 'failed',
          failure: `The measurement stopped with status ${code}.`,
        };
      else if (composition.state === 'running')
        composition = {
          ...composition,
          state: 'failed',
          failure: 'The measurement produced no result.',
        };
    });
    return composition;
  };

  let port = config.port;
  const instanceId = randomBytes(16).toString('hex');
  let experimental: ExperimentalContractEntry[] | undefined;
  const discovery = () => {
    experimental ??= experimentalContracts(
      () => {
        // The project map's routes are always mounted, so its entry is always listed; which
        // repositories it may read is `/project-map/v0/repositories`, empty until one is opted in.
        const supplied = overrides.experimentalContracts?.({ port }) ?? [];
        return Array.isArray(supplied) ? [projectMapContractEntry(port), ...supplied] : supplied;
      },
      port,
      (reason) => log.warn(reason),
    );
    return consumerDiscovery({
      port,
      providers: config.providers,
      experimental,
      pid: process.pid,
      instanceId,
      startedAt,
      version: runtimeVersion,
      now: (overrides.now ?? Date.now)(),
    });
  };
  const consumerCredentials = new ConsumerCredentialVerifier(config.home, (reason) =>
    log.warn(reason),
  );
  const consumer = createConsumerRoutes({
    registry,
    credentials: consumerCredentials,
    discovery,
    ...(overrides.now ? { now: overrides.now } : {}),
    log,
  });
  // Experimental: maps are built only when a request asks, and only for opted-in repositories.
  const maps = new DaemonProjectMapService({
    home: config.home,
    log,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  // One links handler for both routes, so the interface and consumers get the same document
  // under the same opt-in, cache, build queue and rate limit.
  const sessionLinks = createSessionLinks({
    registry,
    log,
    ...(overrides.now ? { now: overrides.now } : {}),
  }).handler({ maps });
  const projectMap = createProjectMapRoutes({
    maps,
    credentials: consumerCredentials,
    sessionLinks,
    ...(overrides.now ? { now: overrides.now } : {}),
    log,
  });
  const server = createHttpServer({
    consumer,
    storeRecords: {
      isStoreProvider: (provider) =>
        providerRegistry
          .list()
          .some((descriptor) => descriptor.adapter.id === provider && descriptor.storeSource),
      read: (provider, ref) => storeTailer.readRawRecord(provider, ref),
    },
    projectMap,
    sessionLinks,
    registry,
    hooks,
    token,
    port: () => port,
    uiDist: config.uiDist ?? defaultUiDist(),
    info,
    collection: {
      status: collectionStatus,
      set: (request) =>
        request.action === 'pause'
          ? setCollectionPaused(request.reason ?? 'manual')
          : setCollectionActive(),
      disconnect: (provider) => {
        if (provider !== 'claude-code' && provider !== 'codex') return undefined;
        disconnectBuiltInHooks(provider, config.userHome);
        return collectionStatus();
      },
    },
    operations: {
      overview: operationsOverview,
      setConfig: (patch: OperationalConfigPatch, expectedRevision: number | undefined) => {
        configBackend.update(patch, { expectedRevision });
        return applyOperationalConfig();
      },
      resetConfig: (key: string | undefined, expectedRevision: number | undefined) => {
        const validatedKey =
          key === undefined
            ? undefined
            : isOperationalConfigKey(key)
              ? key
              : (() => {
                  throw new Error(`unknown configuration key: ${key}`);
                })();
        configBackend.reset(validatedKey, { expectedRevision });
        return applyOperationalConfig();
      },
      inspectQueue: (limit: number) => {
        return inspectQueue(config.home, { entryLimit: limit });
      },
      drainQueue: () => runQueueDrainMaintenance(config.home, () => hooks.drainSpool()),
      acknowledgeAlert: (id: string) => acknowledgeLocalAlert(config.home, id),
      storageComposition: () => composition,
      analyzeStorage,
    },
    settings: {
      explainer: explainerSettings,
      ollamaModels: async (): Promise<OllamaModels> => {
        // Ollama is asked only while it is the writer in force, not whenever the route is called.
        if (activeExplainer().mode !== 'ollama')
          return {
            state: 'refused',
            endpoint: null,
            models: [],
            reason: 'The local model route is not selected.',
          };
        const list = await listOllamaModels(process.env);
        return list.state === 'ready'
          ? { state: 'ready', endpoint: list.endpoint, models: list.models, reason: null }
          : list.state === 'unreachable'
            ? { state: 'unreachable', endpoint: list.endpoint, models: [], reason: list.reason }
            : { state: 'refused', endpoint: null, models: [], reason: list.reason };
      },
      setExplainerSettings: (change: ExplainerSettingsRequest) => {
        // Persist a candidate before it becomes live. A failed disk write must not leave this
        // process using settings the API reported as rejected.
        const candidate = {
          ...stored,
          ...(change.cadence !== undefined ? { explainerCadence: change.cadence } : {}),
          ...(change.backend !== undefined ? { explainerBackend: change.backend } : {}),
          // A model name belongs to the writer it was chosen for. Switching writer without naming
          // a model clears it, as the interface does, so a local Ollama model name is never handed
          // to a hosted CLI, and a CLI model id is never sent to Ollama.
          ...(change.backend !== undefined &&
          change.backend !== stored.explainerBackend &&
          change.model === undefined
            ? { explainerModel: null }
            : {}),
          ...(change.model !== undefined ? { explainerModel: change.model } : {}),
        };
        writeSettings(config.home, candidate);
        Object.assign(stored, candidate);
        // The environment still outranks the choice; it is the choice that was stored, not the
        // effect. A reader who unsets the variable and restarts gets the stop they picked.
        registry.setExplainerCadence(effectiveCadence(stored.explainerCadence));
        const active = activeExplainer();
        log.info('explainer settings set', {
          cadence: stored.explainerCadence,
          backend: stored.explainerBackend,
          model: stored.explainerModel ?? 'default',
          inForceCadence: effectiveCadence(stored.explainerCadence),
          inForceBackend: active.mode,
        });
        return explainerSettings();
      },
      personalization: () => personalization,
      setPersonalization: (
        request: PersonalizationSettingsRequest,
        expectedRevision: string | undefined,
      ) => {
        if (expectedRevision !== personalization.revision) return 'conflict';
        const candidate = nextPersonalization(request);
        writePersonalization(config.home, candidate);
        abortPersonalization();
        personalization = candidate;
        log.info('personalization profile set', {
          enabled: candidate.enabled,
          revision: candidate.revision,
        });
        return personalization;
      },
      deletePersonalization: (expectedRevision: string | undefined) => {
        if (expectedRevision !== personalization.revision) return 'conflict';
        deletePersonalization(config.home);
        abortPersonalization();
        personalization = structuredClone(EMPTY_PERSONALIZATION);
        log.info('personalization profile deleted');
        return personalization;
      },
      personalize: async (sessionId) => {
        const snapshot = registry.snapshot(sessionId, 0);
        if (!snapshot) return { status: 'not-found' as const };
        const profile = personalization;
        const active = activeExplainer();
        const previous = personalizationCalls.get(sessionId);
        previous?.abort();
        const controller = new AbortController();
        personalizationCalls.set(sessionId, controller);
        const result = await personalizeExplanation(snapshot.state as RunState, profile, {
          mode: active.mode,
          model: active.model,
          signal: controller.signal,
          onFailure: (reason) => log.warn('personalization generation failed', { reason }),
        });
        if (personalizationCalls.get(sessionId) === controller)
          personalizationCalls.delete(sessionId);
        if (profile.revision !== personalization.revision) return { status: 'stale' as const };
        return result;
      },
    },
    log,
  });
  let stopped = false;
  let retentionTimer: NodeJS.Timeout | undefined;
  let usageBackfillWorker: Worker | undefined;
  let usageBackfillRetryTimer: NodeJS.Timeout | undefined;
  let healthTimer: NodeJS.Timeout | undefined;
  let hookTrustTimer: NodeJS.Timeout | undefined;
  let trustRefreshController: AbortController | undefined;
  let collectionControlTimer: NodeJS.Timeout | undefined;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    abortPersonalization();
    if (retentionTimer) clearInterval(retentionTimer);
    if (usageBackfillRetryTimer) clearTimeout(usageBackfillRetryTimer);
    if (usageBackfillWorker) void usageBackfillWorker.terminate();
    if (compositionWorker) void compositionWorker.terminate();
    if (healthTimer) clearTimeout(healthTimer);
    if (hookTrustTimer) clearInterval(hookTrustTimer);
    trustRefreshController?.abort();
    if (collectionControlTimer) clearInterval(collectionControlTimer);
    tailer.stop();
    storeTailer.stop();
    hooks.stop();
    git.stop();
    locations.stop();
    await historyWarmup.stop();
    // Tell open consumer feeds why they are ending before the connections are cut below.
    consumer.close();
    removeConsumerDiscovery(config.home, process.pid);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // The UI keeps long-lived SSE connections open. `server.close()` stops new requests but waits
    // for those streams forever, which made `salidium stop` hang whenever its browser tab was
    // still open. Stop accepting first, then terminate the authenticated loopback connections.
    server.closeAllConnections();
    await closed;
    registry.close();
    store.close();
    try {
      const current = readDaemonJson(config.home);
      if (current?.pid === process.pid) unlinkSync(paths.daemonJson);
    } catch {
      /* ignore */
    }
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : config.port;
    writeRelayScript(paths.hooksDir, config.home);
    const daemonJson: DaemonJson = {
      pid: process.pid,
      port,
      token,
      startedAt,
      version: runtimeVersion,
      protocolVersion: PROTOCOL_VERSION,
      storeSchemaVersion: SCHEMA_VERSION,
    };
    if (config.gitEnrichment) {
      git.start();
      // Reading where a changed file lives is repository observation too, under the same switch.
      locations.start();
    }
    // Recover the spool before publishing daemon.json, not after. The file is what both the CLI's
    // readiness probe and every relay treat as "there is a daemon here", and the first drain is the
    // one moment a fresh daemon is busiest: announcing first meant a backlog could make `salidium
    // start` report that the daemon had not started while it was in fact reading, which invites a
    // retry that opens a second writer on the store.
    hooks.startSpoolWatcher();
    writePrivateJsonAtomic(paths.daemonJson, daemonJson);
    writeConsumerDiscovery(config.home, discovery());
    const initialBackfill = Promise.all([
      tailer.start(config.userHome, config.historyDays),
      storeTailer.start(config.userHome, config.historyDays),
    ]);
    log.info('salidium daemon listening', {
      port,
      home: config.home,
      providers: adapters.map((a) => a.id),
    });

    // Retention is deliberately opt-in and session-granular. Run the first bounded pass only after
    // startup discovery has loaded every currently active transcript. The registry, rather than the
    // store directly, excludes all loaded coordinators and broadcasts removals to connected clients.
    const retentionSweepIntervalMs =
      overrides.retentionSweepIntervalMs ?? DEFAULT_RETENTION_SWEEP_INTERVAL_MS;
    let initialBackfillComplete = false;
    const applyRetention = () => {
      if (
        stopped ||
        !initialBackfillComplete ||
        store.usageBackfillProgress?.().complete === false ||
        store.retentionPolicy() === 'forever'
      )
        return;
      try {
        const removed = registry.applyRetention();
        if (removed.sessions.length > 0) {
          log.info('retention sweep removed inactive sessions', {
            policy: removed.policy,
            sessions: removed.sessions.length,
            events: removed.eventCount,
            bytes: removed.bytes,
          });
        }
      } catch (err) {
        log.warn('retention sweep failed; will retry', { err: String(err) });
      }
    };
    void initialBackfill
      .then(() => {
        initialBackfillComplete = true;
        applyRetention();
      })
      .catch((err) => {
        if (!stopped) log.warn('initial backfill failed; retention deferred', { err: String(err) });
      });
    retentionTimer = setInterval(applyRetention, retentionSweepIntervalMs);
    retentionTimer.unref();

    // Schema upgrades never traverse the archive before listen. The same reviewed runtime advances
    // historical accounting on a separate worker event loop and SQLite connection; a crash resumes
    // at the durable cursor, while HTTP health and control remain isolated from reconstruction.
    const startUsageBackfillWorker = () => {
      if (
        stopped ||
        !store.advanceUsageBackfill ||
        store.usageBackfillProgress?.().complete !== false
      )
        return;
      const runtime = process.argv[1];
      if (!runtime) {
        log.warn('historical usage preparation could not locate the running Salidium runtime');
        return;
      }
      const worker = new Worker(resolve(runtime), {
        argv: ['__usage-backfill', paths.db],
      });
      usageBackfillWorker = worker;
      worker.unref();
      worker.once('error', (error) =>
        log.warn('historical usage preparation worker failed', { err: String(error) }),
      );
      worker.once('exit', (code) => {
        if (usageBackfillWorker === worker) usageBackfillWorker = undefined;
        if (stopped) return;
        const progress = store.usageBackfillProgress?.();
        if (code === 0 && progress?.complete) {
          log.info('historical usage preparation complete', {
            scannedEvents: progress.scannedEvents,
          });
          applyRetention();
          return;
        }
        log.warn('historical usage preparation stopped; will retry', {
          code,
          scannedEvents: progress?.scannedEvents ?? 0,
        });
        usageBackfillRetryTimer = setTimeout(startUsageBackfillWorker, 1_000);
        usageBackfillRetryTimer.unref();
      });
    };
    startUsageBackfillWorker();
    if (overrides.historyWarmup !== false) historyWarmup.start();

    const sampleOperations = () => {
      if (stopped) return;
      try {
        const snapshot = operationsSnapshot();
        const effective = operationalConfig();
        retainHealthSample(store, snapshot, effective);
        void evaluateLocalAlerts(config.home, snapshot, effective, {
          ...(effective.values.alerts.nativeNotifications.value ? { sink: alertSink } : {}),
        }).catch((error) =>
          log.warn('local alert evaluation failed; will retry', { err: String(error) }),
        );
      } catch (error) {
        log.warn('health sampling failed; will retry', { err: String(error) });
      }
    };
    const scheduleHealthSample = () => {
      if (stopped) return;
      const seconds = operationalConfig().values.health.sampleIntervalSeconds.value;
      healthTimer = setTimeout(() => {
        sampleOperations();
        scheduleHealthSample();
      }, seconds * 1000);
      healthTimer.unref();
    };
    refreshHealthSampling = () => {
      if (healthTimer) clearTimeout(healthTimer);
      sampleOperations();
      scheduleHealthSample();
    };
    refreshHealthSampling();

    // Codex exposes trust through its app protocol rather than its config file. Refresh it on a
    // fixed, bounded cadence and cache the result so the five-second UI poll never spawns work.
    let trustRefreshInFlight = false;
    const refreshCodexHookTrust = () => {
      if (stopped || trustRefreshInFlight || !adapters.some((adapter) => adapter.id === 'codex'))
        return;
      trustRefreshInFlight = true;
      const controller = new AbortController();
      trustRefreshController = controller;
      void inspectCodexHookTrust(
        process.cwd(),
        process.env,
        3_000,
        controller.signal,
        runtimeVersion,
      )
        .then((result) => {
          const changed = result.trust !== codexHookTrust;
          codexHookTrust = result.trust;
          if (changed) sampleOperations();
        })
        .catch((error) => log.warn('Codex hook trust inspection failed', { err: String(error) }))
        .finally(() => {
          trustRefreshInFlight = false;
          if (trustRefreshController === controller) trustRefreshController = undefined;
        });
    };
    refreshCodexHookTrust();
    hookTrustTimer = setInterval(refreshCodexHookTrust, 5 * 60_000);
    hookTrustTimer.unref();

    const reconcileCollectionPause = () => {
      const markerExists = existsSync(join(config.home, HOOK_PAUSE_FILE));
      if (collectionPaused && markerExists && expireCollectionPause(config.home)) {
        collectionPaused = false;
        tailer.resume();
        storeTailer.resume();
        hooks.drainSpool();
        log.info('collection pause expired');
        return;
      }
      if (collectionPaused && !markerExists) {
        collectionPaused = false;
        tailer.resume();
        storeTailer.resume();
        hooks.drainSpool();
        log.info('collection resumed');
      } else if (!collectionPaused && markerExists) {
        collectionPaused = true;
        tailer.pause();
        storeTailer.pause();
        log.info('collection paused', { expiresAt: readCollectionPause(config.home)?.expiresAt });
      }
    };
    collectionControlTimer = setInterval(reconcileCollectionPause, 1000);
    collectionControlTimer.unref();
    return {
      config,
      port,
      token,
      registry,
      hooks,
      tailer,
      collectionStatus,
      operationsSnapshot,
      pauseCollection: setCollectionPaused,
      resumeCollection: setCollectionActive,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * The hook relay: a tiny POSIX shell script Claude Code / Codex run as an async command hook.
 * It POSTs the hook's stdin JSON to the daemon and, if the daemon is unreachable, atomically
 * publishes the unique pending payload as a ready spool file the daemon drains on its next start.
 * It always exits 0 so it can never surface an error in the agent's session.
 */
function shellQuote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Shell values must not contain newlines');
  return value.replace(/'/g, `'\\''`);
}

export function writeRelayScript(
  hooksDir: string,
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  const path = join(hooksDir, 'relay.sh');
  const relayPath =
    trustedPathEntries({ environment }).join(':') || '/usr/bin:/bin:/usr/sbin:/sbin';
  const truncatedPayload = JSON.stringify({
    [TRUNCATED_HOOK_PAYLOAD_KEY]: true,
    limitBytes: MAX_INGEST_PAYLOAD_BYTES,
  });
  const script = `#!/bin/sh
# Salidium hook relay, installed by \`salidium install-hooks\`. Use uninstall-hooks to disconnect it.
# Reads the hook JSON from stdin, then hands off to a detached child so the agent's process
# teardown (e.g. \`claude -p\`) can never cut the delivery short. Always exits 0.
umask 077
# Package runners prepend project-owned node_modules bins. Relay commands run only from the
# absolute, sanitized installation PATH captured when this script is written.
PATH='${shellQuote(relayPath)}'; export PATH
# Salidium's own explainer invokes a local agent CLI. That call can fire hooks like any other
# session, so without this guard the daemon would ingest its enrichment and explain the explanation.
# The variable is set only by the explainer.
[ -n "$SALIDIUM_INTERNAL" ] && exit 0
HOME_DIR='${shellQuote(home)}'
# A pause is one marker test before stdin is read. Its JSON lease is cleared by a running daemon or
# any later CLI command; the relay itself stays fork-free on this path and does not pretend to own a clock.
[ -e "$HOME_DIR/${HOOK_PAUSE_FILE}" ] && exit 0
# Event and pressure class are fixed arguments in the provider hook definition. They let the relay
# shed only explicitly declared low-fidelity observations without parsing untrusted JSON.
if [ "$1" = "--send" ] && [ "$#" -ge 5 ]; then
  EVENT="$3"; PRESSURE="$4"
else
  EVENT="\${2:-Unknown}"; PRESSURE="\${3:-retain}"
fi
# The terminal breaker is one test and no subprocess before stdin is read. It exists only after the
# ordinary queue and protected lifecycle reserve are both full.
[ -e "$HOME_DIR/${HOOK_BREAKER_FILE}" ] && exit 0
# Earlier pressure levels stop only the event class that caused them. Lifecycle events continue
# into reserved capacity instead of being discarded behind redundant tool observations.
case "$PRESSURE" in
  shed-first) [ -e "$HOME_DIR/${HOOK_SHED_FIRST_FILE}" ] && exit 0;;
  shed-second) [ -e "$HOME_DIR/${HOOK_SHED_SECOND_FILE}" ] && exit 0;;
  retain) [ -e "$HOME_DIR/${HOOK_SHED_RETAIN_FILE}" ] && exit 0;;
esac
if [ "$1" = "--send" ]; then
  PROVIDER="$2"
  if [ "$#" -ge 5 ]; then
    EVENT="$3"; PRESSURE="$4"; FILE="$5"
  else
    # Compatibility for a sender already detached while Salidium replaced the relay script.
    EVENT="Unknown"; PRESSURE="retain"; FILE="$3"
  fi
  # Bound old/external pending files too, not just stdin captured by this version of the relay.
  PAYLOAD_SIZE=$(wc -c < "$FILE" 2>/dev/null | tr -d ' ')
  case "$PAYLOAD_SIZE" in ''|*[!0-9]*) PAYLOAD_SIZE=0;; esac
  if [ "$PAYLOAD_SIZE" -gt ${MAX_INGEST_PAYLOAD_BYTES} ]; then
    printf '%s' '${shellQuote(truncatedPayload)}' > "$FILE" 2>/dev/null || exit 0
    PAYLOAD_SIZE=$(wc -c < "$FILE" 2>/dev/null | tr -d ' ')
  fi
  DAEMON_JSON="$HOME_DIR/daemon.json"; SPOOL_DIR="$HOME_DIR/spool"; PENDING="$SPOOL_DIR/pending"
  if [ -r "$DAEMON_JSON" ]; then
    PORT=$(sed -n 's/.*"port": *\\([0-9]*\\).*/\\1/p' "$DAEMON_JSON" | head -n1)
    TOKEN=$(sed -n 's/.*"token": *"\\([0-9a-f]*\\)".*/\\1/p' "$DAEMON_JSON" | head -n1)
    if [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
      # The token travels to curl via a config on stdin, never on the command line (argv is public).
      printf 'header = "Authorization: Bearer %s"\\n' "$TOKEN" | curl -fsS -m 3 -K - -o /dev/null -X POST \\
        -H "Content-Type: application/json" --data-binary "@$FILE" "http://127.0.0.1:$PORT/hooks/$PROVIDER" \\
        && rm -f "$FILE" && exit 0
    fi
  fi
  mkdir -p "$PENDING" 2>/dev/null && chmod 700 "$SPOOL_DIR" "$PENDING" 2>/dev/null
  # Every sender owns one file. Publishing it with a same-directory rename is atomic, so a drain
  # can never observe interleaved or partially-written envelopes from concurrent hooks.
  READY="\${FILE%.json}.ready.json"
  # Serialize quota observation and publication across concurrent hook processes. Without this
  # small filesystem lock, many senders can all observe one remaining slot and overrun the hard
  # physical ceiling. A timed-out contender leaves its plain .json input durable for orphan drain.
  QUOTA_LOCK="$PENDING/${HOOK_QUOTA_LOCK_FILE}"
  QUOTA_REAPING="$PENDING/${HOOK_QUOTA_REAPING_DIR}"
  QUOTA_ATTEMPTS=0
  while :; do
    set -C
    if printf '%s\n' "$$" > "$QUOTA_LOCK" 2>/dev/null; then
      set +C
      break
    fi
    set +C
    QUOTA_ATTEMPTS=$((QUOTA_ATTEMPTS + 1))
    # Only one contender may reclaim a dead owner's lock. Without this guard, a late
    # contender can unlink a replacement lock acquired after another reclaimed it.
    if mkdir "$QUOTA_REAPING" 2>/dev/null; then
      LOCK_OWNER=''
      CURRENT_OWNER=''
      if [ -r "$QUOTA_LOCK" ]; then
      IFS= read -r LOCK_OWNER < "$QUOTA_LOCK"
      case "$LOCK_OWNER" in
        ''|*[!0-9]*) ;;
        *)
          if ! kill -0 "$LOCK_OWNER" 2>/dev/null; then
            # The old process may have removed its lock while exiting. Re-read after
            # proving it dead so we never remove the next live owner's replacement.
            [ ! -r "$QUOTA_LOCK" ] || IFS= read -r CURRENT_OWNER < "$QUOTA_LOCK"
            if [ "$CURRENT_OWNER" = "$LOCK_OWNER" ]; then
              rm -f "$QUOTA_LOCK" 2>/dev/null
            fi
          fi;;
      esac
      fi
      rmdir "$QUOTA_REAPING" 2>/dev/null
    fi
    [ "$QUOTA_ATTEMPTS" -lt 5000 ] || exit 0
    sleep 0.01
  done
  release_quota_lock() {
    CURRENT_OWNER=''
    [ ! -r "$QUOTA_LOCK" ] || IFS= read -r CURRENT_OWNER < "$QUOTA_LOCK"
    if [ "$CURRENT_OWNER" = "$$" ]; then
      rm -f "$QUOTA_LOCK" 2>/dev/null
    fi
  }
  trap 'release_quota_lock' EXIT
  trap 'exit 0' HUP INT TERM
  # Measure the backlog with the shell alone. An earlier version summed every envelope with a
  # wc/tr pair per file, which made the cost of delivering one hook proportional to the queue it
  # was joining: a backlog made each sender slower, which grew the backlog. Globbing into the
  # positional parameters counts the same files with no subprocess at all. An unmatched glob stays
  # literal and reports one word, so test it before trusting the count.
  set -- "$PENDING"/*.ready.json
  [ -e "$1" ] || shift $#
  PENDING_COUNT=$#
  set -- "$PENDING"/*.ready.json.processing
  [ -e "$1" ] || shift $#
  PENDING_COUNT=$((PENDING_COUNT + $#))
  write_pressure_marker() {
    MARKER="$1"; REASON="$2"
    if [ ! -e "$MARKER" ]; then
      MARKED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
      set -C
      printf '{"reason":"%s","provider":"%s","event":"%s","pressure":"%s","firstDroppedAt":"%s","exactCount":null}\\n' \\
        "$REASON" "$PROVIDER" "$EVENT" "$PRESSURE" "$MARKED_AT" > "$MARKER" 2>/dev/null
      set +C
    fi
  }
  case "$PRESSURE" in
    shed-first)
      if [ "$PENDING_COUNT" -ge ${MAX_HOOK_SHED_FIRST_PENDING_FILES} ]; then
        write_pressure_marker "$HOME_DIR/${HOOK_SHED_FIRST_FILE}" "pressure"
        rm -f "$FILE"
        exit 0
      fi;;
    shed-second)
      if [ "$PENDING_COUNT" -ge ${MAX_HOOK_SHED_SECOND_PENDING_FILES} ]; then
        write_pressure_marker "$HOME_DIR/${HOOK_SHED_SECOND_FILE}" "pressure"
        rm -f "$FILE"
        exit 0
      fi;;
  esac
  if [ "$PENDING_COUNT" -lt ${MAX_HOOK_PENDING_FILES} ] || \\
    { [ "$PRESSURE" = "lifecycle" ] && [ "$PENDING_COUNT" -lt ${MAX_HOOK_ABSOLUTE_PENDING_FILES} ]; }; then
    mv "$FILE" "$READY" 2>/dev/null && exit 0
  fi
  if [ "$PRESSURE" = "lifecycle" ]; then
    write_pressure_marker "$HOME_DIR/${HOOK_BREAKER_FILE}" "lifecycle-reserve-full"
  else
    write_pressure_marker "$HOME_DIR/${HOOK_SHED_RETAIN_FILE}" "ordinary-capacity-full"
  fi
  rm -f "$FILE"
  exit 0
fi
PROVIDER="\${1:-claude-code}"
# Provider ids can contain the namespacing slash, but a slash in FILE creates an unintended
# directory and makes the hook silently discard its stdin. Tilde and underscore cannot occur in a valid
# provider id, so this is an injective, filename-safe encoding with an unambiguous separator.
# A provider id has at most one slash, so parameter expansion encodes it without a subprocess. The
# earlier \`printf | tr\` substitution expanded to nothing when the process table was full, and the
# envelope it named carried no provider the drain could ever attribute.
# An id with a second slash is not a provider id; its encoding would keep a slash, so refuse it.
case "$PROVIDER" in
  */*/*) exit 0;;
  */*) PROVIDER_FILE="\${PROVIDER%%/*}~\${PROVIDER#*/}";;
  *) PROVIDER_FILE="$PROVIDER";;
esac
PENDING="$HOME_DIR/spool/pending"
mkdir -p "$PENDING" 2>/dev/null && chmod 700 "$HOME_DIR/spool" "$PENDING" 2>/dev/null
FILE="$PENDING/\${PROVIDER_FILE}_$(date -u +%s)-$$-$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \\n').json"
# Read at most limit + one byte and replace an oversized record with a small valid marker. Closing
# stdin with the relay bounds work too; an attacker cannot make this hook drain an arbitrary body.
head -c ${MAX_INGEST_PAYLOAD_BYTES + 1} > "$FILE" 2>/dev/null || exit 0
PAYLOAD_SIZE=$(wc -c < "$FILE" 2>/dev/null | tr -d ' ')
case "$PAYLOAD_SIZE" in ''|*[!0-9]*) PAYLOAD_SIZE=0;; esac
if [ "$PAYLOAD_SIZE" -gt ${MAX_INGEST_PAYLOAD_BYTES} ]; then
  printf '%s' '${shellQuote(truncatedPayload)}' > "$FILE" 2>/dev/null || exit 0
fi
[ -s "$FILE" ] || { rm -f "$FILE"; exit 0; }
# Detach into a new session so the agent's teardown (which kills the hook's process group) cannot
# interrupt delivery. If detaching is unavailable the daemon still drains the pending file later.
if command -v setsid >/dev/null 2>&1; then
  setsid sh "$0" --send "$PROVIDER" "$EVENT" "$PRESSURE" "$FILE" >/dev/null 2>&1 </dev/null &
elif command -v perl >/dev/null 2>&1; then
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- sh "$0" --send "$PROVIDER" "$EVENT" "$PRESSURE" "$FILE" >/dev/null 2>&1 </dev/null &
else
  nohup sh "$0" --send "$PROVIDER" "$EVENT" "$PRESSURE" "$FILE" >/dev/null 2>&1 </dev/null &
fi
exit 0
`;
  writePrivateTextAtomic(path, script, { mode: 0o700 });
  return path;
}
