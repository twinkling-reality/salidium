import type { SessionView } from '@salidium/core';
import { timeOfDay } from '../../lib/format.ts';
import { outcomeGlyph } from '../../lib/outcome.ts';

export function ExecutionSequenceLens({
  view,
  onRef,
}: {
  view: SessionView;
  onRef: (ref: string) => void;
}) {
  return (
    <section className="ex canvas-diagram" aria-label="Step-by-step progress">
      <header className="canvas-diagram-head">
        <h2 className="ex-title">Step-by-Step Progress</h2>
      </header>

      {view.turns.length === 0 ? (
        <p className="muted">No turns recorded in this session yet.</p>
      ) : (
        <ol className="seq-lanes">
          {view.turns.map((turn) => {
            const reads = turn.activities.filter(
              (a) =>
                a.kind === 'fileRead' ||
                a.kind === 'search' ||
                a.kind === 'webFetch' ||
                a.kind === 'webSearch' ||
                a.kind === 'mcp',
            );
            const edits = turn.activities.filter(
              (a) => a.kind === 'fileEdit' || a.kind === 'fileWrite',
            );
            const commands = turn.activities.filter(
              (a) => a.kind === 'command' && !a.isVerification,
            );
            const delegates = turn.activities.filter((a) => a.kind === 'subagent');
            const checks = turn.verifications;

            return (
              <li key={turn.id} className="seq-turn">
                <div className="seq-turn-head">
                  <span className="seq-turn-index num">Step {turn.index + 1}</span>
                  <span className="seq-turn-prompt">
                    {turn.headline || turn.prompt || '(prompt not recorded)'}
                  </span>
                  <span className="seq-turn-time mono">{timeOfDay(turn.startedAt)}</span>
                </div>

                <div className="seq-stages">
                  <div className="seq-stage is-explore">
                    <span className="seq-stage-label">1. Read &amp; Explored</span>
                    {reads.length === 0 && commands.length === 0 && delegates.length === 0 ? (
                      <span className="seq-stage-empty">None</span>
                    ) : (
                      <div className="seq-stage-chips">
                        {reads.length > 0 && (
                          <button
                            type="button"
                            className="seq-chip"
                            onClick={() => reads[0]?.callId && onRef(reads[0].callId)}
                          >
                            {reads.length} {reads.length === 1 ? 'read/search' : 'reads/searches'}
                          </button>
                        )}
                        {commands.length > 0 && (
                          <button
                            type="button"
                            className="seq-chip"
                            onClick={() => commands[0]?.callId && onRef(commands[0].callId)}
                          >
                            {commands.length} {commands.length === 1 ? 'command' : 'commands'}
                          </button>
                        )}
                        {delegates.length > 0 && (
                          <button
                            type="button"
                            className="seq-chip is-accent"
                            onClick={() => delegates[0]?.callId && onRef(delegates[0].callId)}
                          >
                            {delegates.length} {delegates.length === 1 ? 'subagent' : 'subagents'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="seq-stage is-mutate">
                    <span className="seq-stage-label">2. Edited</span>
                    {turn.files.length === 0 && edits.length === 0 ? (
                      <span className="seq-stage-empty">No edits</span>
                    ) : (
                      <div className="seq-stage-chips">
                        <button
                          type="button"
                          className="seq-chip is-edit"
                          onClick={() => edits[0]?.callId && onRef(edits[0].callId)}
                        >
                          {turn.files.length || edits.length}{' '}
                          {(turn.files.length || edits.length) === 1 ? 'file' : 'files'}
                          {turn.linesAdded + turn.linesRemoved > 0 && (
                            <span className="mono">
                              {' '}
                              (+{turn.linesAdded}/-{turn.linesRemoved})
                            </span>
                          )}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="seq-stage is-verify">
                    <span className="seq-stage-label">3. Checked</span>
                    {checks.length === 0 ? (
                      <span className="seq-stage-empty">
                        {turn.files.length > 0 ? 'Unchecked in turn' : 'No checks'}
                      </span>
                    ) : (
                      <div className="seq-stage-chips">
                        {checks.map((v) => (
                          <button
                            key={v.id}
                            type="button"
                            className={`seq-chip is-outcome-${v.outcome}`}
                            onClick={() => onRef(v.callId)}
                          >
                            <span aria-hidden="true">{outcomeGlyph(v.outcome)}</span> {v.method}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <footer className="ex-foot">
        <div className="ex-attribution">
          <p className="ex-mark">Observed from session records · deterministic</p>
        </div>
      </footer>
    </section>
  );
}
