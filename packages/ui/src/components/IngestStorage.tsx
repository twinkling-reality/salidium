import type { CollectionStatus, DaemonInfo } from '@salidium/protocol';
import { useEffect, useState } from 'react';
import { relativeTime } from '../lib/format.ts';
import { useAppStore } from '../store/appStore.ts';
import { ToolButton } from './Controls.tsx';

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function retentionLabel(value: CollectionStatus['store']['retention']): string {
  if (value === null) return 'Unavailable';
  return value === 'forever' ? 'Forever' : `${value} days`;
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

function Readout({ status, now }: { status: CollectionStatus; now: number }) {
  return (
    <section className="is-section" aria-labelledby="is-readout">
      <h3 className="mu-title" id="is-readout">
        Readout
      </h3>
      {status.health !== 'healthy' && (
        <p className="is-alert" role="status">
          {status.health === 'runaway'
            ? 'Queue growth can outpace recovery.'
            : 'Collection loss has been observed.'}
        </p>
      )}
      <dl className="is-readout">
        <div>
          <dt>Collection</dt>
          <dd>
            {status.state === 'active' ? 'Active' : 'Paused'}
            {status.pause && <small>until {pauseExpiry(status.pause.expiresAt)}</small>}
          </dd>
        </div>
        <div>
          <dt>Queued now</dt>
          <dd>
            {status.queue.files.toLocaleString()} files
            <small>{formatBytes(status.queue.bytes)}</small>
          </dd>
        </div>
        <div>
          <dt>Oldest queued</dt>
          <dd>{status.queue.oldestAt ? relativeTime(status.queue.oldestAt, now) : 'None'}</dd>
        </div>
        <div>
          <dt>Store now</dt>
          <dd>{formatBytes(status.store.bytes)}</dd>
        </div>
        <div>
          <dt>Retention</dt>
          <dd>{retentionLabel(status.store.retention)}</dd>
        </div>
        <div>
          <dt>Last ingest</dt>
          <dd>
            {status.store.lastIngestAt
              ? relativeTime(status.store.lastIngestAt, now)
              : 'Unavailable'}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Controls({ status, info }: { status: CollectionStatus; info: DaemonInfo | undefined }) {
  const setCollection = useAppStore((state) => state.setCollection);
  const disconnectHooks = useAppStore((state) => state.disconnectHooks);
  const loading = useAppStore((state) => state.collectionLoading);
  const [confirmProvider, setConfirmProvider] = useState<string>();
  return (
    <section className="is-section" aria-labelledby="is-controls">
      <h3 className="mu-title" id="is-controls">
        Controls
      </h3>
      <div className="is-control-row">
        <button
          type="button"
          className="btn"
          disabled={loading}
          onClick={() => void setCollection(status.state === 'active' ? 'pause' : 'resume')}
        >
          {status.state === 'active' ? 'Pause collection' : 'Resume collection'}
        </button>
        <small>
          {status.state === 'active'
            ? 'Stops new hook and transcript observations for up to 24 hours.'
            : 'Reads provider files and drains the saved queue again.'}
        </small>
      </div>
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
                  disabled={loading}
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

function Ledger({ status, now }: { status: CollectionStatus; now: number }) {
  const entries = [
    ...status.gaps.active.map((gap) => ({ ...gap, active: true })),
    ...status.gaps.recovered
      .slice(-10)
      .reverse()
      .map((gap) => ({ ...gap, active: false })),
  ];
  const keyCounts = new Map<string, number>();
  const keyedEntries = entries.map((entry) => {
    const base = [
      entry.active ? 'active' : 'recovered',
      entry.reason,
      entry.provider ?? 'unknown-provider',
      entry.event ?? 'unknown-event',
      entry.pressure ?? 'unknown-pressure',
      entry.firstDroppedAt ?? 'unknown-start',
      entry.recoveredAt ?? 'unknown-recovery',
    ].join(':');
    const occurrence = (keyCounts.get(base) ?? 0) + 1;
    keyCounts.set(base, occurrence);
    return { entry, key: `${base}:${occurrence}` };
  });
  return (
    <section className="is-section" aria-labelledby="is-ledger">
      <h3 className="mu-title" id="is-ledger">
        Collection ledger
      </h3>
      {entries.length === 0 ? (
        <p className="is-empty">No collection gaps observed</p>
      ) : (
        <ol className="is-ledger">
          {keyedEntries.map(({ key, entry }) => (
            <li key={key}>
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
      {status.gaps.omittedEpisodes > 0 && (
        <p className="is-omitted">
          {status.gaps.omittedEpisodes.toLocaleString()} older episode
          {status.gaps.omittedEpisodes === 1 ? '' : 's'} omitted
        </p>
      )}
    </section>
  );
}

export function IngestStorageRail({ onClose }: { onClose: () => void }) {
  const api = useAppStore((state) => state.api);
  const status = useAppStore((state) => state.collection);
  const info = useAppStore((state) => state.collectionInfo);
  const loading = useAppStore((state) => state.collectionLoading);
  const error = useAppStore((state) => state.collectionError);
  const load = useAppStore((state) => state.loadCollection);
  const [now, setNow] = useState(() => Date.now());

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
    <aside className="inspector models-usage ingest-storage" aria-label="Ingest & Storage">
      <div className="inspector-head">
        <ToolButton icon="panel" title="Hide Ingest & Storage" onClick={onClose} />
        <span className="inspector-title">Ingest &amp; Storage</span>
      </div>
      <div className="models-usage-body scroll-fade">
        {!status && loading && (
          <p className="mu-loading" role="status">
            Reading local collection cost…
          </p>
        )}
        {error && (
          <p className="is-load-error" role="alert">
            Collection readout unavailable. {error}
          </p>
        )}
        {status && (
          <div className="is-body">
            <Readout status={status} now={now} />
            <Controls status={status} info={info} />
            <Ledger status={status} now={now} />
          </div>
        )}
      </div>
    </aside>
  );
}
