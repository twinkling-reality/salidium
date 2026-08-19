import type { Epistemic } from '@salidium/protocol';

/**
 * Provenance is encoded in form, not badges: observed facts render in monospace with concrete
 * values; agent-reported text renders as an attributed quote; inferred items get a dotted
 * underline; planned items a hollow marker. Only exceptions get a label.
 */
export function ProvenanceMark({
  epistemic,
  author,
}: {
  epistemic: Epistemic;
  author?: 'agent' | 'user' | 'subagent';
}) {
  switch (epistemic) {
    case 'observed':
      return (
        <span className="prov prov-observed" title="Observed: recorded by the runtime or Salidium">
          <span className="sr-only">observed</span>
        </span>
      );
    case 'reported':
      return (
        <span
          className="prov prov-reported"
          title={`Reported by the ${author ?? 'agent'} — not independently verified`}
        >
          {author === 'user' ? 'you' : author === 'subagent' ? 'subagent' : 'agent'}
        </span>
      );
    case 'inferred':
      return (
        <span className="prov prov-inferred" title="Derived by Salidium from evidence (heuristic)">
          derived
        </span>
      );
    case 'planned':
      return <span className="prov prov-planned" title="Planned: from the agent's task list" />;
    case 'explained':
      return (
        <span className="prov prov-explained" title="Explanation (generated)">
          explained
        </span>
      );
  }
}

export function epistemicClass(e: Epistemic): string {
  return `ep-${e}`;
}

/** Tooltip suffix for a check whose outcome was not read from an explicit exit code. */
export const INFERRED_CHECK_HINT = 'derived from output/inferred exit';
