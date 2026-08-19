/**
 * The flow diagrams — the page's main canvas.
 *
 * Every connector is drawn by the stylesheet: a stem is an element with a background, a junction
 * is a rule spanning the lanes it gathers, an arrowhead is a rotated border. Nothing is typed as a
 * box character, so the words stay selectable, translatable and reflowable, and the geometry can
 * never drift out of step with the text at a different width.
 *
 * Four shapes, chosen by what is being explained rather than applied uniformly:
 *  - `Chain`       — a run of steps, cause to effect, read left to right.
 *  - `Converge`    — concurrent lanes whose paths meet at a junction and continue as one trunk.
 *  - `Tree`        — a component with the operations that hang beneath it.
 *  - `BeforeAfter` — the abandoned path above its replacement, with the reason on the pivot.
 *
 * Steps are at most six words (the schema enforces it), so a node is a phrase, never a paragraph.
 */

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
  /** How the run ends: the result it reached, an abandoned path, or nothing in particular. */
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
 * lane onto one bus and drops a single trunk out of its centre — which is the whole point of the
 * shape, because a reader has to see that two separate things met before anything else makes
 * sense. The trunk then continues as an ordinary chain.
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

/**
 * Where several paths become one, or one path becomes several. A stem rises from the centre of
 * each column, a bus spans from the first centre to the last, and a single trunk leaves the
 * middle. Both insets are derived from the column count, so the drawing is exact for any number of
 * lanes without measuring anything in JavaScript.
 */
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
 * A component and the operations that hang beneath it. The root is named exactly as it appears in
 * the evidence, so it is set in the monospace face every other measured value uses; the branches
 * fan out of it through the same junction the lanes converge through, run the other way.
 */
export function Tree({ root, steps }: { root: string | null; steps: string[] }) {
  if (steps.length === 0) return null;
  // Without a root there is nothing for the branches to hang from, so they are drawn as a plain
  // set rather than a tree. A spine descending from empty space would assert a parent we do not
  // have — the model returns null here precisely when the work has no single centre.
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

/**
 * The path that was abandoned, above the one that replaced it, with the reason on the pivot
 * between them. Stacked rather than side by side so the two runs line up step against step: the
 * comparison is the content, and a reader should be able to make it without moving their eyes
 * across a gutter and back.
 */
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

/**
 * What the marks on this page mean — printed only for the marks a given session actually drew, so
 * it stays a legend and never becomes a manual.
 */
export function Legend({ marks }: { marks: Marks }) {
  const items: Array<[string, string]> = [];
  /*
   * No entry for the plain chain: an arrow between two boxes already says "then". None for the
   * tree either, by the same rule and after two attempts at wording one — a trunk fanning out of
   * a named box into a row of boxes has already said that those are its parts, and a line saying
   * so is a caption on a picture that does not need one. What is left names the two things a
   * shape cannot say for itself: that separate paths merged here, and which colour meant
   * abandoned.
   */
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
