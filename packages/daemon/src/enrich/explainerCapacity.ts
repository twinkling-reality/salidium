/** Built-in generator output is rejected before it can grow memory or reach JSON parsing. */
export const MAX_EXPLAINER_OUTPUT_BYTES = 128 * 1024;
/**
 * A hard ceiling on concurrent generator calls shared by explanations and presentation-only
 * personalization, whether the generator is a CLI process or a loopback Ollama request.
 */
export const MAX_EXPLAINER_PROCESSES = 2;

let active = 0;

/** Takes one slot or throws; the returned function gives it back exactly once. */
export function acquireExplainerSlot(): () => void {
  if (active >= MAX_EXPLAINER_PROCESSES)
    throw new Error(`explainer process limit reached (${MAX_EXPLAINER_PROCESSES})`);
  active += 1;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    active -= 1;
  };
}
