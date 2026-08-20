import type { Epistemic } from '@salidium/protocol';

/**
 * Provenance is encoded in form, not badges: observed facts render in monospace with concrete
 * values; agent-reported text renders as an attributed quote; inferred items get a dotted
 * underline; planned items a hollow marker. Only exceptions get a label.
 *
 * What is left here is the class, which History puts on a row. The badge component that rendered
 * the word went with the sections nothing reached; the two surfaces that still label provenance
 * write their own word beside the thing it qualifies.
 */
export function epistemicClass(e: Epistemic): string {
  return `ep-${e}`;
}
