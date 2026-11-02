import { existsSync, statfsSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { formatBytes } from '@salidium/core';
import {
  acknowledgeLocalAlert,
  collectionStatusFromHealth,
  daemonPaths,
  inspectQueue,
  readDaemonJson,
  readMaintenanceState,
  runRetentionCompactionMaintenance,
  runStorageOptimizationMaintenance,
  SqliteStore,
  storageOptimizationPreflight,
} from '@salidium/daemon';
import type {
  LocalAlertState,
  OperationsHealthSnapshot,
  QueueInspection,
} from '@salidium/protocol';
import { inspectMacOSService } from '../macosService.ts';
import {
  collectionStatus,
  configuredHookPresent,
  currentExplanationState,
  ensureDaemon,
  explanationStateLabel,
  hookStatusLabel,
  hookTrustLabel,
  observeProviders,
  type ProviderObservation,
  presenceOf,
  readOperationsOverview,
  retentionLabel,
  salidiumHome,
  setCollectionState,
  stopDaemon,
  userHome,
} from './shared.ts';

/*
 * An absent estimate says which of the two reasons it is absent for.
 *
 * Everything null read "Unavailable (needs at least two exact samples)", which for the drain rate
 * was printed directly under a velocity line reporting eighty-four of them. `drainRate` is null
 * whenever the queue is not shrinking, and `timeToEmpty` whenever it is not shrinking or is
 * already empty; neither has anything to do with how many samples there are.
 */
export function estimateLabel(
  estimate: OperationsHealthSnapshot['estimates']['queueVelocity'],
  absent = 'Unavailable (needs two measurements)',
): string {
  if (!estimate) return absent;
  const value =
    estimate.unit === 'bytes/minute'
      ? `${formatBytes(Math.abs(estimate.value))}/minute`
      : Math.abs(estimate.value).toFixed(1);
  /*
   * The sign comes from the number as shown, not the number as measured. A velocity of -0.004
   * files per minute is negative and rounds to 0.0, which printed as "−0.0 files/minute".
   */
  const zero = /^[0.]+(?: B\/minute)?$/.test(value);
  const sign = zero ? '' : estimate.value < 0 ? '−' : '+';
  const unit = estimate.unit === 'bytes/minute' ? '' : ` ${estimate.unit}`;
  return `${sign}${value}${unit} · derived from ${estimate.samples} samples over ${Math.round(estimate.sampleWindowSeconds)}s`;
}

export function maintenancePhaseLabel(phase: string): string {
  if (phase === 'failure') return 'Did not finish';
  if (phase === 'recovery') return 'Recovering';
  if (phase === 'completed') return 'Finished';
  if (phase === 'running') return 'Running';
  return phase;
}

/** Both halves are labelled projections: a rate measured over an hour does not run overnight. */
export function storageProjection(
  total: number | null,
  growth: OperationsHealthSnapshot['estimates']['storageGrowth'],
  warnAt: number,
): string {
  const parts: string[] = [];
  if (growth && growth.value > 0)
    parts.push(`about ${formatBytes(growth.value * 60 * 24)} a day at this rate`);
  if (total !== null) {
    const mark = formatBytes(warnAt);
    const room = formatBytes(warnAt - total);
    parts.push(
      total >= warnAt
        ? `past its ${mark} warning mark`
        : room === mark
          ? `warns at ${mark}`
          : `${room} below its ${mark} warning mark`,
    );
  }
  return parts.join(' · ');
}

export async function statusCommand(options: {
  json: boolean;
  quiet: boolean;
  watch: boolean;
  intervalSeconds: number;
}): Promise<number> {
  if (
    !Number.isFinite(options.intervalSeconds) ||
    options.intervalSeconds < 0.5 ||
    options.intervalSeconds > 60
  ) {
    process.stderr.write('--interval must be from 0.5 to 60 seconds\n');
    return 2;
  }
  let interrupted = false;
  let wakeWatch: (() => void) | undefined;
  const interrupt = () => {
    interrupted = true;
    wakeWatch?.();
  };
  if (options.watch) process.once('SIGINT', interrupt);
  let lastExit = 0;
  let providers: ProviderObservation[] = [];
  let nextProviderInspectionAt = 0;
  const service = inspectMacOSService({ home: salidiumHome, userHome });
  try {
    do {
      const daemon = readDaemonJson(salidiumHome);
      const presence = await presenceOf(daemon);
      const explanations = await currentExplanationState(daemon, presence);
      if (Date.now() >= nextProviderInspectionAt) {
        providers = await observeProviders();
        nextProviderInspectionAt = Date.now() + 5 * 60_000;
      }
      const operations = await readOperationsOverview(daemon, presence, providers);
      const collection = collectionStatusFromHealth(operations.health);
      lastExit =
        presence === 'unresponsive'
          ? 1
          : operations.health.overall === 'critical'
            ? 4
            : presence === 'reachable'
              ? 0
              : 1;
      if (options.quiet) return lastExit;
      if (options.watch && process.stdout.isTTY && !options.json)
        process.stdout.write('\u001b[2J\u001b[H');
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({
            contractVersion: 1,
            daemon:
              daemon && presence !== 'absent'
                ? { ...daemon, token: undefined, presence }
                : { presence },
            collection,
            explanations,
            service,
            providers,
            operations,
          })}\n`,
        );
      } else {
        const health = operations.health;
        const sizeClause =
          health.store.totalBytes !== null
            ? ` · ${formatBytes(health.store.totalBytes)} of session history`
            : '';
        process.stdout.write(
          health.daemon.state === 'running'
            ? health.collection.state === 'active'
              ? `Salidium keeps running in the background${sizeClause}; see it in the menu bar or here, and stop it with \`salidium stop\`${service.installed && service.enabled ? ' or `salidium service disable`' : ''}.\n`
              : `Salidium is running in the background with collection paused${sizeClause}; resume with \`salidium resume\` or stop with \`salidium stop\`.\n`
            : health.daemon.state === 'unresponsive'
              ? `Salidium is running in the background (pid ${health.daemon.pid}) and catching up${sizeClause}.\n`
              : `Salidium is stopped${sizeClause}. Start it with \`salidium\` or manage storage with \`salidium storage\`.\n`,
        );
        /*
         * One line about the daemon, in one shape.
         *
         * A stopped daemon printed a bare "not running" and then "Daemon: Stopped" directly under
         * it, and an unresponsive one changed the label itself to "Daemon running:" so the colon
         * fell in a different column than the six lines below it. The bare line existed because
         * `daemonLaunch.test.ts` asserted on it; what that test is for is that `status` reports a
         * dead daemon, which "Daemon: Stopped" says on its own.
         */
        process.stdout.write(
          health.daemon.state === 'running'
            ? `Daemon: Running · pid ${health.daemon.pid} · since ${health.daemon.startedAt}\n`
            : health.daemon.state === 'unresponsive'
              ? `Daemon: Not answering · pid ${health.daemon.pid}\n`
              : 'Daemon: Stopped\n',
        );
        process.stdout.write(
          daemon && presence !== 'absent'
            ? `Local endpoint: http://127.0.0.1:${daemon.port} · state ${salidiumHome}\n`
            : `State directory: ${salidiumHome}\n`,
        );
        if (service.supported)
          process.stdout.write(
            service.installed
              ? `Always-on: ${service.enabled ? 'Enabled' : 'Disabled'} · daemon ${service.daemonLoaded ? 'loaded' : 'not loaded'} · menu bar ${service.menuLoaded ? 'loaded' : 'not loaded'}\n`
              : 'Always-on: Not installed · enable with salidium service install\n',
          );
        process.stdout.write(
          `Collection: ${health.collection.state === 'active' ? 'Active' : `Paused${health.collection.pauseExpiresAt ? ` until ${health.collection.pauseExpiresAt}` : ''}`}\n`,
        );
        process.stdout.write(
          health.queue.availability === 'exact'
            ? `Queue (exact): ${(health.queue.files ?? 0).toLocaleString()} files, ${formatBytes(health.queue.bytes ?? 0)}${health.queue.oldestAt ? `, oldest ${health.queue.oldestAt}` : ''}\n`
            : `Queue: Unavailable · ${health.queue.reason ?? 'exact scan could not complete'}\n`,
        );
        process.stdout.write(
          `Store (exact): ${health.store.totalBytes === null ? 'Unavailable' : formatBytes(health.store.totalBytes)}, retention ${retentionLabel(health.store.retention)}, last ingest ${health.store.lastIngestAt ?? 'Unavailable'}\n`,
        );
        /*
         * How fast the store is filling, and how much room is left before the warning.
         *
         * "Storage growth (estimate): +499.8 KiB/minute" was already printed four lines down and
         * is a number nobody can act on: it does not say whether that is a megabyte a week or a
         * gigabyte a day. Retention defaults to keeping everything and the only other signal is an
         * alert that fires at 5 GB, which arrives once there are already 5 GB.
         */
        const projection = storageProjection(
          health.store.totalBytes,
          health.estimates.storageGrowth,
          operations.config.values.alerts.databaseSizeBytes.value,
        );
        if (projection) process.stdout.write(`Store outlook: ${projection}\n`);
        process.stdout.write(
          `Queue velocity (estimate): ${estimateLabel(health.estimates.queueVelocity)}\n`,
        );
        const sampled = health.estimates.queueVelocity !== null;
        const notShrinking = 'Unavailable (the queue is not shrinking)';
        process.stdout.write(
          `Drain rate (estimate): ${estimateLabel(
            health.estimates.drainRate,
            sampled ? notShrinking : undefined,
          )}\n`,
        );
        process.stdout.write(
          `Storage growth (estimate): ${estimateLabel(health.estimates.storageGrowth)}\n`,
        );
        process.stdout.write(
          `Time to empty (estimate): ${
            health.estimates.timeToEmpty
              ? `${Math.round(health.estimates.timeToEmpty.value)} seconds · derived`
              : health.queue.files === 0
                ? 'Already empty'
                : sampled
                  ? notShrinking
                  : 'Unavailable (needs two measurements)'
          }\n`,
        );
        process.stdout.write(
          `Health: ${health.overall === 'critical' ? 'Critical' : health.overall === 'attention' ? 'Needs attention' : 'Healthy'}\n`,
        );
        process.stdout.write(`Explanations: ${explanationStateLabel(explanations)}\n`);
        process.stdout.write(
          `Maintenance: ${health.maintenance ? `${maintenancePhaseLabel(health.maintenance.phase)} · ${health.maintenance.message}` : 'Idle'}\n`,
        );
        if (health.historyUpdate)
          process.stdout.write(
            `Updating session history: ${health.historyUpdate.sessionsUpdated} of ${health.historyUpdate.sessionsTotal}${health.historyUpdate.state === 'paused' ? ' (paused)' : ''}\n`,
          );
        process.stdout.write(
          `Alerts: ${operations.alerts.active.length} active${operations.alerts.active.some((alert) => alert.state === 'acknowledged') ? ' (some acknowledged)' : ''}\n`,
        );
        process.stdout.write(
          `Desktop notifications: ${operations.config.values.alerts.nativeNotifications.value ? 'On' : 'Off'}\n`,
        );
        for (const provider of providers) {
          const label = !provider.detected
            ? 'Not detected'
            : !provider.liveHooksSupported
              ? 'History only; live hooks unavailable on native Windows'
              : hookStatusLabel(provider.hookStatus);
          const trust =
            provider.id === 'codex' && provider.hookStatus !== 'not-configured'
              ? `; trust ${hookTrustLabel(provider.hookTrust)}`
              : '';
          process.stdout.write(`${provider.name}: ${label}${trust}\n`);
        }
        if (health.gaps.active || health.gaps.recovered)
          process.stdout.write(
            `Collection gaps: ${health.gaps.active} active, ${health.gaps.recovered} recovered, ${health.gaps.omitted} older episodes omitted; exact dropped event counts unavailable\n`,
          );
        if (operations.config.restartRequired.length)
          process.stdout.write(
            `Restart required for: ${operations.config.restartRequired.join(', ')}\n`,
          );
        if (!options.watch)
          process.stdout.write(
            'Control: salidium open · salidium status --watch · salidium pause|resume|stop\n',
          );
      }
      if (!options.watch || interrupted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.intervalSeconds * 1000);
        wakeWatch = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wakeWatch = undefined;
    } while (!interrupted);
  } finally {
    if (options.watch) process.off('SIGINT', interrupt);
  }
  return lastExit;
}

export async function maintenanceCommand(
  action: string | undefined,
  args: string[],
  options: { json: boolean; quiet: boolean },
): Promise<number> {
  const command = action ?? 'status';
  const daemon = readDaemonJson(salidiumHome);
  const presence = await presenceOf(daemon);
  if (command === 'status') {
    const state = readMaintenanceState(salidiumHome);
    if (!options.quiet)
      process.stdout.write(
        options.json
          ? `${JSON.stringify(state)}\n`
          : state
            ? `${state.phase}: ${state.message}\n`
            : 'Maintenance: idle\n',
      );
    return state?.phase === 'failure' || state?.phase === 'recovery' ? 3 : 0;
  }
  if (command === 'queue') {
    const asked = args.find((value) => value.startsWith('--limit='))?.slice(8);
    const limit = asked === undefined ? 25 : Number(asked);
    if (!Number.isFinite(limit) || limit < 0 || limit > 200) {
      process.stderr.write('--limit must be from 0 to 200\n');
      return 2;
    }
    let queue: QueueInspection;
    if (daemon && presence === 'reachable') {
      const response = await fetch(
        `http://127.0.0.1:${daemon.port}/api/operations/queue?limit=${Math.trunc(limit)}`,
        {
          headers: { Authorization: `Bearer ${daemon.token}` },
          signal: AbortSignal.timeout(2_000),
        },
      );
      if (!response.ok) throw new Error(`daemon refused queue inspection (${response.status})`);
      queue = (await response.json()) as QueueInspection;
    } else queue = inspectQueue(salidiumHome, { entryLimit: Math.trunc(limit) });
    if (!options.quiet) {
      if (options.json) process.stdout.write(`${JSON.stringify(queue)}\n`);
      else {
        process.stdout.write(
          queue.exactTotals
            ? `Queue: ${queue.totalFiles} files, ${formatBytes(queue.totalBytes ?? 0)} (exact)\n`
            : 'Queue totals unavailable; the scan safety ceiling was reached.\n',
        );
        if (queue.quarantinedFiles)
          process.stdout.write(
            `Quarantined: ${queue.quarantinedFiles} files, ${formatBytes(queue.quarantinedBytes ?? 0)} kept as evidence; a drain will not store them\n`,
          );
        for (const entry of queue.entries)
          process.stdout.write(
            `${entry.queuedAt}  ${String(entry.provider ?? 'unknown').padEnd(12)} ${entry.state.padEnd(10)} ${formatBytes(entry.bytes)}  ${entry.id}\n`,
          );
        if (queue.entriesTruncated)
          process.stdout.write('Older queue metadata omitted from this view.\n');
      }
    }
    return queue.exactTotals ? 0 : 3;
  }
  if (command === 'drain') {
    if (!daemon || presence !== 'reachable') {
      process.stderr.write(
        'start Salidium before draining; only the daemon can make queued input durable\n',
      );
      return 1;
    }
    const waitRaw = args.find((value) => value.startsWith('--wait='))?.slice(7);
    const waitSeconds = waitRaw === undefined ? 30 : Number(waitRaw);
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 300) {
      process.stderr.write('--wait must be from 0 to 300 seconds\n');
      return 2;
    }
    const deadline = Date.now() + waitSeconds * 1000;
    let result:
      | {
          state: unknown;
          before: { totalFiles: number | null };
          after: { totalFiles: number | null };
        }
      | undefined;
    for (;;) {
      const response = await fetch(
        `http://127.0.0.1:${daemon.port}/api/operations/maintenance/drain`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${daemon.token}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) throw new Error(`daemon refused queue drain (${response.status})`);
      const next = (await response.json()) as NonNullable<typeof result>;
      result = next;
      if (next.after.totalFiles === 0 || Date.now() >= deadline) break;
      await sleep(100);
    }
    if (!result) throw new Error('queue drain returned no result');
    if (!options.quiet)
      process.stdout.write(
        options.json
          ? `${JSON.stringify(result)}\n`
          : `Queue drain: ${result.before.totalFiles ?? 'unknown'} → ${result.after.totalFiles ?? 'unknown'} files. No queued file was discarded.\n`,
      );
    return result.after.totalFiles === 0 ? 0 : 3;
  }
  if (command === 'optimize') {
    const dryRun = args.includes('--dry-run');
    if (dryRun) {
      const preview = storageOptimizationPreflight(salidiumHome);
      if (!options.quiet)
        process.stdout.write(
          options.json
            ? `${JSON.stringify(preview)}\n`
            : `Optimization preview: ${preview.beforeBytes} bytes; needs ${preview.requiredFreeBytes} free; ${preview.queue.totalFiles ?? 'unknown'} queued files. ${preview.canRun ? 'Ready.' : `Blocked: ${preview.blockers.join('; ')}.`}\n`,
        );
      return preview.canRun ? 0 : 3;
    }
    if (presence === 'unresponsive') {
      process.stderr.write(
        'the daemon is running but not answering; stop Salidium before offline maintenance\n',
      );
      return 2;
    }
    let restart = false;
    let resume = false;
    let exitCode = 0;
    try {
      if (daemon && presence === 'reachable') {
        restart = true;
        const current = await collectionStatus(daemon, presence, configuredHookPresent());
        resume = current.state === 'active';
        const drained = await maintenanceCommand('drain', ['--wait=60'], {
          json: false,
          quiet: true,
        });
        if (drained !== 0) throw new Error('the durable queue did not empty before the deadline');
        await setCollectionState('pause', 'manual');
        const stopped = await stopDaemon();
        if (!stopped?.signaled || !stopped.exited)
          throw new Error('the daemon did not stop cleanly');
      }
      const result = runStorageOptimizationMaintenance(salidiumHome, {
        onProgress:
          options.quiet || options.json
            ? undefined
            : (message) => process.stdout.write(`${message}…\n`),
      });
      if (!options.quiet)
        process.stdout.write(
          options.json
            ? `${JSON.stringify(result)}\n`
            : result.alreadyOptimized
              ? 'Storage is already optimized.\n'
              : `Optimized ${result.eventRows.toLocaleString()} events from ${formatBytes(result.beforeBytes)} to ${formatBytes(result.afterBytes)}; row counts, logical digests, and integrity matched.\n`,
        );
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      exitCode = 2;
    } finally {
      if (restart) {
        try {
          await ensureDaemon();
          if (resume) await setCollectionState('resume');
        } catch (error) {
          process.stderr.write(
            `maintenance finished, but daemon restart failed: ${String(error)}\n`,
          );
          exitCode = 2;
        }
      }
    }
    return exitCode;
  }
  if (command === 'compact') {
    const { db } = daemonPaths(salidiumHome);
    if (!existsSync(db)) {
      process.stderr.write(`no store at ${db}\n`);
      return 1;
    }
    if (presence === 'unresponsive') {
      process.stderr.write(
        'the daemon is running but not answering; stop Salidium before offline maintenance\n',
      );
      return 2;
    }
    const walPath = `${db}-wal`;
    const dbBytes = statSync(db).size;
    const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
    const free = statfsSync(db);
    const freeBytes = Number(free.bavail) * Number(free.bsize);
    const requiredBytes = dbBytes + walBytes + Math.max(64 * 1024 * 1024, dbBytes * 0.1);
    if (freeBytes < requiredBytes) {
      process.stderr.write(
        `compaction needs about ${formatBytes(requiredBytes)} free; only ${formatBytes(freeBytes)} is available\n`,
      );
      return 2;
    }
    let restart = false;
    let resume = false;
    let exitCode = 0;
    try {
      if (daemon && presence === 'reachable') {
        restart = true;
        const current = await collectionStatus(daemon, presence, configuredHookPresent());
        resume = current.state === 'active';
        if (!options.quiet && !options.json) {
          process.stdout.write(
            'Pausing collection and stopping the background daemon briefly to compact storage…\n',
          );
        }
        const drained = await maintenanceCommand('drain', ['--wait=60'], {
          json: false,
          quiet: true,
        });
        if (drained !== 0) throw new Error('the durable queue did not empty before the deadline');
        await setCollectionState('pause', 'manual');
        const stopped = await stopDaemon();
        if (!stopped?.signaled || !stopped.exited)
          throw new Error('the daemon did not stop cleanly');
      }
      const beforeBytes = statSync(db).size + (existsSync(walPath) ? statSync(walPath).size : 0);
      const store = new SqliteStore(db);
      try {
        runRetentionCompactionMaintenance(salidiumHome, () => {
          store.compact();
        });
      } finally {
        store.close();
      }
      const afterBytes = statSync(db).size;
      if (!options.quiet) {
        process.stdout.write(
          options.json
            ? `${JSON.stringify({ contractVersion: 1, beforeBytes, afterBytes })}\n`
            : `Compacted storage from ${formatBytes(beforeBytes)} to ${formatBytes(afterBytes)}.\n`,
        );
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      exitCode = 2;
    } finally {
      if (restart) {
        try {
          await ensureDaemon();
          if (resume) await setCollectionState('resume');
        } catch (error) {
          process.stderr.write(
            `maintenance finished, but daemon restart failed: ${String(error)}\n`,
          );
          exitCode = 2;
        }
      }
    }
    return exitCode;
  }
  if (command === 'acknowledge') {
    const id = args[0];
    if (!id) {
      process.stderr.write('usage: salidium maintenance acknowledge ALERT_ID\n');
      return 2;
    }
    let alerts: LocalAlertState;
    if (daemon && presence === 'reachable') {
      const response = await fetch(
        `http://127.0.0.1:${daemon.port}/api/operations/alerts/${encodeURIComponent(id)}/acknowledge`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${daemon.token}` },
          signal: AbortSignal.timeout(2_000),
        },
      );
      if (!response.ok) throw new Error(`alert acknowledgement failed (${response.status})`);
      alerts = (await response.json()) as LocalAlertState;
    } else alerts = acknowledgeLocalAlert(salidiumHome, id);
    if (!options.quiet)
      process.stdout.write(
        options.json ? `${JSON.stringify(alerts)}\n` : `Alert ${id} acknowledged.\n`,
      );
    return 0;
  }
  process.stderr.write('maintenance accepts status, queue, drain, optimize, or acknowledge\n');
  return 2;
}
