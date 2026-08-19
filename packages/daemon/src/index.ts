export type { DaemonConfig } from './config/daemonConfig.ts';
export {
  DEFAULT_HISTORY_DAYS,
  DEFAULT_PORT,
  daemonPaths,
  resolveDaemonConfig,
  validateSalidiumHistoryDays,
} from './config/daemonConfig.ts';
export type { DaemonHandle, DaemonJson, StartDaemonOptions } from './daemon.ts';
export {
  defaultUiDist,
  readDaemonJson,
  readSettings,
  startDaemon,
  writeRelayScript,
} from './daemon.ts';
export type {
  ExplainerBackend,
  ExplainerBackendRequest,
  ExplainerBackendResult,
  ExplainerMode,
  ExplainerStatus,
} from './enrich/explainerBackends.ts';
export { getExplainerStatus } from './enrich/explainerBackends.ts';
export {
  DEFAULT_LOG_FILES,
  DEFAULT_LOG_MAX_BYTES,
  rotateLogFile,
} from './logging/logger.ts';
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
  INGEST_PARSER_REVISION,
  SCHEMA_VERSION,
  SqliteStore,
} from './storage/sqliteStore.ts';
