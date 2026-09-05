import { z } from 'zod';
import { ProviderIdSchema } from './provenance.ts';
import { CanonicalTimestampSchema } from './timestamps.ts';

/** Stable automation boundary for the local operations subsystem. */
export const OPERATIONS_CONTRACT_VERSION = 1 as const;
export const OPERATIONS_CONFIG_SCHEMA_VERSION = 1 as const;

export const RetentionDaysSchema = z.union([
  z.literal('forever'),
  z.literal(30),
  z.literal(90),
  z.literal(365),
]);
export type OperationsRetentionDays = z.infer<typeof RetentionDaysSchema>;

export const OperationsDetailSchema = z.enum(['summary', 'expanded']);
export type OperationsDetail = z.infer<typeof OperationsDetailSchema>;

export const OperationalConfigSettingsSchema = z
  .object({
    history: z.object({ days: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
    retention: z.object({ days: RetentionDaysSchema }).strict(),
    git: z.object({ enabled: z.boolean() }).strict(),
    providers: z.object({ enabled: z.array(ProviderIdSchema).max(32) }).strict(),
    explainer: z
      .object({
        cadence: z.enum(['off', 'session', 'turn']),
        backend: z.enum(['auto', 'claude', 'codex']),
        model: z.string().trim().min(1).max(120).nullable(),
      })
      .strict(),
    health: z
      .object({
        sampleIntervalSeconds: z.number().int().min(5).max(300),
        historyMinutes: z.number().int().min(15).max(1440),
      })
      .strict(),
    alerts: z
      .object({
        queueAgeMinutes: z.number().int().min(1).max(10_080),
        queueGrowthFiles: z.number().int().min(1).max(1_000_000),
        databaseSizeBytes: z.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER),
        cooldownMinutes: z.number().int().min(1).max(10_080),
        nativeNotifications: z.boolean(),
      })
      .strict(),
    ui: z.object({ operationsDetail: OperationsDetailSchema }).strict(),
  })
  .strict();
export type OperationalConfigSettings = z.infer<typeof OperationalConfigSettingsSchema>;

/**
 * Only explicit choices are persisted. Missing fields continue to inherit shipped defaults, which
 * lets a later release improve a default without rewriting a value the user never chose.
 */
export const StoredOperationalConfigSchema = z
  .object({
    version: z.literal(OPERATIONS_CONFIG_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    updatedAt: CanonicalTimestampSchema,
    migratedFrom: z.enum(['settings-v0', 'sqlite-retention']).optional(),
    settings: z
      .object({
        history: z
          .object({ days: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() })
          .strict()
          .optional(),
        retention: z.object({ days: RetentionDaysSchema.optional() }).strict().optional(),
        git: z.object({ enabled: z.boolean().optional() }).strict().optional(),
        providers: z
          .object({ enabled: z.array(ProviderIdSchema).max(32).optional() })
          .strict()
          .optional(),
        explainer: z
          .object({
            cadence: z.enum(['off', 'session', 'turn']).optional(),
            backend: z.enum(['auto', 'claude', 'codex']).optional(),
            model: z.string().trim().min(1).max(120).nullable().optional(),
          })
          .strict()
          .optional(),
        health: z
          .object({
            sampleIntervalSeconds: z.number().int().min(5).max(300).optional(),
            historyMinutes: z.number().int().min(15).max(1440).optional(),
          })
          .strict()
          .optional(),
        alerts: z
          .object({
            queueAgeMinutes: z.number().int().min(1).max(10_080).optional(),
            queueGrowthFiles: z.number().int().min(1).max(1_000_000).optional(),
            databaseSizeBytes: z
              .number()
              .int()
              .min(1_048_576)
              .max(Number.MAX_SAFE_INTEGER)
              .optional(),
            cooldownMinutes: z.number().int().min(1).max(10_080).optional(),
            nativeNotifications: z.boolean().optional(),
          })
          .strict()
          .optional(),
        ui: z.object({ operationsDetail: OperationsDetailSchema.optional() }).strict().optional(),
      })
      .strict(),
  })
  .strict();
export type StoredOperationalConfig = z.infer<typeof StoredOperationalConfigSchema>;

export const OperationalConfigPatchSchema = StoredOperationalConfigSchema.shape.settings.refine(
  (value) => Object.keys(value).length > 0,
  'at least one setting is required',
);
export type OperationalConfigPatch = z.infer<typeof OperationalConfigPatchSchema>;

export const ConfigValueSourceSchema = z.enum(['default', 'stored', 'environment']);
export type ConfigValueSource = z.infer<typeof ConfigValueSourceSchema>;

function effective<T extends z.ZodType>(value: T) {
  return z
    .object({
      value,
      source: ConfigValueSourceSchema,
      environment: z.string().optional(),
    })
    .strict();
}

export const EffectiveOperationalConfigSchema = z
  .object({
    contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
    schemaVersion: z.literal(OPERATIONS_CONFIG_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    observedAt: CanonicalTimestampSchema,
    /** Stored changes that a currently running daemon cannot apply without rebuilding subsystems. */
    restartRequired: z.array(z.string()),
    values: z
      .object({
        history: z
          .object({ days: effective(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)) })
          .strict(),
        retention: z.object({ days: effective(RetentionDaysSchema) }).strict(),
        git: z.object({ enabled: effective(z.boolean()) }).strict(),
        providers: z.object({ enabled: effective(z.array(ProviderIdSchema).max(32)) }).strict(),
        explainer: z
          .object({
            cadence: effective(z.enum(['off', 'session', 'turn'])),
            backend: effective(z.enum(['auto', 'claude', 'codex'])),
            model: effective(z.string().trim().min(1).max(120).nullable()),
          })
          .strict(),
        health: z
          .object({
            sampleIntervalSeconds: effective(z.number().int().min(5).max(300)),
            historyMinutes: effective(z.number().int().min(15).max(1440)),
          })
          .strict(),
        alerts: z
          .object({
            queueAgeMinutes: effective(z.number().int().min(1).max(10_080)),
            queueGrowthFiles: effective(z.number().int().min(1).max(1_000_000)),
            databaseSizeBytes: effective(
              z.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER),
            ),
            cooldownMinutes: effective(z.number().int().min(1).max(10_080)),
            nativeNotifications: effective(z.boolean()),
          })
          .strict(),
        ui: z.object({ operationsDetail: effective(OperationsDetailSchema) }).strict(),
      })
      .strict(),
  })
  .strict();
export type EffectiveOperationalConfig = z.infer<typeof EffectiveOperationalConfigSchema>;

export const MetricAvailabilitySchema = z.enum(['exact', 'unavailable']);

export const OperationsQueueMeasurementSchema = z
  .object({
    availability: MetricAvailabilitySchema,
    files: z.number().int().nonnegative().nullable(),
    bytes: z.number().int().nonnegative().nullable(),
    oldestAt: CanonicalTimestampSchema.nullable(),
    reason: z.string().optional(),
  })
  .strict();

export const OperationsStoreMeasurementSchema = z
  .object({
    availability: MetricAvailabilitySchema,
    databaseBytes: z.number().int().nonnegative().nullable(),
    walBytes: z.number().int().nonnegative().nullable(),
    totalBytes: z.number().int().nonnegative().nullable(),
    schemaVersion: z.number().int().nonnegative().nullable(),
    layoutVersion: z.number().int().nonnegative().nullable(),
    integrity: z.enum(['ok', 'failed', 'not-checked', 'unavailable']),
    retention: RetentionDaysSchema.nullable(),
    lastIngestAt: CanonicalTimestampSchema.nullable(),
  })
  .strict();

export const MaintenancePhaseSchema = z.enum([
  'idle',
  'pause',
  'drain',
  'checkpoint',
  'optimize',
  'verify',
  'resume',
  'completed',
  'failure',
  'recovery',
]);
export type MaintenancePhase = z.infer<typeof MaintenancePhaseSchema>;

export const MaintenanceStateSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().min(1),
    kind: z.enum(['queue-drain', 'storage-optimize', 'retention-compact']),
    phase: MaintenancePhaseSchema,
    startedAt: CanonicalTimestampSchema,
    updatedAt: CanonicalTimestampSchema,
    progress: z.number().min(0).max(1).nullable(),
    message: z.string().max(500),
    resumedFrom: MaintenancePhaseSchema.optional(),
    failure: z.string().max(1000).optional(),
  })
  .strict();
export type MaintenanceState = z.infer<typeof MaintenanceStateSchema>;

export const DerivedEstimateSchema = z
  .object({
    value: z.number().finite(),
    unit: z.enum(['files/minute', 'bytes/minute', 'seconds']),
    sampleWindowSeconds: z.number().positive(),
    samples: z.number().int().min(2),
    basis: z.literal('derived'),
  })
  .strict();

export const HookHealthSchema = z
  .object({
    id: ProviderIdSchema,
    name: z.string().min(1),
    detected: z.boolean(),
    configuration: z.enum(['configured', 'not-configured', 'partial', 'invalid', 'unavailable']),
    trust: z.enum(['trusted', 'untrusted', 'modified', 'managed', 'unknown', 'not-applicable']),
  })
  .strict();

export const OperationsGapSummarySchema = z
  .object({
    active: z.number().int().nonnegative(),
    recovered: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
    latestFingerprint: z.string().nullable(),
    activeEpisodes: z.array(
      z.object({
        reason: z.string(),
        provider: z.string().nullable(),
        event: z.string().nullable(),
        pressure: z.string().nullable(),
        firstDroppedAt: CanonicalTimestampSchema.nullable(),
        recoveredAt: CanonicalTimestampSchema.nullable(),
        exactCount: z.null(),
      }),
    ),
    recoveredEpisodes: z.array(
      z.object({
        reason: z.string(),
        provider: z.string().nullable(),
        event: z.string().nullable(),
        pressure: z.string().nullable(),
        firstDroppedAt: CanonicalTimestampSchema.nullable(),
        recoveredAt: CanonicalTimestampSchema.nullable(),
        exactCount: z.null(),
      }),
    ),
  })
  .strict();

export const OperationsHealthSnapshotSchema = z
  .object({
    contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
    observedAt: CanonicalTimestampSchema,
    overall: z.enum(['healthy', 'attention', 'critical']),
    daemon: z
      .object({
        state: z.enum(['running', 'unresponsive', 'stopped']),
        pid: z.number().int().positive().nullable(),
        startedAt: CanonicalTimestampSchema.nullable(),
        version: z.string().nullable(),
      })
      .strict(),
    collection: z
      .object({
        state: z.enum(['active', 'paused']),
        pausedAt: CanonicalTimestampSchema.nullable(),
        pauseExpiresAt: CanonicalTimestampSchema.nullable(),
        pauseReason: z.enum(['manual', 'stop']).nullable(),
      })
      .strict(),
    queue: OperationsQueueMeasurementSchema,
    store: OperationsStoreMeasurementSchema,
    gaps: OperationsGapSummarySchema,
    maintenance: MaintenanceStateSchema.nullable(),
    hooks: z.array(HookHealthSchema),
    estimates: z
      .object({
        queueVelocity: DerivedEstimateSchema.nullable(),
        drainRate: DerivedEstimateSchema.nullable(),
        storageGrowth: DerivedEstimateSchema.nullable(),
        timeToEmpty: DerivedEstimateSchema.nullable(),
      })
      .strict(),
    history: z
      .object({
        retentionMinutes: z.number().int().positive(),
        retainedSamples: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type OperationsHealthSnapshot = z.infer<typeof OperationsHealthSnapshotSchema>;

export const AlertKindSchema = z.enum([
  'queue-age',
  'queue-growth',
  'database-size',
  'collection-gap',
  'daemon-health',
  'maintenance-failure',
  'hook-trust-change',
]);
export type AlertKind = z.infer<typeof AlertKindSchema>;

export const LocalAlertSchema = z
  .object({
    id: z.string().min(1),
    deduplicationKey: z.string().min(1),
    kind: AlertKindSchema,
    severity: z.enum(['notice', 'warning', 'critical']),
    state: z.enum(['active', 'acknowledged', 'recovered']),
    title: z.string().min(1).max(160),
    detail: z.string().min(1).max(500),
    firstSeenAt: CanonicalTimestampSchema,
    lastSeenAt: CanonicalTimestampSchema,
    lastTransitionAt: CanonicalTimestampSchema,
    acknowledgedAt: CanonicalTimestampSchema.nullable(),
    recoveredAt: CanonicalTimestampSchema.nullable(),
    notificationEligible: z.boolean(),
  })
  .strict();
export type LocalAlert = z.infer<typeof LocalAlertSchema>;

export const LocalAlertStateSchema = z
  .object({
    contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
    observedAt: CanonicalTimestampSchema,
    active: z.array(LocalAlertSchema),
    recent: z.array(LocalAlertSchema),
  })
  .strict();
export type LocalAlertState = z.infer<typeof LocalAlertStateSchema>;

export const OperationsOverviewSchema = z
  .object({
    contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
    config: EffectiveOperationalConfigSchema,
    health: OperationsHealthSnapshotSchema,
    alerts: LocalAlertStateSchema,
  })
  .strict();
export type OperationsOverview = z.infer<typeof OperationsOverviewSchema>;

export const QueueEntrySchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().nullable(),
    state: z.enum(['ready', 'processing', 'legacy', 'quarantined']),
    bytes: z.number().int().nonnegative(),
    queuedAt: CanonicalTimestampSchema,
  })
  .strict();

export const QueueInspectionSchema = z
  .object({
    contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
    observedAt: CanonicalTimestampSchema,
    totalFiles: z.number().int().nonnegative().nullable(),
    totalBytes: z.number().int().nonnegative().nullable(),
    entries: z.array(QueueEntrySchema),
    entriesTruncated: z.boolean(),
    exactTotals: z.boolean(),
  })
  .strict();
export type QueueInspection = z.infer<typeof QueueInspectionSchema>;

export const DiagnosticManifestEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    maximumBytes: z.number().int().nonnegative(),
    redactions: z.array(z.string()),
  })
  .strict();

export const DiagnosticBundleManifestSchema = z
  .object({
    contractVersion: z.literal(OPERATIONS_CONTRACT_VERSION),
    bundleSchemaVersion: z.literal(1),
    createdAt: CanonicalTimestampSchema,
    privacy: z.literal('redacted-local-diagnostics'),
    excludes: z.array(z.string()),
    entries: z.array(DiagnosticManifestEntrySchema),
  })
  .strict();
export type DiagnosticBundleManifest = z.infer<typeof DiagnosticBundleManifestSchema>;
