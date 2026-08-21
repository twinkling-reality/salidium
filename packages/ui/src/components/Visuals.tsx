import type { FileRow, VerificationRow } from '@salidium/core';
import { basename, commonDir, dirname, shortHome, shortPath, timeOfDay } from '../lib/format.ts';
import { outcomeGlyph } from '../lib/outcome.ts';

/**
 * The picture of the work, for reading without reading. Salidium exists because agent sessions
 * produce more prose than anyone will read, so anything a shape can carry must not be a sentence:
 * churn is bar length, outcome is colour and position, coverage is a filled proportion. Text here
 * is labels and exact values only — never narration.
 *
 * Every chart is drawn with plain elements and percentage geometry rather than a chart library:
 * it keeps the bundle honest (zero network, no runtime deps) and it reflows without measurement.
 * Each carries a text summary for assistive tech, and the marks themselves are hidden from it.
 */

/** Files ranked by how much of them moved, so the biggest edit is obvious without reading paths. */
export function FileChurn({
  files,
  cwd,
  limit = 10,
  onOpen,
}: {
  files: FileRow[];
  cwd: string;
  limit?: number;
  onOpen: (f: FileRow) => void;
}) {
  if (files.length === 0) return null;
  const ranked = [...files]
    .sort((a, b) => b.linesAdded + b.linesRemoved - (a.linesAdded + a.linesRemoved))
    .slice(0, limit);
  const peak = Math.max(1, ...ranked.map((f) => f.linesAdded + f.linesRemoved));
  const hidden = files.length - ranked.length;
  // Said once, above, rather than repeated down every row — see `commonDir`.
  const root = commonDir(ranked.map((f) => f.path));
  return (
    <section className="viz" aria-label={`Churn for ${files.length} changed files`}>
      <h3 className="viz-title">
        Changed <span className="viz-count num">{files.length}</span>
      </h3>
      {root && (
        <p className="viz-root mono" title={root}>
          <bdi>{shortHome(root)}</bdi>
        </p>
      )}
      <ul className="churn">
        {ranked.map((f) => {
          const total = f.linesAdded + f.linesRemoved;
          return (
            <li key={f.path} className="churn-row">
              <button type="button" className="churn-main" onClick={() => onOpen(f)}>
                <span className="churn-name mono" title={f.path}>
                  {basename(f.path)}
                  <span className="churn-dir">
                    {dirname(root ? f.path.slice(root.length) : shortPath(f.path, cwd))}
                  </span>
                </span>
                <span className="churn-bar" aria-hidden="true">
                  <span
                    className="churn-add"
                    style={{ width: `${(f.linesAdded / peak) * 100}%` }}
                  />
                  <span
                    className="churn-del"
                    style={{ width: `${(f.linesRemoved / peak) * 100}%` }}
                  />
                </span>
                <span className="churn-num num">
                  <span className="add">+{f.linesAdded}</span>
                  <span className="del">−{f.linesRemoved}</span>
                </span>
                {!f.verifiedAfter && (
                  <span className="churn-flag" title="No passing check ran after this edit">
                    ?
                  </span>
                )}
              </button>
              <span className="sr-only">
                {shortPath(f.path, cwd)}: {total} lines changed
                {f.verifiedAfter ? '' : ', unchecked since'}
              </span>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && <p className="viz-foot">{hidden} smaller changes not shown</p>}
    </section>
  );
}

/**
 * One lane per kind of check, dots in time order. Reading left to right shows the thing that
 * matters most and is hardest to get from prose: whether the red ever turned green, and whether
 * anything ran after the last edit.
 */
/**
 * Every check that ran, by kind: what it came to last, and the run of outcomes behind it.
 *
 * This was a row of marks placed at the moment each run happened, which read as a scatter of
 * symbols nobody could interpret: the track carried no axis and no labels, so a mark's position
 * meant nothing to a reader, and a burst of runs drew them all on the same pixel. Position was
 * claiming a precision the picture never explained, and the timeline already answers *when*
 * exactly.
 *
 * So the strip is order, not time — oldest on the left, newest on the right, evenly spaced — and
 * the row leads with the thing a reader came for, in words: what this kind of check says now.
 * The strip is then history against that, and it can be counted.
 */
export function CheckLanes({
  runs,
  onOpen,
}: {
  runs: VerificationRow[];
  onOpen: (v: VerificationRow) => void;
}) {
  if (runs.length === 0) return null;
  const methods = [...new Set(runs.map((r) => r.method))];
  const word = (o: VerificationRow['outcome']) =>
    o === 'pass' ? 'passing' : o === 'fail' ? 'failing' : o === 'partial' ? 'partial' : 'unknown';
  return (
    <section
      className="viz checks"
      aria-label={`${runs.length} checks across ${methods.length} kinds`}
    >
      {/*
       * One grid for the whole list, so every column lines up by construction. Each row was its
       * own flex line with `min-width` guesses holding the columns apart, which works only while
       * every label happens to be about the same length: "22 runs, 1 failed" is wider than the
       * guess and "ran once" is narrower, so the strips began at three different places down one
       * list. Rows are `display: contents` and the grid does the aligning.
       */}
      <ul className="checks-rows">
        {methods.map((m) => {
          const mine = runs.filter((r) => r.method === m).sort((a, b) => a.at.localeCompare(b.at));
          const last = mine[mine.length - 1];
          if (!last) return null;
          const failed = mine.filter((r) => r.outcome === 'fail').length;
          return (
            <li className="checks-row" key={m}>
              <span className="checks-method">{m}</span>
              <span className={`checks-now v-${last.outcome}`}>
                <span className="checks-now-mark" aria-hidden="true">
                  {outcomeGlyph(last.outcome)}
                </span>
                {word(last.outcome)}
                {last.counts?.total !== undefined && (
                  <span className="checks-counts num">
                    {last.counts.passed ?? 0}/{last.counts.total}
                  </span>
                )}
              </span>
              <span className="checks-strip">
                {mine.map((r) => (
                  <button
                    type="button"
                    key={r.id}
                    className={`checks-tick v-${r.outcome} ${r.epistemic === 'inferred' ? 'is-derived' : ''}`}
                    onClick={() => onOpen(r)}
                    title={`${timeOfDay(r.at)}, ${r.label}${r.epistemic === 'inferred' ? ' (worked out, not observed)' : ''}`}
                  >
                    <span className="sr-only">
                      {timeOfDay(r.at)} {r.outcome}
                    </span>
                  </button>
                ))}
              </span>
              <span className="checks-runs">
                {mine.length === 1
                  ? 'ran once'
                  : `${mine.length} runs${failed > 0 ? `, ${failed} failed` : ''}`}
              </span>
              <span className="checks-when">{timeOfDay(last.at)}</span>
            </li>
          );
        })}
      </ul>
      <p className="checks-key">
        Oldest first. A hollow mark is one Salidium worked out rather than read. Open any run for
        its record.
      </p>
    </section>
  );
}

export function Coverage({
  files,
  failing,
  onOpen,
}: {
  files: FileRow[];
  /** Checks that failed and have had no later passing run of the same kind to clear them. */
  failing: string[];
  onOpen?: (f: FileRow) => void;
}) {
  if (files.length === 0) return null;
  const CAP = 120;
  const shown = files.slice(0, CAP);
  const covered = files.filter((f) => f.verifiedAfter).length;
  const stale = files.length - covered;
  const held = failing.length > 0;
  return (
    <section className="viz cov" aria-label="Which changed files a passing check ran after">
      <p className="cov-lead">
        <strong className="num">
          {covered} of {files.length}
        </strong>{' '}
        changed {files.length === 1 ? 'file has' : 'files have'} had a passing check since it was
        last edited.
      </p>
      {held && (
        <p className="cov-held">
          {failing.join(' and ')} {failing.length === 1 ? 'is' : 'are'} still failing.
        </p>
      )}
      {/*
       * Unconditional. This sentence used to be the tail of the failing-checks line, so a session
       * where nothing had failed showed a grid of filled squares and nothing to stop it reading as
       * a green project. The one case that most needs the qualifier was the one case without it.
       */}
      <p className="cov-scope">
        A filled square is one file, not the project. A full grid does not mean the project is
        green.
      </p>
      <ul className="cov-grid">
        {shown.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              className={`cov-cell ${f.verifiedAfter ? 'is-covered' : 'is-stale'}`}
              onClick={() => onOpen?.(f)}
              title={`${f.path}: ${f.verifiedAfter ? (f.verifiedBy ?? 'checked after the last edit') : 'changed after the last passing check'}`}
            >
              <span className="sr-only">
                {f.path}:{' '}
                {f.verifiedAfter ? 'checked since last edit' : 'not checked since last edit'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {files.length > CAP && <p className="cov-more">…and {files.length - CAP} more.</p>}
      {/* The legend names both squares. Without it the grid is two colours and a guess. */}
      <ul className="cov-key">
        <li>
          <span className="cov-cell is-covered" aria-hidden="true" /> checked since last edit
          <span className="num cov-key-n">{covered}</span>
        </li>
        <li>
          <span className="cov-cell is-stale" aria-hidden="true" /> changed since the last check
          <span className="num cov-key-n">{stale}</span>
        </li>
      </ul>
    </section>
  );
}
