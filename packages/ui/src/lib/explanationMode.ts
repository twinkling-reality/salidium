import type { ExplainerCadence, ExplainerSettings } from '@salidium/protocol';

export const EXPLANATION_MODE_COPY: Record<ExplainerCadence, { label: string; detail: string }> = {
  off: { label: 'Local only', detail: 'No model calls' },
  session: { label: 'When done', detail: 'One model call after the session ends' },
  turn: { label: 'Each reply', detail: 'One model call after every agent reply' },
};

export function activeExplanationCadence(
  settings: Pick<ExplainerSettings, 'cadence' | 'envOff'> | undefined,
): ExplainerCadence | undefined {
  if (!settings) return undefined;
  return settings.envOff ? 'off' : settings.cadence;
}

export function activeExplanationMode(
  settings: Pick<ExplainerSettings, 'cadence' | 'envOff'> | undefined,
) {
  const cadence = activeExplanationCadence(settings);
  return cadence ? EXPLANATION_MODE_COPY[cadence] : undefined;
}
