import { describe, expect, it } from 'vitest';
import {
  ExplainerCadenceRequestSchema,
  ExplainerCadenceSchema,
  ExplainerSettingsRequestSchema,
  ExplainerSettingsSchema,
} from './wire.ts';

const runtime = {
  backend: 'auto' as const,
  model: null,
  backendLocked: false,
  modelLocked: false,
  activeBackend: 'auto' as const,
  activeModel: null,
  availableBackends: ['claude', 'codex'] as const,
  routes: {
    claudeCode: { backend: 'claude' as const, model: 'claude-haiku-4-5-20251001' },
    codex: { backend: 'codex' as const, model: 'Codex CLI default (not pinned)' },
  },
};

/**
 * The wire contract for when the explainer runs.
 *
 * This is the one place the browser and the daemon agree on what a stop is, and both sides parse
 * with these schemas, so what is worth asserting is what they refuse: a cadence outside the three
 * named stops, and a usage figure that is not a whole count. A `"sometimes"` accepted here becomes
 * a daemon that stores a stop it cannot schedule.
 */
describe('the explainer settings wire', () => {
  it('names exactly three stops', () => {
    expect(ExplainerCadenceSchema.options).toEqual(['off', 'session', 'turn']);
  });

  it('refuses a stop it does not know', () => {
    expect(ExplainerCadenceRequestSchema.safeParse({ cadence: 'sometimes' }).success).toBe(false);
    expect(ExplainerCadenceRequestSchema.safeParse({}).success).toBe(false);
    expect(ExplainerCadenceRequestSchema.safeParse({ cadence: 'off' }).success).toBe(true);
  });

  it('carries the stored choice and the environment separately', () => {
    const parsed = ExplainerSettingsSchema.parse({ cadence: 'turn', envOff: true, ...runtime });
    // The choice survives being overruled. Collapsing the two into one effective cadence would
    // lose the stop the reader picked the moment the daemon was started with the switch set.
    expect(parsed).toEqual({ cadence: 'turn', envOff: true, ...runtime });
  });

  it('omits usage rather than carrying zeroes, and demands whole counts when it does carry it', () => {
    expect(
      ExplainerSettingsSchema.parse({ cadence: 'off', envOff: false, ...runtime }).usage,
    ).toBeUndefined();
    const usage = {
      messages: 3,
      inputTokens: 10,
      outputTokens: 3906,
      cacheReadTokens: 23_586,
      cacheWriteTokens: 9694,
    };
    expect(
      ExplainerSettingsSchema.parse({ cadence: 'turn', envOff: false, usage, ...runtime }).usage,
    ).toEqual(usage);
    expect(
      ExplainerSettingsSchema.safeParse({
        cadence: 'turn',
        envOff: false,
        ...runtime,
        usage: { ...usage, outputTokens: 3906.5 },
      }).success,
    ).toBe(false);
    expect(
      ExplainerSettingsSchema.safeParse({
        cadence: 'turn',
        envOff: false,
        ...runtime,
        usage: { ...usage, cacheReadTokens: -1 },
      }).success,
    ).toBe(false);
  });

  it('carries no currency figure at all', () => {
    // Tokens are observed and print as fact; money is arithmetic over a price table and on a
    // subscription no dollar is charged. Neither belongs in state, so neither is on the wire.
    expect(Object.keys(ExplainerSettingsSchema.shape)).not.toContain('cost');
    expect(Object.keys(ExplainerSettingsSchema.shape)).not.toContain('currency');
  });

  it('accepts bounded model and backend changes and refuses empty writes', () => {
    expect(ExplainerSettingsRequestSchema.safeParse({ backend: 'codex' }).success).toBe(true);
    expect(ExplainerSettingsRequestSchema.safeParse({ model: 'gpt-5.6-luna' }).success).toBe(true);
    expect(ExplainerSettingsRequestSchema.safeParse({ model: null }).success).toBe(true);
    expect(ExplainerSettingsRequestSchema.safeParse({}).success).toBe(false);
    expect(ExplainerSettingsRequestSchema.safeParse({ model: 'bad\nmodel' }).success).toBe(false);
  });
});
