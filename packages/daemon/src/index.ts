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
export type {
  CodexHookTrust,
  CodexHookTrustInspection,
} from './ingest/codexHookTrust.ts';
export {
  inspectCodexHookTrust,
  MAX_CODEX_HOOK_TRUST_OUTPUT_BYTES,
  summarizeCodexHookTrustResponse,
} from './ingest/codexHookTrust.ts';
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
export type { AlertSink } from './operations/alerts.ts';
export {
  acknowledgeLocalAlert,
  evaluateLocalAlerts,
  NoopAlertSink,
  readLocalAlerts,
} from './operations/alerts.ts';
export type {
  OperationalConfigBackend,
  OperationalConfigKey,
  OperationalConfigRead,
} from './operations/configuration.ts';
export {
  createFileOperationalConfigBackend,
  DEFAULT_OPERATIONAL_CONFIG,
  isOperationalConfigKey,
  migrateOperationalConfig,
  migrateRetentionPolicy,
  OPERATIONAL_CONFIG_KEYS,
  operationalConfigPaths,
  readOperationalConfig,
  resetOperationalConfig,
  resolveOperationalConfig,
  setOperationalConfigValue,
  updateOperationalConfig,
} from './operations/configuration.ts';
export type {
  DiagnosticBundleInput,
  DiagnosticBundleResult,
  DiagnosticRedaction,
} from './operations/diagnostics.ts';
export {
  createDiagnosticBundle,
  diagnosticManifest,
  MAX_DIAGNOSTIC_LOG_BYTES,
  redactDiagnosticValue,
} from './operations/diagnostics.ts';
export {
  calculateHealthEstimates,
  collectionStatusFromHealth,
  createHealthSnapshot,
  inspectQueue,
  MAX_HEALTH_SAMPLES,
  MAX_QUEUE_STATUS_FILES,
  retainHealthSample,
  sampleFromSnapshot,
} from './operations/health.ts';
export type {
  MaintenanceLock,
  QueueDrainResult,
  StorageOptimizationPreflight,
} from './operations/maintenance.ts';
export {
  acquireMaintenanceLock,
  maintenancePaths,
  readMaintenanceState,
  runQueueDrainMaintenance,
  runRetentionCompactionMaintenance,
  runStorageOptimizationMaintenance,
  storageOptimizationPreflight,
  transitionMaintenance,
} from './operations/maintenance.ts';
export {
  NativeAlertSink,
  type NativeNotificationInvocation,
  type NativeNotificationOptions,
  resolveNativeNotification,
} from './operations/nativeNotifications.ts';
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
  HealthHistorySample,
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
