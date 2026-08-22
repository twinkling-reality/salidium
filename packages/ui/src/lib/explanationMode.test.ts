import { describe, expect, it } from 'vitest';
import {
  activeExplanationCadence,
  activeExplanationMode,
  EXPLANATION_MODE_COPY,
} from './explanationMode.ts';

describe('visible explanation mode', () => {
  it('names the stored choice and applies the environment kill switch', () => {
    expect(EXPLANATION_MODE_COPY.turn.label).toBe('Each reply');
    expect(activeExplanationCadence({ cadence: 'session', envOff: false })).toBe('session');
    expect(activeExplanationMode({ cadence: 'turn', envOff: true })).toEqual({
      label: 'Local only',
      detail: 'No model calls',
    });
  });
});
