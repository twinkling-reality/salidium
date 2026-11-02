import type { SessionView } from '@salidium/core';
import { shortPath } from '../../lib/format.ts';

export function VerificationMatrixLens({
  view,
  cwd,
  onRef,
}: {
  view: SessionView;
  cwd: string;
  onRef: (ref: string) => void;
}) {
  const verifiedFiles = view.changes.files.filter((f) => f.verifiedAfter);
  const unverifiedFiles = view.changes.files.filter((f) => !f.verifiedAfter);
  const totalFiles = view.changes.files.length;
  const pct = totalFiles > 0 ? Math.round((verifiedFiles.length / totalFiles) * 100) : 100;
  const openReviews = view.review.groups.filter((g) => g.severity !== 'info');

  return (
    <section className="ex canvas-diagram" aria-label="Verification and risk matrix">
      <header className="canvas-diagram-head">
        <h2 className="ex-title">Verification Coverage &amp; Blast Radius</h2>
      </header>

      {totalFiles > 0 && (
        <div className="ver-meter">
          <div className="ver-meter-head">
            <strong>
              {verifiedFiles.length} of {totalFiles} modified {totalFiles === 1 ? 'file' : 'files'}{' '}
              verified after last edit
            </strong>
            <span className="mono num">{pct}% covered</span>
          </div>
          <div className="ver-meter-bar" aria-hidden="true">
            <span className="ver-meter-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="ver-columns">
        <div className="ver-col is-covered">
          <h3 className="sys-tier-title">Verified Surface ({verifiedFiles.length})</h3>
          {verifiedFiles.length === 0 ? (
            <p className="muted">No modified files have been followed by a passing check yet.</p>
          ) : (
            <ul className="ver-list">
              {verifiedFiles.slice(0, 12).map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    className="sys-node-btn is-outcome-pass"
                    onClick={() => onRef(file.lastCallId)}
                  >
                    <span className="sys-node-glyph" aria-hidden="true">
                      ✓
                    </span>
                    <span className="sys-node-name mono">{shortPath(file.path, cwd)}</span>
                    <span className="sys-node-meta">{file.verifiedBy ?? 'verified'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ver-col is-exposed">
          <h3 className="sys-tier-title">
            Unverified / Needs Attention (
            {unverifiedFiles.length + openReviews.length + view.left.items.length})
          </h3>
          {unverifiedFiles.length === 0 &&
          openReviews.length === 0 &&
          view.left.items.length === 0 ? (
            <p className="muted">
              Every modified file was followed by a passing check and no review items are open.
            </p>
          ) : (
            <ul className="ver-list">
              {unverifiedFiles.slice(0, 10).map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    className="sys-node-btn is-outcome-partial"
                    onClick={() => onRef(file.lastCallId)}
                  >
                    <span className="sys-node-glyph" aria-hidden="true">
                      ?
                    </span>
                    <span className="sys-node-name mono">{shortPath(file.path, cwd)}</span>
                    <span className="sys-node-meta">edited after last check</span>
                  </button>
                </li>
              ))}
              {openReviews.map((group) => (
                <li key={group.rule}>
                  <button
                    type="button"
                    className="sys-node-btn is-review"
                    onClick={() => group.items[0]?.refs[0] && onRef(group.items[0].refs[0])}
                  >
                    <span className="sys-node-glyph" aria-hidden="true">
                      !
                    </span>
                    <span className="sys-node-name">{group.label}</span>
                    <span className="sys-node-meta num">{group.occurrences}x flagged</span>
                  </button>
                </li>
              ))}
              {view.left.items.slice(0, 6).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="sys-node-btn is-outcome-fail"
                    onClick={() => item.refs[0] && onRef(item.refs[0])}
                  >
                    <span className="sys-node-glyph" aria-hidden="true">
                      ·
                    </span>
                    <span className="sys-node-name">{item.text}</span>
                    <span className="sys-node-meta">{item.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <footer className="ex-foot">
        <div className="ex-attribution">
          <p className="ex-mark">Observed from session records · deterministic</p>
        </div>
      </footer>
    </section>
  );
}
