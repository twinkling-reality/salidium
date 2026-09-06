import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatBytes } from '@salidium/core';
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

/*
 * A condition says both what turning on means and what turning off means.
 *
 * Only the first half used to exist, so recovery was rendered in the words that announced the
 * problem. The macOS notification prefixed "Recovered: " and kept the body, which produced
 * "Recovered: The durable queue is growing / Net growth crossed 100 files in the sampled window":
 * an all-clear that a reader can only tell from the alarm by parsing the first word. The app's
 * recovered list had no prefix at all and was distinguishable from an active alert by a CSS class.
 */
interface Condition {
  key: string;
  kind: LocalAlert['kind'];
  severity: LocalAlert['severity'];
  title: string;
  detail: string;
  recoveryTitle: string;
  recoveryDetail: string;
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
      detail: `The oldest item waiting to be stored is at least ${values.alerts.queueAgeMinutes.value} minutes old.`,
      recoveryTitle: 'Queued work is moving again',
      recoveryDetail: `Nothing has been waiting longer than ${values.alerts.queueAgeMinutes.value} minutes. No action is needed.`,
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
      title: 'Salidium is falling behind',
      detail: `Your agents are producing work faster than Salidium is storing it: ${values.alerts.queueGrowthFiles.value} more files are waiting than when this window started. Nothing is lost while it waits.`,
      recoveryTitle: 'Salidium caught up',
      recoveryDetail: 'The backlog stopped growing. No action is needed.',
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
      detail: `Salidium is using ${formatBytes(snapshot.store.totalBytes)} on this Mac, past the ${formatBytes(values.alerts.databaseSizeBytes.value)} mark. Retention is set to ${snapshot.store.retention === 'forever' ? 'keep everything forever' : `${snapshot.store.retention} days`}.`,
      recoveryTitle: 'Local storage is back under its warning size',
      /*
       * No measurement in here. Recovery wording is composed while the condition is still true and
       * refreshed only for as long as it stays true, so quoting `store.totalBytes` would put the
       * size that raised the alert into the sentence saying the alert is over: "Salidium is using
       * 5.01 GiB, below the 5.00 GiB mark". The threshold is config and does not have that problem.
       */
      recoveryDetail: `Salidium is back below ${formatBytes(values.alerts.databaseSizeBytes.value)}. Open Salidium to see the current size.`,
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
          ? 'Salidium is missing some activity'
          : 'Salidium missed some activity',
      detail:
        snapshot.gaps.active > 0
          ? 'Agent activity is happening that Salidium is not recording. Reports covering this period will be incomplete. How much was missed cannot be counted.'
          : 'A period of agent activity went unrecorded. Reports covering it will be incomplete. How much was missed cannot be counted.',
      recoveryTitle: 'Salidium is recording everything again',
      recoveryDetail:
        'Collection is complete from here on. Reports covering the earlier gap stay incomplete.',
    });
  if (snapshot.daemon.state !== 'running')
    out.push({
      key: 'daemon-health',
      kind: 'daemon-health',
      severity: snapshot.daemon.state === 'unresponsive' ? 'critical' : 'warning',
      title:
        snapshot.daemon.state === 'unresponsive'
          ? 'Salidium is not responding'
          : 'Salidium has stopped',
      detail:
        snapshot.daemon.state === 'unresponsive'
          ? 'Salidium is running but not answering. Agent activity is not being recorded while this lasts.'
          : 'Salidium is not running. Agent activity is not being recorded until it starts again.',
      recoveryTitle: 'Salidium is running again',
      recoveryDetail: 'Recording has resumed. No action is needed.',
    });
  if (snapshot.maintenance?.phase === 'failure' || snapshot.maintenance?.phase === 'recovery')
    out.push({
      key: `maintenance-failure:${snapshot.maintenance.operationId}`,
      kind: 'maintenance-failure',
      severity: 'critical',
      title: 'Maintenance did not finish',
      detail: (snapshot.maintenance.failure ?? snapshot.maintenance.message).slice(0, 500),
      recoveryTitle: 'Maintenance finished',
      recoveryDetail: 'The operation that needed attention completed. No action is needed.',
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
        title: unsafe
          ? `The ${hook.name} hook is no longer approved`
          : `The ${hook.name} hook was approved`,
        detail: unsafe
          ? `The hook file changed since you approved it (${prior} to ${hook.trust}). Salidium will not trust it until you approve the new version.`
          : `Approval state went from ${prior} to ${hook.trust}.`,
        recoveryTitle: `The ${hook.name} hook is approved again`,
        recoveryDetail: 'The hook file matches an approved version. No action is needed.',
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
      existing.recoveryTitle = condition.recoveryTitle;
      existing.recoveryDetail = condition.recoveryDetail;
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
      recoveryTitle: condition.recoveryTitle,
      recoveryDetail: condition.recoveryDetail,
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
