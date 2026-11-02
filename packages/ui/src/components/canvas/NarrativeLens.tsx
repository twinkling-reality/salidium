import type { SessionView } from '@salidium/core';
import { commonDir, shortHome } from '../../lib/format.ts';
import { isAutomaticModel } from '../../lib/modelName.ts';
import { Icon } from '../Icon.tsx';
import { Loading } from '../Loading.tsx';
import { PersonalizationSettings } from '../Personalization.tsx';
import { groupFilesIntoClusters } from './SystemArchitectureLens.tsx';

/** Which shapes a diagram used, so the page can explain only the marks actually on it. */
export interface Marks {
  junction?: boolean;
  outcome?: boolean;
}

/**
 * A run of steps flowing left to right, each following from the one before. Arrowheads sit in the
 * gaps between nodes; the last node is the one the run arrives at, so it carries the emphasis.
 */
export function Chain({
  steps,
  terminal = 'accent',
}: {
  steps: string[];
  terminal?: 'accent' | 'good' | 'bad' | 'none';
}) {
  if (steps.length === 0) return null;
  return (
    <ol className={`fd-chain end-${terminal}`}>
      {steps.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: steps are free text and may repeat.
        <li className="fd-node" key={`${i}:${s}`}>
          {s}
        </li>
      ))}
    </ol>
  );
}

/**
 * Concurrent actors that converge. The lanes run side by side; a junction gathers a stem from each
 * lane onto one bus and drops a single trunk out of its centre.
 */
export function Converge({
  lanes,
  trunk,
}: {
  lanes: Array<{ title: string; steps: string[] }>;
  trunk: string[];
}) {
  return (
    <div className="fd-converge">
      <div
        className="fd-lanes"
        style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(0, 1fr))` }}
      >
        {lanes.map((lane) => (
          <div className="fd-lane" key={lane.title}>
            <p className="fd-lane-title">{lane.title}</p>
            <ol className="fd-lane-steps">
              {lane.steps.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: steps are free text and may repeat.
                <li key={`${i}:${s}`}>{s}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
      {trunk.length > 0 && (
        <>
          <Junction count={lanes.length} />
          <Chain steps={trunk} />
        </>
      )}
    </div>
  );
}

function Junction({ count, fanOut = false }: { count: number; fanOut?: boolean }) {
  return (
    <div
      className={`fd-junction ${fanOut ? 'is-fan' : ''}`}
      style={{ '--lanes': count } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="fd-trunk" />
      <span className="fd-bus" />
      <div className="fd-stems">
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional stems, nothing else to key on.
          <span key={i} />
        ))}
      </div>
    </div>
  );
}

/**
 * A component and the operations that hang beneath it.
 */
export function Tree({ root, steps }: { root: string | null; steps: string[] }) {
  if (steps.length === 0) return null;
  if (!root) return <div className="fd-tree">{<Branches steps={steps} />}</div>;
  return (
    <div className="fd-tree has-root">
      <p className="fd-root mono">{root}</p>
      <Junction count={steps.length} fanOut />
      <Branches steps={steps} />
    </div>
  );
}

function Branches({ steps }: { steps: string[] }) {
  return (
    <ul
      className="fd-branches"
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
    >
      {steps.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: steps are free text and may repeat.
        <li className="fd-node" key={`${i}:${s}`}>
          {s}
        </li>
      ))}
    </ul>
  );
}

export function BeforeAfter({
  from,
  fromSteps,
  to,
  toSteps,
  why,
}: {
  from: string;
  fromSteps: string[];
  to: string;
  toSteps: string[];
  why: string;
}) {
  return (
    <div className="fd-ba">
      <div className="fd-ba-side is-was">
        <p className="fd-ba-label">Was</p>
        <p className="fd-ba-head">{from}</p>
        <Chain steps={fromSteps} terminal="bad" />
      </div>
      {why && (
        <p className="fd-ba-why">
          <span className="fd-ba-pivot" aria-hidden="true" />
          <span>{why}</span>
        </p>
      )}
      <div className="fd-ba-side is-now">
        <p className="fd-ba-label">Now</p>
        <p className="fd-ba-head">{to}</p>
        <Chain steps={toSteps} terminal="good" />
      </div>
    </div>
  );
}

export function Legend({ marks }: { marks: Marks }) {
  const items: Array<[string, string]> = [];
  if (marks.junction) items.push(['fd-key-junction', 'where separate paths meet']);
  if (marks.outcome) items.push(['fd-key-outcome', 'abandoned, and adopted']);
  if (items.length === 0) return null;
  return (
    <ul className="fd-legend">
      {items.map(([cls, label]) => (
        <li key={cls}>
          <span className={`fd-key ${cls}`} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}

export function Explained({
  ex,
  sessionId,
  personalized = false,
  analogies,
  hasAlternate = false,
  onToggleVersion,
  personalizerOpen,
  onClosePersonalizer,
  personalizationNote,
  hasCurrentPresentation = false,
}: {
  ex: NonNullable<SessionView['explained']>;
  sessionId: string;
  personalized?: boolean;
  analogies?: { why: string | null; how: string | null };
  hasAlternate?: boolean;
  onToggleVersion?: () => void;
  personalizerOpen?: boolean;
  onClosePersonalizer?: () => void;
  personalizationNote?: string;
  hasCurrentPresentation?: boolean;
}) {
  const ac = ex.approachChange;
  const converging = ex.why.lanes.length > 1;
  const hasWhy = ex.why.chain.length > 0 || ex.why.lanes.length > 0;
  const marks: Marks = {
    junction: converging,
    outcome: Boolean(ac),
  };
  return (
    <section className="ex" aria-label="Generated explanation">
      <p className="ex-what">{ex.what.summary}</p>
      {ex.what.currently && (
        <p className="ex-now">
          <span className="ex-now-key">Now</span>
          {ex.what.currently}
        </p>
      )}

      {hasAlternate && onToggleVersion && (
        <div className="ex-version-row">
          {personalizationNote && (
            <span className="ex-version-note" title={personalizationNote}>
              <Icon name="sliders" />
              <span>Saved:</span>
              {personalizationNote}
            </span>
          )}
          <fieldset className="ex-version-switch">
            <legend className="sr-only">Explanation version</legend>
            <button
              type="button"
              className={`btn ex-version-button ${personalized ? '' : 'is-on'}`}
              aria-pressed={!personalized}
              onClick={personalized ? onToggleVersion : undefined}
            >
              <Icon name="record" />
              Original
            </button>
            <button
              type="button"
              className={`btn ex-version-button ${personalized ? 'is-on' : ''}`}
              aria-pressed={personalized}
              onClick={personalized ? undefined : onToggleVersion}
            >
              <Icon name="check" />
              Personalized
            </button>
          </fieldset>
        </div>
      )}

      {personalizerOpen && (
        <PersonalizationSettings
          sessionId={sessionId}
          hasCurrentPresentation={hasCurrentPresentation}
          onDone={onClosePersonalizer}
        />
      )}

      {hasWhy && (
        <section className="ex-block" id="sec-why" data-diagram-tone="why">
          <ExHead title="Why" summary={ex.why.summary} />
          {analogies?.why && <Analogy>{analogies.why}</Analogy>}
          {converging ? (
            <Converge lanes={ex.why.lanes} trunk={ex.why.chain} />
          ) : (
            <Chain steps={ex.why.chain} />
          )}
        </section>
      )}

      {ex.how.steps.length > 0 && (
        <section className="ex-block" id="sec-how" data-diagram-tone="how">
          <ExHead title="How" summary={ex.how.summary} />
          {analogies?.how && <Analogy>{analogies.how}</Analogy>}
          <Tree root={ex.how.root} steps={ex.how.steps} />
        </section>
      )}

      {ac && (
        <section className="ex-block" id="sec-approach" data-diagram-tone="approach">
          <ExHead title="Approach changed" />
          <BeforeAfter
            from={ac.from}
            fromSteps={ac.fromSteps}
            to={ac.to}
            toSteps={ac.toSteps}
            why={ac.why}
          />
        </section>
      )}

      <footer className="ex-foot">
        <Legend marks={marks} />
        <div className="ex-attribution">
          <p className="ex-mark">
            {personalized ? 'Personalized' : 'Generated'} by{' '}
            {isAutomaticModel(ex.model) ? 'Codex' : ex.model}
          </p>
        </div>
      </footer>
    </section>
  );
}

function Analogy({ children }: { children: string }) {
  return (
    <p className="ex-analogy">
      <span>In your terms</span>
      {children}
    </p>
  );
}

function ExHead({ title, summary }: { title: string; summary?: string }) {
  return (
    <header className="ex-head">
      <h2 className="ex-title">{title}</h2>
      {summary && <p className="ex-summary">{summary}</p>}
    </header>
  );
}

function deriveObservedChain(view: SessionView): string[] {
  const steps: string[] = [];
  const firstTurn = view.turns[0];
  if (firstTurn) {
    steps.push(view.turns.length === 1 ? '1 prompt turn' : `${view.turns.length} prompt turns`);
  }
  if (view.subagents.length > 0) {
    steps.push(
      `${view.subagents.length} ${view.subagents.length === 1 ? 'subagent' : 'subagents'} delegated`,
    );
  }
  if (view.changes.files.length > 0) {
    steps.push(
      `${view.changes.files.length} ${view.changes.files.length === 1 ? 'file' : 'files'} modified`,
    );
  } else if (view.changes.commands.length > 0) {
    steps.push(
      `${view.changes.commands.length} ${view.changes.commands.length === 1 ? 'command' : 'commands'} run`,
    );
  }
  if (view.verified.runs.length > 0) {
    const failed = view.verified.summary.filter((v) => v.outcome === 'fail').length;
    const passed = view.verified.summary.filter((v) => v.outcome === 'pass').length;
    if (failed > 0) steps.push(`${failed} check ${failed === 1 ? 'kind' : 'kinds'} failing`);
    else if (passed > 0) steps.push(`${passed} check ${passed === 1 ? 'kind' : 'kinds'} passing`);
    else steps.push(`${view.verified.runs.length} verification runs`);
  } else if (view.changes.files.length > 0) {
    steps.push('No verification run recorded');
  }
  if (view.changes.commits.length > 0) {
    steps.push(
      `${view.changes.commits.length} ${view.changes.commits.length === 1 ? 'commit' : 'commits'} recorded`,
    );
  }
  return steps;
}

export function ObservedBlueprintFallback({ view, cwd }: { view: SessionView; cwd: string }) {
  const chainSteps = deriveObservedChain(view);
  const clusters = groupFilesIntoClusters(view.changes.files, cwd);
  const rootPath = commonDir(view.changes.files.map((f) => f.path));
  const branchSteps = clusters
    .slice(0, 4)
    .map(
      (c) =>
        `${c.name} · ${c.files.length} ${c.files.length === 1 ? 'file' : 'files'} · +${c.linesAdded}/-${c.linesRemoved}`,
    );
  const lead =
    view.report.ask?.text ??
    view.turns[view.turns.length - 1]?.headline ??
    view.turns[view.turns.length - 1]?.prompt ??
    view.verdict.headline;

  return (
    <section className="ex is-observed-fallback" aria-label="Observed session summary">
      {lead && <p className="ex-what">{lead}</p>}
      {view.report.whatNow?.text && (
        <p className="ex-now">
          <span className="ex-now-key">Latest statement</span>
          {view.report.whatNow.text}
        </p>
      )}
      {chainSteps.length > 0 && (
        <section className="ex-block" data-diagram-tone="why">
          <header className="ex-head">
            <h2 className="ex-title">Observed Progression</h2>
          </header>
          <Chain
            steps={chainSteps}
            terminal={
              view.verdict.tone === 'pass'
                ? 'good'
                : view.verdict.tone === 'fail'
                  ? 'bad'
                  : 'accent'
            }
          />
        </section>
      )}
      {branchSteps.length > 0 && (
        <section className="ex-block" data-diagram-tone="how">
          <header className="ex-head">
            <h2 className="ex-title">Touched Subsystems</h2>
          </header>
          <Tree root={rootPath ? shortHome(rootPath) : shortHome(cwd)} steps={branchSteps} />
        </section>
      )}
      <footer className="ex-foot">
        <div className="ex-attribution">
          <p className="ex-mark">Observed Session Telemetry · Deterministic</p>
        </div>
      </footer>
    </section>
  );
}

/**
 * The explanation is the page when the Narrative lens is selected. When there is not one yet, say
 * which of the three reasons applies rather than showing one progress state for all of them.
 */
export function ExplanationPending({
  turns,
  status,
  cadence,
}: {
  turns: number;
  status: 'generating' | 'generated' | 'disabled' | 'unavailable' | 'failed' | undefined;
  cadence: 'off' | 'session' | 'turn' | undefined;
}) {
  if (turns === 0)
    return (
      <section className="ex-pending" role="status">
        <p>Nothing has happened in this session yet.</p>
      </section>
    );
  if (status === 'generating')
    return (
      <section className="ex-pending is-running" role="status">
        <p className="ex-pending-main">
          <Loading label="Reading the session" size="md" />
        </p>
        <p>
          Your selected agent is writing from a bounded, redacted summary of the session. It takes a
          few seconds, then the explanation is cached.
        </p>
      </section>
    );
  if (status === 'disabled')
    return (
      <section className="ex-pending" role="status">
        <p className="ex-pending-main">No model-written Why or How.</p>
        <p>Local only makes no model calls. Change it in Models &amp; Usage.</p>
      </section>
    );
  if (status === 'unavailable')
    return (
      <section className="ex-pending" role="status">
        <p className="ex-pending-main">No explanation for this session.</p>
        <p>
          No compatible Claude Code or Codex command is available, so nothing was sent. Observed
          facts are still available in Evidence.
        </p>
      </section>
    );
  if (status === 'failed')
    return (
      <section className="ex-pending" role="status">
        <p className="ex-pending-main">No explanation for this session.</p>
        <p>
          The selected agent was asked but returned no usable structured explanation. Observed facts
          are still available in Evidence; the next turn will try again.
        </p>
      </section>
    );
  return (
    <section className="ex-pending" role="status">
      <p className="ex-pending-main">No explanation yet.</p>
      <p>
        {cadence === 'session'
          ? 'One is written after this session ends or goes quiet.'
          : cadence === 'turn'
            ? 'One is written after the agent finishes its next reply.'
            : 'Choose when to write one in Models & Usage.'}
      </p>
    </section>
  );
}
