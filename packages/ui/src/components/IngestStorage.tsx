import { formatBytes } from '@salidium/core';
import type {
  DaemonInfo,
  EffectiveOperationalConfig,
  LocalAlert,
  OperationsHealthSnapshot,
  OperationsOverview,
} from '@salidium/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { relativeTime } from '../lib/format.ts';
import { type OperationsAction, useAppStore } from '../store/appStore.ts';
import { ToolButton } from './Controls.tsx';
import { Loading } from './Loading.tsx';

function bytesOrUnavailable(bytes: number | null): string {
  return bytes === null ? 'Unavailable' : formatBytes(bytes);
}

/*
 * Enum values the reader never has a reason to learn.
 *
 * `health.overall` was rendered straight into the badge, so a store needing attention said
 * "attention" in lower case beside a heading that says "Needs attention" everywhere else, and
 * `maintenance.phase` printed "failure" the same way.
 */
function healthLabel(overall: OperationsHealthSnapshot['overall']): string {
  if (overall === 'critical') return 'Critical';
  if (overall === 'attention') return 'Needs attention';
  return 'Healthy';
}

function measureLabel(availability: 'exact' | 'unavailable'): string {
  return availability === 'exact' ? 'measured' : 'unavailable';
}

function phaseLabel(phase: NonNullable<OperationsHealthSnapshot['maintenance']>['phase']): string {
  if (phase === 'failure') return 'Did not finish';
  if (phase === 'recovery') return 'Recovering';
  if (phase === 'completed') return 'Finished';
  return 'Running';
}

function alertStateLabel(alert: LocalAlert): string {
  if (alert.state === 'recovered') return 'Over';
  if (alert.state === 'acknowledged') return 'Acknowledged';
  if (alert.severity === 'critical') return 'Needs attention now';
  if (alert.severity === 'warning') return 'Worth a look';
  return 'For information';
}

function retentionLabel(value: OperationsHealthSnapshot['store']['retention']): string {
  if (value === null) return 'Unavailable';
  return value === 'forever' ? 'Kept forever' : `Kept ${value} days`;
}

/*
 * What a growth rate means over a day, and how much room is left.
 *
 * The panel showed "+499.8 KB/min" and nothing else, which is a true number nobody can act on:
 * the reader cannot tell from it whether the store gains a megabyte a week or a gigabyte a day.
 * Retention defaults to keeping everything, and the only signal that the store is large was an
 * alert at 5 GB, by which point there are 5 GB. A per-day figure and the distance to that mark
 * are the two facts that make it a decision instead of a surprise.
 *
 * Both are plainly labelled projections. A rate measured over an hour of heavy agent use does not
 * continue overnight, and saying "at this rate" is the honest form of that.
 */
function perDayLabel(estimate: OperationsHealthSnapshot['estimates']['storageGrowth']): string {
  if (!estimate || estimate.value <= 0) return '';
  return `about ${formatBytes(estimate.value * 60 * 24)} a day at this rate`;
}

function headroomLabel(total: number | null, warnAt: number): string {
  if (total === null) return '';
  const mark = formatBytes(warnAt);
  if (total >= warnAt) return `past its ${mark} warning mark`;
  /*
   * A store small enough that the room left rounds to the whole mark gets the mark on its own.
   * Otherwise a fresh install reads "5.00 GB below the 5.00 GB warning mark", which looks like
   * the same number printed twice by mistake.
   */
  const room = formatBytes(warnAt - total);
  return room === mark ? `warns at ${mark}` : `${room} below its ${mark} warning mark`;
}

function pauseExpiry(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function hookStatus(provider: DaemonInfo['providers'][number]): string {
  if (provider.hookStatus === 'configured') return 'Connected';
  if (provider.hookStatus === 'partial') return 'Incomplete';
  if (provider.hookStatus === 'invalid') return 'Needs repair';
  return 'Not connected';
}

function trustStatus(provider: DaemonInfo['providers'][number]): string | undefined {
  if (provider.id !== 'codex' || provider.hookStatus === 'not-configured') return undefined;
  if (provider.hookTrust === 'trusted') return 'Approved';
  if (provider.hookTrust === 'managed') return 'Managed';
  if (provider.hookTrust === 'untrusted') return 'Approval required';
  if (provider.hookTrust === 'modified') return 'Changed since approval';
  return 'Trust unavailable here';
}

function actionLabel(action: OperationsAction): string {
  if (action === 'policy') return 'Saving local policy';
  if (action === 'reset') return 'Restoring shipped defaults';
  if (action === 'drain') return 'Draining one batch';
  if (action === 'alert') return 'Acknowledging alert';
  if (action === 'disconnect') return 'Disconnecting provider';
  return 'Updating collection';
}

/*
 * An absent rate says which of the two reasons it is absent for.
 *
 * Every null read "Needs two samples", including the drain rate sitting beside a queue velocity
 * reporting eighty-four of them. `drainRate` is null whenever the queue is not shrinking, which is
 * a fact about the queue and not about the sample window.
 */
function rateLabel(
  estimate: OperationsHealthSnapshot['estimates']['queueVelocity'],
  kind: 'queue' | 'storage',
  absent = 'Needs two measurements',
): string {
  if (!estimate) return absent;
  /*
   * The sign comes from the number as shown, not the number as measured. A velocity of -0.004
   * files per minute is negative and rounds to 0.0, which rendered as "−0.0 files/min".
   */
  const shown =
    kind === 'storage'
      ? formatBytes(Math.abs(estimate.value))
      : Math.abs(estimate.value).toFixed(1);
  const zero = /^[0.]+(?: B)?$/.test(shown);
  const sign = zero ? '' : estimate.value > 0 ? '+' : '−';
  return `${sign}${shown}${kind === 'storage' ? '/min' : ' files/min'}`;
}

function Readout({ overview, now }: { overview: OperationsOverview; now: number }) {
  const { health } = overview;
  const perDay = perDayLabel(health.estimates.storageGrowth);
  const absentReason =
    health.estimates.queueVelocity === null ? 'Needs two measurements' : 'Not shrinking';
  const headroom = headroomLabel(
    health.store.totalBytes,
    overview.config.values.alerts.databaseSizeBytes.value,
  );
  const direction =
    !health.estimates.queueVelocity || health.estimates.queueVelocity.value === 0
      ? 'steady'
      : health.estimates.queueVelocity.value < 0
        ? 'draining'
        : 'growing';
  return (
    <section className="is-section operations-readout" aria-labelledby="is-readout">
      <div className="operations-section-head">
        <h3 className="mu-title" id="is-readout">
          Current readout
        </h3>
        <span className={`operations-health is-${health.overall}`}>
          {healthLabel(health.overall)}
        </span>
      </div>
      <dl className="is-readout">
        <div>
          <dt>
            Collection <small className="measure-kind">measured</small>
          </dt>
          <dd>
            {health.collection.state === 'active' ? 'Active' : 'Paused'}
            {health.collection.pauseExpiresAt && (
              <small>until {pauseExpiry(health.collection.pauseExpiresAt)}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>
            Waiting to be stored{' '}
            <small className="measure-kind">{measureLabel(health.queue.availability)}</small>
          </dt>
          <dd>
            {health.queue.files === null
              ? 'Unavailable'
              : `${health.queue.files.toLocaleString()} files`}
            <small>{bytesOrUnavailable(health.queue.bytes)}</small>
          </dd>
        </div>
        <div>
          <dt>
            Oldest waiting <small className="measure-kind">measured</small>
          </dt>
          <dd>{health.queue.oldestAt ? relativeTime(health.queue.oldestAt, now) : 'None'}</dd>
        </div>
        <div>
          <dt>
            On this Mac{' '}
            <small className="measure-kind">{measureLabel(health.store.availability)}</small>
          </dt>
          <dd>
            {bytesOrUnavailable(health.store.totalBytes)}
            <small>
              {retentionLabel(health.store.retention)}
              {headroom ? ` · ${headroom}` : ''}
            </small>
          </dd>
        </div>
      </dl>
      <div className={`operations-velocity is-${direction}`}>
        <span className="operations-velocity-line" aria-hidden="true" />
        <div>
          <strong>Queue velocity</strong>
          <span>{rateLabel(health.estimates.queueVelocity, 'queue')}</span>
          <small>
            {health.estimates.queueVelocity ? `${direction} · ` : ''}estimate
            {health.estimates.queueVelocity
              ? ` · ${health.estimates.queueVelocity.samples} samples / ${Math.round(health.estimates.queueVelocity.sampleWindowSeconds)}s`
              : ''}
          </small>
        </div>
        <div>
          <strong>Drain rate</strong>
          <span>{rateLabel(health.estimates.drainRate, 'queue', absentReason)}</span>
          <small>estimate</small>
        </div>
        <div>
          <strong>Storage growth</strong>
          <span>{rateLabel(health.estimates.storageGrowth, 'storage')}</span>
          <small>{perDay || 'estimate'}</small>
        </div>
        <div>
          <strong>Time to empty</strong>
          <span>
            {health.estimates.timeToEmpty
              ? `${Math.max(1, Math.round(health.estimates.timeToEmpty.value / 60))} min`
              : health.queue.files === 0
                ? 'Already empty'
                : absentReason}
          </span>
          <small>estimate</small>
        </div>
      </div>
      <p className="operations-retention-note">
        Health history keeps {health.history.retentionMinutes} minutes locally ·{' '}
        {health.history.retainedSamples} samples retained
      </p>
    </section>
  );
}

function Runtime({
  health,
  info,
  now,
}: {
  health: OperationsHealthSnapshot;
  info: DaemonInfo | undefined;
  now: number;
}) {
  const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
  return (
    <section className="is-section operations-runtime" aria-labelledby="operations-runtime-title">
      <div className="operations-section-head">
        <h3 className="mu-title" id="operations-runtime-title">
          Where it runs
        </h3>
        <span>Local only</span>
      </div>
      <dl className="is-readout">
        <div>
          <dt>Background service</dt>
          <dd>
            {health.daemon.pid ? `PID ${health.daemon.pid}` : 'Unavailable'}
            {health.daemon.startedAt && (
              <small>started {relativeTime(health.daemon.startedAt, now)}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>Listening on</dt>
          <dd>
            127.0.0.1:{port}
            <small>this computer only</small>
          </dd>
        </div>
        <div>
          <dt>State stored in</dt>
          <dd className="operations-runtime-path" title={info?.home}>
            <bdi>{info?.home ?? 'Unavailable'}</bdi>
          </dd>
        </div>
      </dl>
      <p className="operations-runtime-note">
        This tab is a control panel, not the service. Closing it does not stop collection. Reopen
        with <code>salidium open</code>; monitor without a window using{' '}
        <code>salidium status --watch</code>. On macOS, <code>salidium service install</code> also
        starts it at login, recovers crashes, and adds a menu-bar control.
      </p>
    </section>
  );
}

function Controls({
  overview,
  info,
}: {
  overview: OperationsOverview;
  info: DaemonInfo | undefined;
}) {
  const setCollection = useAppStore((state) => state.setCollection);
  const drainQueue = useAppStore((state) => state.drainQueue);
  const disconnectHooks = useAppStore((state) => state.disconnectHooks);
  const pending = useAppStore((state) => state.operationsPending);
  const [confirmProvider, setConfirmProvider] = useState<string>();
  const { health } = overview;
  return (
    <section className="is-section" aria-labelledby="is-controls">
      <h3 className="mu-title" id="is-controls">
        Collection controls
      </h3>
      <div className="operations-actions">
        <button
          type="button"
          className="btn"
          disabled={pending !== undefined}
          onClick={() =>
            void setCollection(health.collection.state === 'active' ? 'pause' : 'resume')
          }
        >
          {health.collection.state === 'active' ? 'Pause collection' : 'Resume collection'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={
            pending !== undefined ||
            health.collection.state === 'paused' ||
            health.queue.files === 0
          }
          onClick={() => void drainQueue().catch(() => {})}
        >
          Drain one batch
        </button>
      </div>
      <small className="operations-control-help">
        Pausing stops new observations for up to 24 hours. Draining makes one bounded batch durable;
        it never deletes work that failed to persist.
      </small>
      {health.maintenance && (
        <div
          className={`maintenance-state is-${health.maintenance.phase}`}
          role={health.maintenance.phase === 'failure' ? 'alert' : 'status'}
          aria-live={health.maintenance.phase === 'failure' ? 'assertive' : 'polite'}
        >
          <span>
            {phaseLabel(health.maintenance.phase)}
            {health.maintenance.progress === null
              ? ''
              : ` · ${Math.round(health.maintenance.progress * 100)}%`}
          </span>
          <div>
            <p>{health.maintenance.message}</p>
            {health.maintenance.failure && <small>{health.maintenance.failure}</small>}
            {health.maintenance.progress !== null && (
              <progress
                aria-label="Maintenance progress"
                value={health.maintenance.progress}
                max={1}
              />
            )}
          </div>
        </div>
      )}
      <div className="is-providers">
        {(info?.providers ?? []).map((provider) => {
          const connected =
            provider.hookStatus === 'configured' || provider.hookStatus === 'partial';
          const confirming = confirmProvider === provider.id;
          return (
            <div className="is-provider" key={provider.id}>
              <div>
                <strong>{provider.displayName ?? provider.id}</strong>
                <span>{hookStatus(provider)}</span>
                {trustStatus(provider) && <small>{trustStatus(provider)}</small>}
              </div>
              {connected && (
                <button
                  type="button"
                  className={confirming ? 'btn is-confirm' : 'btn'}
                  disabled={pending !== undefined}
                  onBlur={() => setConfirmProvider(undefined)}
                  onClick={() => {
                    if (!confirming) {
                      setConfirmProvider(provider.id);
                      return;
                    }
                    setConfirmProvider(undefined);
                    void disconnectHooks(provider.id);
                  }}
                >
                  {confirming ? `Disconnect ${provider.displayName ?? provider.id}?` : 'Disconnect'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Source({ source, environment }: { source: string; environment?: string }) {
  return (
    <small className="setting-source">
      {source === 'environment' ? `Locked by ${environment}` : source}
    </small>
  );
}

function PolicySettings({ config }: { config: EffectiveOperationalConfig }) {
  const save = useAppStore((state) => state.setOperationalConfig);
  const reset = useAppStore((state) => state.resetOperationalConfig);
  const pending = useAppStore((state) => state.operationsPending);
  const [open, setOpen] = useState(config.values.ui.operationsDetail.value === 'expanded');
  const change = (patch: Parameters<typeof save>[0]) => void save(patch).catch(() => {});
  const locked = (source: string) => source === 'environment';
  const busy = pending !== undefined;
  const retention = config.values.retention.days.value;
  // Narrowing retention is the one control here that destroys evidence rather than adjusting a
  // preference: the daemon applies the policy on save and its sweep then removes matching sessions
  // and their events permanently. It presents as a dropdown, and on Firefox and WebKit a closed
  // <select> commits on each arrow key, so `Forever` is one keystroke from `30 days`. Hold a
  // narrowing choice locally and make the person confirm the deletion it causes; widening and
  // `Forever` delete nothing, so they still save immediately.
  const [proposedRetention, setProposedRetention] = useState<typeof retention>();
  const span = (value: typeof retention) =>
    value === 'forever' ? Number.POSITIVE_INFINITY : value;
  const narrows = (value: typeof retention) => span(value) < span(retention);

  useEffect(() => {
    setOpen(config.values.ui.operationsDetail.value === 'expanded');
  }, [config.values.ui.operationsDetail.value]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    void save({ ui: { operationsDetail: next ? 'expanded' : 'summary' } }).catch(() => {
      setOpen(config.values.ui.operationsDetail.value === 'expanded');
    });
  };
  return (
    <section className="is-section operations-policy" aria-labelledby="operations-policy-title">
      <button
        className="operations-fold"
        type="button"
        aria-expanded={open}
        aria-controls="operations-policy-settings"
        disabled={busy}
        onClick={toggle}
      >
        <span>
          <strong id="operations-policy-title">Local policy</strong>
          <small>Safe preferences only</small>
        </span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="operations-settings" id="operations-policy-settings">
          <label>
            <span>
              Keep session history
              <Source {...config.values.retention.days} />
            </span>
            <select
              value={proposedRetention ?? retention}
              disabled={busy || locked(config.values.retention.days.source)}
              onChange={(event) => {
                const next =
                  event.target.value === 'forever'
                    ? ('forever' as const)
                    : (Number(event.target.value) as 30 | 90 | 365);
                if (narrows(next)) setProposedRetention(next);
                else {
                  setProposedRetention(undefined);
                  change({ retention: { days: next } });
                }
              }}
            >
              <option value="forever">Forever</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">365 days</option>
            </select>
          </label>
          {proposedRetention !== undefined && (
            <div className="operations-retention-confirm" role="alert">
              <p>
                Keeping {proposedRetention} days permanently deletes every unpinned session with no
                activity in the last {proposedRetention} days, and all of its events. This cannot be
                undone.
              </p>
              <button
                type="button"
                className="btn is-confirm"
                disabled={busy}
                onClick={() => {
                  const days = proposedRetention;
                  setProposedRetention(undefined);
                  change({ retention: { days } });
                }}
              >
                Delete older sessions
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setProposedRetention(undefined)}
              >
                Keep {retentionLabel(retention).toLowerCase()}
              </button>
            </div>
          )}
          <label className="operations-notification">
            <span>
              Native desktop notifications
              <Source {...config.values.alerts.nativeNotifications} />
              <small className="setting-help">Alert metadata only; never session content.</small>
            </span>
            <input
              type="checkbox"
              checked={config.values.alerts.nativeNotifications.value}
              disabled={busy || locked(config.values.alerts.nativeNotifications.source)}
              onChange={(event) =>
                change({ alerts: { nativeNotifications: event.target.checked } })
              }
            />
          </label>
          <label>
            <span>
              Warn when queue age reaches
              <Source {...config.values.alerts.queueAgeMinutes} />
            </span>
            <select
              value={config.values.alerts.queueAgeMinutes.value}
              disabled={busy || locked(config.values.alerts.queueAgeMinutes.source)}
              onChange={(event) =>
                change({ alerts: { queueAgeMinutes: Number(event.target.value) } })
              }
            >
              <option value="5">5 minutes</option>
              <option value="10">10 minutes</option>
              <option value="30">30 minutes</option>
              <option value="60">1 hour</option>
            </select>
          </label>
          <label>
            <span>
              Warn when storage reaches
              <Source {...config.values.alerts.databaseSizeBytes} />
            </span>
            <select
              value={config.values.alerts.databaseSizeBytes.value}
              disabled={busy || locked(config.values.alerts.databaseSizeBytes.source)}
              onChange={(event) =>
                change({ alerts: { databaseSizeBytes: Number(event.target.value) } })
              }
            >
              {[1, 5, 10, 20].map((gb) => (
                <option value={gb * 1000 * 1000 * 1000} key={gb}>
                  {gb} GB
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>
              Alert cooldown
              <Source {...config.values.alerts.cooldownMinutes} />
            </span>
            <select
              value={config.values.alerts.cooldownMinutes.value}
              disabled={busy || locked(config.values.alerts.cooldownMinutes.source)}
              onChange={(event) =>
                change({ alerts: { cooldownMinutes: Number(event.target.value) } })
              }
            >
              <option value="5">5 minutes</option>
              <option value="30">30 minutes</option>
              <option value="60">1 hour</option>
              <option value="240">4 hours</option>
            </select>
          </label>
          <label>
            <span>
              Keep health history
              <Source {...config.values.health.historyMinutes} />
            </span>
            <select
              value={config.values.health.historyMinutes.value}
              disabled={busy || locked(config.values.health.historyMinutes.source)}
              onChange={(event) =>
                change({ health: { historyMinutes: Number(event.target.value) } })
              }
            >
              <option value="15">15 minutes</option>
              <option value="60">1 hour</option>
              <option value="360">6 hours</option>
              <option value="1440">24 hours</option>
            </select>
          </label>
          <fieldset disabled={busy || locked(config.values.providers.enabled.source)}>
            <legend>Providers after restart</legend>
            {(['claude-code', 'codex'] as const).map((provider) => {
              const enabled = config.values.providers.enabled.value.includes(provider);
              return (
                <label className="operations-check" key={provider}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() =>
                      change({
                        providers: {
                          enabled: enabled
                            ? config.values.providers.enabled.value.filter((id) => id !== provider)
                            : [...config.values.providers.enabled.value, provider],
                        },
                      })
                    }
                  />
                  {provider === 'claude-code' ? 'Claude Code' : 'Codex'}
                </label>
              );
            })}
          </fieldset>
          {config.restartRequired.length > 0 && (
            <p className="operations-restart" role="status">
              Restart Salidium to apply {config.restartRequired.join(', ')}.
            </p>
          )}
          <button
            type="button"
            className="btn operations-reset"
            disabled={busy}
            onClick={() => void reset().catch(() => {})}
          >
            Restore shipped defaults
          </button>
          <p className="operations-policy-note">
            Relay reserves, payload ceilings, trust bypasses, SQLite pages, and compression limits
            are safety invariants and are not customizable here.
          </p>
        </div>
      )}
    </section>
  );
}

function Alerts({ alerts }: { alerts: OperationsOverview['alerts'] }) {
  const acknowledge = useAppStore((state) => state.acknowledgeAlert);
  const pending = useAppStore((state) => state.operationsPending);
  const activeIds = new Set(alerts.active.map((alert) => alert.id));
  const recovered = alerts.recent.filter(
    (alert) => alert.state === 'recovered' && !activeIds.has(alert.id),
  );

  const alertRow = (alert: LocalAlert, allowAcknowledge: boolean) => (
    <li
      key={alert.id}
      className={`is-${alert.severity} ${alert.state === 'recovered' ? 'is-recovered' : ''}`}
      aria-live={
        alert.severity === 'critical' && alert.state === 'active' ? 'assertive' : undefined
      }
      aria-atomic={alert.severity === 'critical' && alert.state === 'active' ? true : undefined}
    >
      <div>
        <strong>
          {alert.state === 'recovered' ? (alert.recoveryTitle ?? alert.title) : alert.title}
        </strong>
        <span>
          {alert.state === 'recovered' ? (alert.recoveryDetail ?? alert.detail) : alert.detail}
        </span>
        <small>{alertStateLabel(alert)}</small>
      </div>
      {allowAcknowledge && alert.state === 'active' && (
        <button
          type="button"
          className="btn"
          disabled={pending !== undefined}
          onClick={() => void acknowledge(alert.id).catch(() => {})}
        >
          {pending === 'alert' ? 'Acknowledging…' : 'Acknowledge'}
        </button>
      )}
    </li>
  );
  return (
    <section className="is-section" aria-labelledby="operations-alerts-title">
      <div className="operations-section-head">
        <h3 className="mu-title" id="operations-alerts-title">
          Local alerts
        </h3>
        <span>{alerts.active.length} active</span>
      </div>
      <div aria-live="polite" aria-relevant="additions text">
        {alerts.active.length === 0 ? (
          <p className="is-empty">Nothing needs attention</p>
        ) : (
          <ol className="operations-alerts">
            {alerts.active.map((alert) => alertRow(alert, true))}
          </ol>
        )}
        {recovered.length > 0 && (
          <>
            <h4 className="operations-alerts-subtitle">Recently resolved</h4>
            <ol className="operations-alerts is-recent">
              {recovered.map((alert) => alertRow(alert, false))}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}

function Ledger({ health, now }: { health: OperationsHealthSnapshot; now: number }) {
  const entries = [
    ...health.gaps.activeEpisodes.map((gap) => ({ ...gap, active: true })),
    ...health.gaps.recoveredEpisodes
      .slice(-10)
      .reverse()
      .map((gap) => ({ ...gap, active: false })),
  ];
  return (
    <section className="is-section" aria-labelledby="is-ledger">
      <h3 className="mu-title" id="is-ledger">
        Collection ledger
      </h3>
      {entries.length === 0 ? (
        <p className="is-empty">No collection gaps observed</p>
      ) : (
        <ol className="is-ledger">
          {entries.map((entry) => (
            <li key={JSON.stringify(entry)}>
              <span
                className={entry.active ? 'is-gap-mark is-active' : 'is-gap-mark'}
                aria-hidden="true"
              />
              <div>
                <strong>
                  {entry.reason === 'collection-stopped'
                    ? 'Stopped interval'
                    : entry.reason === 'collection-paused'
                      ? 'Paused interval'
                      : entry.reason === 'collection-pause-marker-invalid'
                        ? 'Unreadable pause recovered'
                        : entry.active
                          ? 'Gap active'
                          : 'Gap recovered'}
                </strong>
                <span>
                  {entry.reason.startsWith('collection-')
                    ? 'Hook-only evidence may be absent'
                    : (entry.event ?? 'Multiple event types')}{' '}
                  · count unavailable
                </span>
                <small>
                  {entry.firstDroppedAt
                    ? `first observed ${relativeTime(entry.firstDroppedAt, now)}`
                    : 'start time unavailable'}
                </small>
              </div>
            </li>
          ))}
        </ol>
      )}
      {health.gaps.omitted > 0 && (
        <p className="is-omitted">
          {health.gaps.omitted.toLocaleString()} older episode
          {health.gaps.omitted === 1 ? '' : 's'} omitted
        </p>
      )}
    </section>
  );
}

export function IngestStorageRail({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const api = useAppStore((state) => state.api);
  const overview = useAppStore((state) => state.operations);
  const info = useAppStore((state) => state.collectionInfo);
  const loading = useAppStore((state) => state.collectionLoading);
  const error = useAppStore((state) => state.collectionError);
  const pending = useAppStore((state) => state.operationsPending);
  const actionError = useAppStore((state) => state.operationsActionError);
  const load = useAppStore((state) => state.loadCollection);
  const [now, setNow] = useState(() => Date.now());
  const railRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const rail = railRef.current;
    closeRef.current?.focus();
    return () => {
      if (!rail?.contains(document.activeElement)) return;
      requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, [returnFocusRef]);

  const close = () => {
    onClose();
    // WebKit does not focus a button for every pointer activation, so the unmount cleanup cannot
    // always infer that the close control initiated the transition.
    requestAnimationFrame(() => returnFocusRef.current?.focus());
  };

  useEffect(() => {
    if (!api) return;
    load();
    const timer = setInterval(() => {
      setNow(Date.now());
      load();
    }, 5_000);
    return () => clearInterval(timer);
  }, [api, load]);

  return (
    <aside
      className="inspector models-usage ingest-storage"
      id="ingest-storage-inspector"
      aria-label="Ingest & Storage"
      ref={railRef}
    >
      <div className="inspector-head">
        <ToolButton
          icon="panel"
          title="Hide Ingest & Storage"
          buttonRef={closeRef}
          onClick={close}
        />
        <span className="inspector-title">Local operations</span>
      </div>
      <div className="models-usage-body scroll-fade">
        {!overview && loading && <Loading label="Reading local health" block />}
        {error && (
          <p className="is-load-error" role="alert">
            {overview
              ? 'Health refresh failed; showing the last readout.'
              : 'Operations readout unavailable.'}{' '}
            {error}
          </p>
        )}
        {actionError && (
          <p className="is-action-error" role="alert">
            Action not completed. {actionError}
          </p>
        )}
        {pending && (
          <div className="operations-action-status">
            <Loading label={actionLabel(pending)} />
          </div>
        )}
        {overview && (
          <div className="is-body">
            <Readout overview={overview} now={now} />
            <Runtime health={overview.health} info={info} now={now} />
            <Alerts alerts={overview.alerts} />
            <Controls overview={overview} info={info} />
            <PolicySettings config={overview.config} />
            <Ledger health={overview.health} now={now} />
          </div>
        )}
      </div>
    </aside>
  );
}
