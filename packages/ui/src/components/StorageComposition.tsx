import { formatBytes } from '@salidium/core';
import type {
  StorageCompactResult,
  StorageComposition,
  StorageCompositionPart,
  StorageDeletionPreview,
  StorageDeletionScope,
} from '@salidium/protocol';
import { StorageCompositionSchema } from '@salidium/protocol';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, resolveToken } from '../api/client.ts';
import { durationMs, relativeTime } from '../lib/format.ts';
import { useAppStore } from '../store/appStore.ts';
import { Loading } from './Loading.tsx';

/**
 * What the local store is made of, measured on request.
 *
 * The readout above says the store is 3 GB and stops there, which is the number that makes someone
 * open this panel and the number that cannot answer why. This section is the second half of that
 * sentence: how much of it is the record of your work, how much is machinery, and how much is
 * space the file is holding but no longer using.
 *
 * It is asked for rather than polled, and it says when it was taken. The measurement reads every
 * stored event, so it is never on the five-second health path; the price of that is that what you
 * are reading is a photograph of a store that has kept growing since. The timestamp is always on
 * screen for that reason, and there is deliberately no attempt to guess whether it has gone stale:
 * a guess that says "still current" while being wrong is worse than a date the reader can judge.
 */

/*
 * One path, two methods. Reading the last measurement and starting the next one are the same
 * resource: the answer a POST produces is exactly what a GET then returns, and a reload cannot
 * replay a POST, so the ten second scan is not something a refresh can start by accident.
 */
const STORAGE_PATH = '/api/operations/storage';

type PartKey = StorageCompositionPart['key'];

/*
 * The same five names the CLI prints for the same five parts (`salidium storage composition`), so
 * a reader who has seen one is not made to learn the other. Not table names: the question being
 * answered is what the space is for, and no one asks that about a b-tree.
 */
const PART_LABEL: Record<PartKey, string> = {
  sessions: 'Recorded sessions',
  checkpoints: 'Replay checkpoints',
  provenance: 'Provenance records',
  structure: 'Indexes and internal structure',
  reusable: 'Reusable space',
};

/*
 * The order is this file's, not the response's. The bar reads as one sentence, heaviest to
 * lightest and evidence before machinery, and a server that reorders its array must not be able to
 * reshuffle a picture whose legend is written in a fixed order beside it.
 */
const PART_ORDER: PartKey[] = ['sessions', 'checkpoints', 'provenance', 'structure', 'reusable'];

/** Only for the parts whose name does not already say what they are. */
function partNote(key: PartKey): ReactNode {
  if (key === 'checkpoints')
    return 'Derived state that makes replay fast. Storage optimization rebuilds it.';
  if (key === 'structure')
    return 'The remainder after the named parts, measured by difference rather than counted.';
  if (key === 'reusable')
    return (
      <>
        Pages already deleted inside the file. Compact storage or{' '}
        <code>salidium storage compact</code> returns them to the disk.
      </>
    );
  return undefined;
}

export function formatDeletionRange(oldestAt: string | null, newestAt: string | null): string {
  const shortDate = (iso: string) => iso.slice(0, 10);
  if (oldestAt && newestAt) {
    const start = shortDate(oldestAt);
    const end = shortDate(newestAt);
    return start === end ? `from ${start}` : `from ${start} to ${end}`;
  }
  if (oldestAt) return `from ${shortDate(oldestAt)}`;
  if (newestAt) return `up to ${shortDate(newestAt)}`;
  return '';
}

/*
 * The last two segments, because the column is 288 px and the head of an absolute path is the part
 * every row shares. The whole path stays on the row as its title, so nothing is lost.
 */
function projectTail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('/') : path;
}

function authorization(): HeadersInit {
  const token = resolveToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Parts({ composition }: { composition: StorageComposition }) {
  const measured = new Map(composition.parts.map((part) => [part.key, part.bytes]));
  const parts = PART_ORDER.map((key) => ({ key, bytes: measured.get(key) ?? 0 }));
  const named = parts.reduce((sum, part) => sum + part.bytes, 0);
  /*
   * The file is the whole, not the sum of the parts. `structure` is the remainder, so the two
   * agree by construction; falling back to the sum keeps the bar honest rather than empty if a
   * future measurement ever reports parts without a file size.
   */
  const total = composition.fileBytes && composition.fileBytes > 0 ? composition.fileBytes : named;
  const share = (bytes: number) => (total > 0 ? (bytes / total) * 100 : 0);
  // A part that is present but tiny reads as "under 1%" rather than rounding away to nothing.
  const percent = (bytes: number) => {
    const value = share(bytes);
    return value > 0 && value < 1 ? 'under 1%' : `${Math.round(value)}%`;
  };
  return (
    <>
      <p className="composition-total">
        <strong className="num">{formatBytes(total)}</strong>
        {composition.sessions === null ? null : (
          <small>
            {composition.sessions.toLocaleString()} session
            {composition.sessions === 1 ? '' : 's'}
          </small>
        )}
      </p>
      {total > 0 && (
        <div className="composition-bar" aria-hidden="true">
          {parts
            .filter((part) => part.bytes > 0)
            .map((part) => (
              <span
                className={`composition-part is-${part.key}`}
                key={part.key}
                style={{ width: `${share(part.bytes)}%` }}
              />
            ))}
        </div>
      )}
      <p className="sr-only">
        {formatBytes(total)} in total:{' '}
        {parts
          .map(
            (part) => `${PART_LABEL[part.key]} ${formatBytes(part.bytes)}, ${percent(part.bytes)}`,
          )
          .join('; ')}
        .
      </p>
      <ul className="composition-legend">
        {parts.map((part) => {
          const note = partNote(part.key);
          return (
            <li key={part.key}>
              <span className={`composition-swatch is-${part.key}`} aria-hidden="true" />
              <span className="composition-legend-label">{PART_LABEL[part.key]}</span>
              <span className="composition-legend-bytes">{formatBytes(part.bytes)}</span>
              {note && <small className="composition-legend-note">{note}</small>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Projects({
  composition,
  busy,
  onForgetProject,
}: {
  composition: StorageComposition;
  busy: boolean;
  onForgetProject: (projectPath: string) => void;
}) {
  if (composition.projects.length === 0) return null;
  /*
   * Bars compare the listed projects with each other, not with the store. Against the whole file
   * the second row is already a hairline and the eighth is nothing, which is a picture that only
   * repeats what the top row's number said.
   */
  const peak = Math.max(1, ...composition.projects.map((project) => project.bytes));
  return (
    <>
      <h4 className="composition-subtitle">Projects</h4>
      <p className="composition-note">Bars compare each project with the largest one listed.</p>
      <ol className="composition-projects">
        {composition.projects.map((project) => (
          <li key={project.path}>
            <span className="composition-project-name mono" title={project.path || undefined}>
              <bdi>{project.path ? projectTail(project.path) : 'No project recorded'}</bdi>
            </span>
            <span className="composition-project-bytes num">{formatBytes(project.bytes)}</span>
            <span className="composition-project-bar" aria-hidden="true">
              <span style={{ width: `${(project.bytes / peak) * 100}%` }} />
            </span>
            <span className="composition-project-count num">
              {project.sessions.toLocaleString()} session{project.sessions === 1 ? '' : 's'}
              {project.path ? (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="link"
                    disabled={busy}
                    onClick={() => onForgetProject(project.path)}
                  >
                    Delete
                  </button>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {composition.projectsOmitted > 0 && (
        <p className="composition-omitted">
          {composition.projectsOmitted.toLocaleString()} more project
          {composition.projectsOmitted === 1 ? '' : 's'} not listed
        </p>
      )}
    </>
  );
}

export function StorageCompositionView({ now }: { now: number }) {
  const api = useAppStore((state) => state.api);
  const unauthorized = useAppStore((state) => state.unauthorized);
  const operationsPending = useAppStore((state) => state.operationsPending);
  const deleteStorage = useAppStore((state) => state.deleteStorage);
  const compactStorage = useAppStore((state) => state.compactStorage);
  const ingestFocus = useAppStore((state) => state.ingestFocus);
  const clearIngestFocus = useAppStore((state) => state.clearIngestFocus);
  const sessionsLoaded = useAppStore((state) => state.sessionsLoaded);
  const sectionRef = useRef<HTMLElement>(null);
  const [composition, setComposition] = useState<StorageComposition>();
  const [requestError, setRequestError] = useState<string>();
  /*
   * A daemon that answers 404 here does not offer the measurement at all, which is the one case
   * where this section shows nothing instead of an error: the CLI bundle carries its own copy of
   * this interface, so a build of the UI can be opened by a daemon older than it is, and an error
   * banner for a feature that machine simply does not have is noise the reader cannot act on.
   */
  const [offered, setOffered] = useState(true);
  const [starting, setStarting] = useState(false);
  const [pendingScope, setPendingScope] = useState<StorageDeletionScope>();
  const [preview, setPreview] = useState<StorageDeletionPreview>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmCompact, setConfirmCompact] = useState(false);
  const [compactResult, setCompactResult] = useState<StorageCompactResult>();
  const [statusNotice, setStatusNotice] = useState<string>();
  /* Invalidates a read that a newer read, or the POST that starts a measurement, has overtaken. */
  const generation = useRef(0);

  const read = useCallback(async () => {
    const request = ++generation.current;
    try {
      const res = await fetch(STORAGE_PATH, { headers: authorization() });
      if (res.status === 401) {
        unauthorized();
        return;
      }
      if (request !== generation.current) return;
      if (res.status === 404) {
        setOffered(false);
        return;
      }
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      const next = StorageCompositionSchema.parse(await res.json());
      if (request !== generation.current) return;
      setComposition(next);
      setRequestError(undefined);
    } catch (error) {
      if (request === generation.current) setRequestError(failureMessage(error));
    }
  }, [unauthorized]);

  const start = useCallback(async () => {
    const request = ++generation.current;
    setStarting(true);
    setRequestError(undefined);
    try {
      const res = await fetch(STORAGE_PATH, { method: 'POST', headers: authorization() });
      if (res.status === 401) {
        unauthorized();
        return;
      }
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      const next = StorageCompositionSchema.parse(await res.json());
      if (request !== generation.current) return;
      setComposition(next);
    } catch (error) {
      if (request === generation.current) setRequestError(failureMessage(error));
    } finally {
      /*
       * Unconditionally, unlike the two calls above it. Guarding this one on the generation leaves
       * the button disabled forever when a reconnect overtakes the POST, and there is never a
       * second POST in flight to be confused with this one: the button that sends it is disabled
       * for as long as this flag is set.
       */
      setStarting(false);
    }
  }, [unauthorized]);

  useEffect(() => {
    if (!api) return;
    void read();
  }, [api, read]);

  const running = composition?.state === 'running';
  useEffect(() => {
    if (!api || !running) return;
    const timer = setInterval(() => void read(), 1_500);
    return () => clearInterval(timer);
  }, [api, running, read]);

  useEffect(() => {
    if (ingestFocus !== 'storage' || !composition || !sessionsLoaded) return;
    sectionRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    if (composition.state === 'absent' && !starting) {
      void start();
    }
    clearIngestFocus();
  }, [ingestFocus, composition, sessionsLoaded, starting, start, clearIngestFocus]);

  const requestDelete = useCallback(
    async (scope: StorageDeletionScope) => {
      if (!api) return;
      setConfirmCompact(false);
      setCompactResult(undefined);
      setStatusNotice(undefined);
      setRequestError(undefined);
      setPendingScope(scope);
      setPreview(undefined);
      setPreviewLoading(true);
      try {
        const nextPreview = await api.previewStorageDeletion(scope);
        setPreview(nextPreview);
      } catch (error) {
        setRequestError(failureMessage(error));
        setPendingScope(undefined);
      } finally {
        setPreviewLoading(false);
      }
    },
    [api],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingScope || !preview) return;
    setRequestError(undefined);
    try {
      const result = await deleteStorage(pendingScope, preview.sessions);
      setPendingScope(undefined);
      setPreview(undefined);
      setStatusNotice(
        `Deleted ${result.removedSessions.toLocaleString()} ${result.removedSessions === 1 ? 'session' : 'sessions'} (${formatBytes(result.removedBytes)}).`,
      );
      void start();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.preview) {
        setPreview(error.preview);
        setRequestError(
          'The session count changed while you were reviewing. Confirm the updated count.',
        );
        return;
      }
      setRequestError(failureMessage(error));
    }
  }, [pendingScope, preview, deleteStorage, start]);

  const runCompact = useCallback(async () => {
    setRequestError(undefined);
    setStatusNotice(undefined);
    try {
      const result = await compactStorage();
      setConfirmCompact(false);
      setCompactResult(result);
      void start();
    } catch (error) {
      setRequestError(failureMessage(error));
    }
  }, [compactStorage, start]);

  if (!offered) return null;
  /*
   * Nothing at all until the first answer arrives. The empty state of this section is a sentence
   * saying the store has never been measured, and printing that for the 40 ms before the daemon
   * says otherwise would be telling the reader something false about their own store.
   */
  if (!composition && !requestError) return null;

  const state = composition?.state ?? 'absent';
  const busy = starting || running || previewLoading || operationsPending !== undefined;
  const action =
    state === 'ready'
      ? 'Measure again'
      : state === 'failed'
        ? 'Try again'
        : running
          ? 'Measuring…'
          : 'Analyze storage';
  const stamp =
    state === 'ready'
      ? `Measured ${relativeTime(composition?.computedAt ?? undefined, now)}`.trim()
      : running
        ? 'Measuring'
        : state === 'failed'
          ? 'Did not finish'
          : 'Not measured';
  const rangeText = preview ? formatDeletionRange(preview.oldestAt, preview.newestAt) : '';

  return (
    <section
      className="is-section is-composition"
      aria-labelledby="is-composition-title"
      ref={sectionRef}
    >
      <div className="operations-section-head">
        <h3 className="mu-title" id="is-composition-title">
          What is using this space
        </h3>
        <span>{stamp}</span>
      </div>
      {state === 'absent' && (
        <p className="composition-note">
          Nothing has been measured yet. Measuring reads every stored event and reports how much of
          this store is your recorded sessions, how much is the machinery that serves them, and how
          much is space the file can give back.
        </p>
      )}
      {running && (
        <>
          <div className="operations-action-status">
            <Loading label="Measuring the store" />
          </div>
          <p className="composition-note">
            This reads every stored event and takes several seconds on a large store. Collection
            keeps running while it works.
          </p>
        </>
      )}
      {state === 'failed' && (
        <p className="is-action-error" role="alert">
          Measurement did not finish. {composition?.failure ?? 'No reason was reported.'}
        </p>
      )}
      {state === 'ready' && composition && (
        <>
          <Parts composition={composition} />
          <Projects
            composition={composition}
            busy={busy}
            onForgetProject={(projectPath) =>
              void requestDelete({ kind: 'project', project: projectPath })
            }
          />
          <p className="composition-note">
            A measurement, not a live reading. It was taken{' '}
            {relativeTime(composition.computedAt ?? undefined, now) || 'at an unrecorded time'}
            {composition.elapsedMs === null ? '' : ` and took ${durationMs(composition.elapsedMs)}`}
            ; the store has kept changing since.
          </p>
        </>
      )}
      {previewLoading && (
        <div className="operations-action-status">
          <Loading label="Counting matching sessions" />
        </div>
      )}
      {pendingScope && preview && (
        <div className="operations-retention-confirm" role="alert">
          <p>
            {pendingScope.kind === 'project' ? (
              <>
                Deleting <code>{pendingScope.project}</code> permanently removes{' '}
                <strong>
                  {preview.sessions.toLocaleString()}{' '}
                  {preview.sessions === 1 ? 'session' : 'sessions'}
                </strong>{' '}
                ({preview.eventCount.toLocaleString()}{' '}
                {preview.eventCount === 1 ? 'event' : 'events'}, {formatBytes(preview.bytes)}
                {rangeText ? `, ${rangeText}` : ''}). This cannot be undone.
              </>
            ) : (
              <>
                Deleting all session history permanently removes{' '}
                <strong>
                  {preview.sessions.toLocaleString()}{' '}
                  {preview.sessions === 1 ? 'session' : 'sessions'}
                </strong>{' '}
                ({preview.eventCount.toLocaleString()}{' '}
                {preview.eventCount === 1 ? 'event' : 'events'}, {formatBytes(preview.bytes)}
                {rangeText ? `, ${rangeText}` : ''}). Settings, consumer credentials, and hook
                configuration stay intact.
              </>
            )}
          </p>
          <button
            type="button"
            className="btn is-confirm"
            disabled={busy || preview.sessions === 0}
            onClick={() => void confirmDelete()}
          >
            Delete {preview.sessions.toLocaleString()}{' '}
            {preview.sessions === 1 ? 'session' : 'sessions'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setPendingScope(undefined);
              setPreview(undefined);
            }}
          >
            Keep sessions
          </button>
        </div>
      )}
      {confirmCompact && (
        <div className="operations-retention-confirm" role="alert">
          <p>
            Compacting storage pauses collection briefly while SQLite reclaims deleted pages and
            returns reusable space to the disk.
          </p>
          <button
            type="button"
            className="btn is-confirm"
            disabled={busy}
            onClick={() => void runCompact()}
          >
            {operationsPending === 'storage-compact' ? 'Compacting…' : 'Compact storage now'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setConfirmCompact(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {statusNotice && (
        <p className="composition-note" role="status">
          {statusNotice}
        </p>
      )}
      {compactResult && (
        <p className="composition-note" role="status">
          Compacted storage from {formatBytes(compactResult.beforeBytes)} to{' '}
          {formatBytes(compactResult.afterBytes)} (reclaimed{' '}
          {formatBytes(Math.max(0, compactResult.beforeBytes - compactResult.afterBytes))}).
        </p>
      )}
      {requestError && (
        <p className="is-action-error" role="alert">
          Storage action failed. {requestError}
        </p>
      )}
      <div className="operations-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void start()}>
          {action}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setPendingScope(undefined);
            setPreview(undefined);
            setConfirmCompact(true);
          }}
        >
          Compact Storage
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void requestDelete({ kind: 'all' })}
        >
          Delete All Sessions…
        </button>
      </div>
    </section>
  );
}
