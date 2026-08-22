import type { ExplainerCadence } from '@salidium/protocol';

export interface ExplanationMode {
  value: ExplainerCadence;
  label: string;
  detail: string;
}

const LOCAL_ONLY: ExplanationMode = {
  value: 'off',
  label: 'Local only',
  detail: 'No model calls',
};
const WHEN_DONE: ExplanationMode = {
  value: 'session',
  label: 'When done',
  detail: 'One model call after a session ends',
};
const EACH_REPLY: ExplanationMode = {
  value: 'turn',
  label: 'Each reply',
  detail: 'One model call after each agent reply',
};

export const EXPLANATION_MODES: readonly ExplanationMode[] = [LOCAL_ONLY, WHEN_DONE, EACH_REPLY];

export function explanationMode(cadence: ExplainerCadence): ExplanationMode {
  if (cadence === 'session') return WHEN_DONE;
  if (cadence === 'turn') return EACH_REPLY;
  return LOCAL_ONLY;
}

export function parseExplanationMode(value: string | undefined): ExplainerCadence | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'local' || normalized === 'local-only') return 'off';
  if (normalized === 'session' || normalized === 'when-done') return 'session';
  if (normalized === 'turn' || normalized === 'each-reply') return 'turn';
  return undefined;
}
