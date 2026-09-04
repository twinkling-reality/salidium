export type { DaemonConfig } from './config/daemonConfig.ts';
export {
  DEFAULT_HISTORY_DAYS,
  DEFAULT_PORT,
  daemonPaths,
  resolveDaemonConfig,
  validateSalidiumHistoryDays,
} from './config/daemonConfig.ts';
export type { DaemonHandle, DaemonJson, StartDaemonOptions, StoredSettings } from './daemon.ts';
export {
  defaultUiDist,
  readDaemonJson,
  readSettings,
  startDaemon,
  writeRelayScript,
  writeSettings,
} from './daemon.ts';
export type {
  ExplainerBackend,
  ExplainerBackendRequest,
  ExplainerBackendResult,
  ExplainerMode,
  ExplainerStatus,
} from './enrich/explainerBackends.ts';
export { getExplainerStatus } from './enrich/explainerBackends.ts';
export type { CollectionPause } from './ingest/collectionState.ts';
export {
  expireCollectionPause,
  observeCollectionStatus,
  pauseCollection,
  readCollectionPause,
  resumeCollection,
} from './ingest/collectionState.ts';
export type {
  BuiltInHookProvider,
  HookConfigurationInspection,
  HookConfigurationStatus,
} from './ingest/hookConfiguration.ts';
export { inspectBuiltInHooks } from './ingest/hookConfiguration.ts';
export { HOOK_PAUSE_FILE, HOOK_PAUSE_LEASE_MS } from './ingest/limits.ts';
export {
  DEFAULT_LOG_FILES,
  DEFAULT_LOG_MAX_BYTES,
  rotateLogFile,
} from './logging/logger.ts';
export { effectiveCadence } from './sessions/sessionCoordinator.ts';
export type {
  StoreLayoutInspection,
  StoreOptimizationOptions,
  StoreOptimizationResult,
} from './storage/optimizeStore.ts';
export { inspectStoreLayout, optimizeStoreLayout } from './storage/optimizeStore.ts';
export type {
  AuditMessageRow,
  CheckpointRow,
  RawRecordFingerprint,
  ReingestJob,
  RetentionDays,
  RetentionPreview,
  SalidiumStore,
  SalidiumStoreFactory,
  SessionSearchResult,
  SourceCursor,
  UsageTotals,
} from './storage/salidiumStore.ts';
export {
  createSqliteStore,
  EVENT_COMPRESS_MIN_BYTES,
  INGEST_PARSER_REVISION,
  MAX_RAW_FINGERPRINT_CONFLICTS,
  OPTIMIZED_STORE_PAGE_SIZE,
  SCHEMA_VERSION,
  SqliteStore,
  STORAGE_LAYOUT_VERSION,
} from './storage/sqliteStore.ts';
