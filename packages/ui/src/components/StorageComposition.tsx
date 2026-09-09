import { formatBytes } from '@salidium/core';
import type { StorageComposition, StorageCompositionPart } from '@salidium/protocol';
import { StorageCompositionSchema } from '@salidium/protocol';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { resolveToken } from '../api/client.ts';
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
        Pages already deleted inside the file. With the daemon stopped,{' '}
        <code>salidium retention compact</code> returns them to the disk.
      </>
    );
  return undefined;
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

function Projects({ composition }: { composition: StorageComposition }) {
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

  if (!offered) return null;
  /*
   * Nothing at all until the first answer arrives. The empty state of this section is a sentence
   * saying the store has never been measured, and printing that for the 40 ms before the daemon
   * says otherwise would be telling the reader something false about their own store.
   */
  if (!composition && !requestError) return null;

  const state = composition?.state ?? 'absent';
  const busy = starting || running;
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

  return (
    <section className="is-section is-composition" aria-labelledby="is-composition-title">
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
          <Projects composition={composition} />
          <p className="composition-note">
            A measurement, not a live reading. It was taken{' '}
            {relativeTime(composition.computedAt ?? undefined, now) || 'at an unrecorded time'}
            {composition.elapsedMs === null ? '' : ` and took ${durationMs(composition.elapsedMs)}`}
            ; the store has kept changing since.
          </p>
        </>
      )}
      {requestError && (
        <p className="is-action-error" role="alert">
          Storage measurement unavailable. {requestError}
        </p>
      )}
      <div className="operations-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void start()}>
          {action}
        </button>
      </div>
    </section>
  );
}
