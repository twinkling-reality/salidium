import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statfsSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { claudeCodeProvider } from '@salidium/adapter-claude-code';
import { codexProvider } from '@salidium/adapter-codex';
import { type ProviderDescriptor, ProviderRegistry } from '@salidium/adapter-kit';
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
  connectBuiltInHooks,
  disconnectBuiltInHooks,
  type HookConfigurationInspection,
  inspectBuiltInHooks,
} from './ingest/hookConfiguration.ts';
import { HookIngress } from './ingest/hookIngress.ts';
import { HOOK_PAUSE_FILE } from './ingest/limits.ts';
import { writeRelayScript } from './ingest/relayScript.ts';
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
import { writePrivateJsonAtomic } from './operations/files.ts';
import {
  createHealthSnapshot,
  inspectQueue,
  oldestWaitingAt,
  retainHealthSample,
} from './operations/health.ts';
import {
  readMaintenanceState,
  runQueueDrainMaintenance,
  runRetentionCompactionMaintenance,
} from './operations/maintenance.ts';
import { NativeAlertSink } from './operations/nativeNotifications.ts';
import { ProjectMapCache } from './projectMap/cache.ts';
import { locateObjectStore } from './projectMap/gitObjects.ts';
import { mainRootOf } from './projectMap/mainRoot.ts';
import { allowRepository, listOptedInRepositories, revokeRepository } from './projectMap/optIn.ts';
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
      if (compositionWorker !== worker) return;
      composition = message;
    });
    worker.once('error', (error) => {
      if (compositionWorker !== worker) return;
      log.warn('storage composition worker failed', { err: String(error) });
      composition = { ...composition, state: 'failed', failure: String(error).slice(0, 500) };
    });
    worker.once('exit', (code) => {
      if (compositionWorker !== worker) return;
      compositionWorker = undefined;
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
    // Links never serves a session the consumer contract leaves out.
    represents: (summary) => consumer.represents(summary),
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
      connect: (provider) => {
        if (provider !== 'claude-code' && provider !== 'codex') return undefined;
        writeRelayScript(paths.hooksDir, config.home);
        connectBuiltInHooks(provider, config.userHome, config.home);
        return collectionStatus();
      },
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
      previewStorageDeletion: (scope) => registry.previewDeletion(scope),
      deleteStorage: (scope, expectedSessions) => {
        const outcome = registry.deleteSessions(scope, expectedSessions);
        if (outcome.status === 'deleted') {
          if (scope.kind === 'retention') {
            configBackend.update({ retention: { days: scope.days } });
            applyOperationalConfig();
          }
          if (compositionWorker) {
            const running = compositionWorker;
            compositionWorker = undefined;
            void running.terminate();
            analyzeStorage();
          } else if (composition.state === 'ready') {
            analyzeStorage();
          }
          refreshHealthSampling?.();
        }
        return outcome;
      },
      compactStorage: async () => {
        if (store.usageBackfillProgress?.().complete === false) {
          throw new Error('historical usage preparation must finish before compacting the store');
        }
        if (existsSync(paths.db)) {
          const walPath = `${paths.db}-wal`;
          const dbBytes = statSync(paths.db).size;
          const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
          const free = statfsSync(paths.db);
          const freeBytes = Number(free.bavail) * Number(free.bsize);
          const requiredBytes =
            dbBytes + walBytes + Math.ceil(Math.max(64 * 1024 * 1024, dbBytes * 0.1));
          if (freeBytes < requiredBytes) {
            throw new Error(
              `compaction needs at least ${Math.ceil(requiredBytes / (1024 * 1024))} MiB free on disk`,
            );
          }
        }
        const wasMeasuring = composition.state === 'ready' || composition.state === 'running';
        if (compositionWorker) {
          const running = compositionWorker;
          compositionWorker = undefined;
          await running.terminate();
        }
        if (usageBackfillRetryTimer) {
          clearTimeout(usageBackfillRetryTimer);
          usageBackfillRetryTimer = undefined;
        }
        if (usageBackfillWorker) {
          const running = usageBackfillWorker;
          usageBackfillWorker = undefined;
          await running.terminate();
        }
        const wasPaused = readCollectionPause(config.home) !== null;
        if (!wasPaused) setCollectionPaused('manual');
        registry.flushAll();
        let beforeBytes = 0;
        let afterBytes = 0;
        try {
          const measure = () => {
            let total = 0;
            for (const file of [paths.db, `${paths.db}-wal`]) {
              try {
                total += statSync(file).size;
              } catch {
                /* absent */
              }
            }
            return total;
          };
          const measuredBefore = measure();
          beforeBytes = measuredBefore;
          runRetentionCompactionMaintenance(config.home, () => {
            const res = store.compact();
            if (res) {
              beforeBytes = Math.max(measuredBefore, res.beforeBytes);
              afterBytes = res.afterBytes;
            }
          });
          if (afterBytes === 0) afterBytes = measure();
        } finally {
          if (!wasPaused) setCollectionActive();
        }
        if (wasMeasuring) analyzeStorage();
        refreshHealthSampling?.();
        return {
          contractVersion: OPERATIONS_CONTRACT_VERSION,
          beforeBytes,
          afterBytes,
        };
      },
    },
    projectMapRepositories: {
      allow: async (target) => {
        const root = await mainRootOf(resolve(target));
        if (!root) {
          throw new Error(`${target} is not inside a Git repository Salidium can read`);
        }
        const { gitDir } = await locateObjectStore(root);
        const allowed = allowRepository(config.home, root, gitDir);
        return {
          root: allowed.repository.root,
          allowedAt: allowed.repository.allowedAt,
          added: allowed.added,
        };
      },
      revoke: async (target) => {
        const repositories = listOptedInRepositories(config.home);
        const absolute = resolve(target);
        const root = repositories.some((r) => r.root === absolute)
          ? absolute
          : await mainRootOf(absolute);
        const record = repositories.find((r) => r.root === root);
        if (!root || !record || !revokeRepository(config.home, root)) return false;
        new ProjectMapCache(config.home).forget(record);
        return true;
      },
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
        if (usageBackfillWorker !== worker) return;
        usageBackfillWorker = undefined;
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

export { writeRelayScript } from './ingest/relayScript.ts';
