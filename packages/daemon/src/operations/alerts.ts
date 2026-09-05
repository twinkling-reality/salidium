import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EffectiveOperationalConfig,
  LocalAlert,
  LocalAlertState,
  OperationsHealthSnapshot,
} from '@salidium/protocol';
import { LocalAlertSchema, LocalAlertStateSchema } from '@salidium/protocol';
import { readJsonFile, writePrivateJsonAtomic } from './files.ts';

const MAX_RETAINED_ALERTS = 100;
const MAX_RETAINED_NOTIFICATION_KEYS = 200;

interface StoredAlertLedger {
  version: 1;
  alerts: LocalAlert[];
  notifications: Record<string, string>;
  hookTrust: Record<string, string>;
  gapFingerprint?: string;
}

const EMPTY_LEDGER: StoredAlertLedger = {
  version: 1,
  alerts: [],
  notifications: {},
  hookTrust: {},
};

export interface AlertSink {
  publish(alert: LocalAlert): void | Promise<void>;
}

export class NoopAlertSink implements AlertSink {
  publish(): void {}
}

function ledgerPath(home: string): string {
  return join(home, 'operations-alerts.json');
}

function readLedger(home: string): StoredAlertLedger {
  const path = ledgerPath(home);
  if (!existsSync(path)) return structuredClone(EMPTY_LEDGER);
  try {
    const raw = readJsonFile(path) as Partial<StoredAlertLedger>;
    if (raw.version !== 1 || !Array.isArray(raw.alerts)) return structuredClone(EMPTY_LEDGER);
    const alerts = raw.alerts.flatMap((alert) => {
      const parsed = LocalAlertSchema.safeParse(alert);
      return parsed.success ? [parsed.data] : [];
    });
    const strings = (value: unknown, limit: number): Record<string, string> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .slice(0, limit),
      );
    };
    return {
      version: 1,
      alerts: alerts.slice(0, MAX_RETAINED_ALERTS),
      notifications: strings(raw.notifications, MAX_RETAINED_NOTIFICATION_KEYS),
      hookTrust: strings(raw.hookTrust, 32),
      ...(typeof raw.gapFingerprint === 'string' ? { gapFingerprint: raw.gapFingerprint } : {}),
    };
  } catch {
    return structuredClone(EMPTY_LEDGER);
  }
}

function alertId(key: string, at: string): string {
  return createHash('sha256').update(`${key}\0${at}`).digest('hex').slice(0, 24);
}

interface Condition {
  key: string;
  kind: LocalAlert['kind'];
  severity: LocalAlert['severity'];
  title: string;
  detail: string;
}

function conditions(
  snapshot: OperationsHealthSnapshot,
  config: EffectiveOperationalConfig,
  priorHookTrust: Record<string, string>,
  priorGapFingerprint: string | undefined,
  now: Date,
): Condition[] {
  const values = config.values;
  const out: Condition[] = [];
  if (
    snapshot.queue.oldestAt &&
    now.getTime() - Date.parse(snapshot.queue.oldestAt) >=
      values.alerts.queueAgeMinutes.value * 60_000
  )
    out.push({
      key: 'queue-age',
      kind: 'queue-age',
      severity: 'warning',
      title: 'Queued work is aging',
      detail: `The oldest durable queue item is at least ${values.alerts.queueAgeMinutes.value} minutes old.`,
    });
  const velocity = snapshot.estimates.queueVelocity;
  if (
    velocity &&
    velocity.value > 0 &&
    velocity.value * (velocity.sampleWindowSeconds / 60) >= values.alerts.queueGrowthFiles.value
  )
    out.push({
      key: 'queue-growth',
      kind: 'queue-growth',
      severity: 'warning',
      title: 'The durable queue is growing',
      detail: `Net growth crossed ${values.alerts.queueGrowthFiles.value} files in the sampled window.`,
    });
  if (
    snapshot.store.totalBytes !== null &&
    snapshot.store.totalBytes >= values.alerts.databaseSizeBytes.value
  )
    out.push({
      key: 'database-size',
      kind: 'database-size',
      severity: 'notice',
      title: 'Local storage crossed its warning size',
      detail: `The SQLite store and recovery log use ${snapshot.store.totalBytes} bytes.`,
    });
  if (
    snapshot.gaps.latestFingerprint &&
    (snapshot.gaps.active > 0 || snapshot.gaps.latestFingerprint !== priorGapFingerprint)
  )
    out.push({
      key: `collection-gap:${snapshot.gaps.latestFingerprint}`,
      kind: 'collection-gap',
      severity: snapshot.gaps.active > 0 ? 'critical' : 'warning',
      title:
        snapshot.gaps.active > 0
          ? 'Collection loss is active'
          : 'A new collection gap was recorded',
      detail: 'The gap ledger changed. Exact dropped-event counts remain unavailable.',
    });
  if (snapshot.daemon.state !== 'running')
    out.push({
      key: 'daemon-health',
      kind: 'daemon-health',
      severity: snapshot.daemon.state === 'unresponsive' ? 'critical' : 'warning',
      title:
        snapshot.daemon.state === 'unresponsive'
          ? 'The daemon is not answering'
          : 'The daemon is stopped',
      detail: `Daemon state changed to ${snapshot.daemon.state}.`,
    });
  if (snapshot.maintenance?.phase === 'failure' || snapshot.maintenance?.phase === 'recovery')
    out.push({
      key: `maintenance-failure:${snapshot.maintenance.operationId}`,
      kind: 'maintenance-failure',
      severity: 'critical',
      title: 'Maintenance needs recovery',
      detail: (snapshot.maintenance.failure ?? snapshot.maintenance.message).slice(0, 500),
    });
  for (const hook of snapshot.hooks) {
    const prior = priorHookTrust[hook.id];
    const unsafe = hook.trust === 'modified' || hook.trust === 'untrusted';
    const recovering = prior === 'modified' || prior === 'untrusted';
    if (unsafe || (prior && prior !== hook.trust && hook.trust !== 'unknown' && !recovering))
      out.push({
        key: `hook-trust-change:${hook.id}`,
        kind: 'hook-trust-change',
        severity: hook.trust === 'modified' || hook.trust === 'untrusted' ? 'critical' : 'notice',
        title: `${hook.name} hook trust changed`,
        detail: `Trust changed from ${prior} to ${hook.trust}.`,
      });
  }
  return out;
}

function output(ledger: StoredAlertLedger, observedAt: string): LocalAlertState {
  const sorted = [...ledger.alerts].sort((left, right) =>
    right.lastTransitionAt.localeCompare(left.lastTransitionAt),
  );
  return LocalAlertStateSchema.parse({
    contractVersion: 1,
    observedAt,
    active: sorted.filter((alert) => alert.state !== 'recovered'),
    recent: sorted.slice(0, 50),
  });
}

/**
 * Evaluates policy transitions and persists only the deduplicated ledger. Repeated observations
 * update `lastSeenAt` but never notify again; acknowledgement remains until recovery.
 */
export async function evaluateLocalAlerts(
  home: string,
  snapshot: OperationsHealthSnapshot,
  config: EffectiveOperationalConfig,
  options: { now?: Date; sink?: AlertSink } = {},
): Promise<LocalAlertState> {
  const now = options.now ?? new Date(snapshot.observedAt);
  const at = now.toISOString();
  const sink = options.sink ?? new NoopAlertSink();
  const ledger = readLedger(home);
  const activeByKey = new Map(
    ledger.alerts
      .filter((alert) => alert.state !== 'recovered')
      .map((alert) => [alert.deduplicationKey, alert] as const),
  );
  const current = conditions(snapshot, config, ledger.hookTrust, ledger.gapFingerprint, now);
  const currentKeys = new Set(current.map((condition) => condition.key));
  const transitions: LocalAlert[] = [];
  const cooldownMs = values(config).cooldownMinutes * 60_000;

  for (const condition of current) {
    const existing = activeByKey.get(condition.key);
    if (existing) {
      existing.lastSeenAt = at;
      existing.severity = condition.severity;
      existing.title = condition.title;
      existing.detail = condition.detail;
      existing.notificationEligible = false;
      continue;
    }
    const lastNotification = Date.parse(ledger.notifications[condition.key] ?? '');
    const eligible =
      !Number.isFinite(lastNotification) || now.getTime() - lastNotification >= cooldownMs;
    const alert: LocalAlert = {
      id: alertId(condition.key, at),
      deduplicationKey: condition.key,
      kind: condition.kind,
      severity: condition.severity,
      state: 'active',
      title: condition.title,
      detail: condition.detail,
      firstSeenAt: at,
      lastSeenAt: at,
      lastTransitionAt: at,
      acknowledgedAt: null,
      recoveredAt: null,
      notificationEligible: eligible,
    };
    ledger.alerts.push(alert);
    activeByKey.set(condition.key, alert);
    if (eligible) {
      ledger.notifications[condition.key] = at;
      transitions.push(alert);
    }
  }

  for (const alert of activeByKey.values()) {
    if (currentKeys.has(alert.deduplicationKey)) continue;
    alert.state = 'recovered';
    alert.recoveredAt = at;
    alert.lastTransitionAt = at;
    alert.lastSeenAt = at;
    alert.notificationEligible = true;
    transitions.push(alert);
  }

  for (const hook of snapshot.hooks) {
    if (hook.trust !== 'unknown') ledger.hookTrust[hook.id] = hook.trust;
  }
  if (snapshot.gaps.latestFingerprint) ledger.gapFingerprint = snapshot.gaps.latestFingerprint;
  ledger.alerts.sort((left, right) => right.lastTransitionAt.localeCompare(left.lastTransitionAt));
  ledger.alerts = ledger.alerts.slice(0, MAX_RETAINED_ALERTS);
  ledger.notifications = Object.fromEntries(
    Object.entries(ledger.notifications)
      .filter(([, notifiedAt]) => {
        const timestamp = Date.parse(notifiedAt);
        return Number.isFinite(timestamp) && now.getTime() - timestamp < cooldownMs;
      })
      .sort((left, right) => right[1].localeCompare(left[1]))
      .slice(0, MAX_RETAINED_NOTIFICATION_KEYS),
  );
  writePrivateJsonAtomic(ledgerPath(home), ledger);
  for (const alert of transitions) await sink.publish(alert);
  return output(ledger, at);
}

function values(config: EffectiveOperationalConfig) {
  return {
    cooldownMinutes: config.values.alerts.cooldownMinutes.value,
  };
}

export function readLocalAlerts(home: string, now = new Date()): LocalAlertState {
  return output(readLedger(home), now.toISOString());
}

export function acknowledgeLocalAlert(home: string, id: string, now = new Date()): LocalAlertState {
  const ledger = readLedger(home);
  const alert = ledger.alerts.find((candidate) => candidate.id === id);
  if (!alert) throw new Error(`unknown alert: ${id}`);
  if (alert.state === 'active') {
    alert.state = 'acknowledged';
    alert.acknowledgedAt = now.toISOString();
    alert.lastTransitionAt = now.toISOString();
    alert.notificationEligible = false;
    writePrivateJsonAtomic(ledgerPath(home), ledger);
  }
  return output(ledger, now.toISOString());
}
