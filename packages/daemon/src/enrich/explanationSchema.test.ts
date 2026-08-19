import { ExplanationEventSchema } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { PROMPT, SCHEMA } from './explainer.ts';

/**
 * The explanation contract exists twice: as the JSON schema handed to `claude -p`, and as the zod
 * schema the reply is validated against before it becomes an event. Only the second one decides.
 *
 * Letting them drift reproduces the exact failure this session was fixing, but silently and worse:
 * the CLI would accept a payload its own schema allowed, zod would reject it on the way in, and a
 * cheap CLI-side retry — which recovered 208 of 230 rejected runs — would become a hard `failed`
 * with no explanation at all. So the numbers are asserted against each other, not just written
 * twice, and the count the prompt tells the model to aim for is asserted with them.
 */

const step = 'a step of six words here';
const list = (n: number) => Array.from({ length: n }, (_, i) => `${step} ${i}`);

/** A payload valid in every respect except the one array under test. */
function payload(over: Partial<Record<'chain' | 'steps' | 'lanes' | 'from' | 'to', number>> = {}) {
  return {
    kind: 'salidium.explanation' as const,
    id: 's#explanation:1',
    sessionId: 's',
    ts: '2026-08-18T10:00:00.000Z',
    tsSource: 'ingest' as const,
    source: { provider: 'claude-code' as const, channel: 'salidium' as const },
    basedOnSeq: 1,
    model: 'claude-haiku-4-5-20251001',
    what: { summary: 'A summary.', currently: null },
    why: {
      summary: 'A summary.',
      lanes: Array.from({ length: over.lanes ?? 0 }, (_, i) => ({
        title: `lane ${i}`,
        steps: list(2),
      })),
      chain: list(over.chain ?? 3),
    },
    how: { summary: 'A summary.', root: 'the module', steps: list(over.steps ?? 3) },
    approachChange:
      over.from === undefined && over.to === undefined
        ? null
        : {
            from: 'the old way',
            fromSteps: list(over.from ?? 2),
            why: 'It did not work.',
            to: 'the new way',
            toSteps: list(over.to ?? 2),
          },
  };
}

const accepts = (p: ReturnType<typeof payload>) => ExplanationEventSchema.safeParse(p).success;

const s = SCHEMA.properties;
const CASES = [
  ['why.chain', s.why.properties.chain, (n: number) => payload({ chain: n })],
  ['how.steps', s.how.properties.steps, (n: number) => payload({ steps: n })],
  [
    'approachChange.fromSteps',
    s.approachChange.properties.fromSteps,
    (n: number) => payload({ from: n, to: 2 }),
  ],
  [
    'approachChange.toSteps',
    s.approachChange.properties.toSteps,
    (n: number) => payload({ from: 2, to: n }),
  ],
] as const;

describe('explanation schema: the JSON copy and the zod copy agree', () => {
  for (const [name, json, build] of CASES) {
    it(`${name} accepts exactly ${json.minItems}..${json.maxItems} items in both`, () => {
      expect(accepts(build(json.maxItems))).toBe(true);
      expect(accepts(build(json.maxItems + 1))).toBe(false);
      expect(accepts(build(json.minItems))).toBe(true);
      if (json.minItems > 0) expect(accepts(build(json.minItems - 1))).toBe(false);
    });
  }

  it('why.lanes agrees, including the per-lane step cap', () => {
    expect(accepts(payload({ lanes: SCHEMA.properties.why.properties.lanes.maxItems }))).toBe(true);
    expect(accepts(payload({ lanes: SCHEMA.properties.why.properties.lanes.maxItems + 1 }))).toBe(
      false,
    );
  });

  /*
   * The caps sit one above the count the prompt names, so the model aims at five and the schema
   * absorbs the rare six instead of paying for a retry. If someone lowers a cap to the stated
   * number, the residual overshoot starts costing runs again; if someone raises the stated number,
   * the diagram silently gets a column narrower. Either way both halves have to move together.
   */
  it('states a count in the prompt that is one below the cap the schema enforces', () => {
    expect(PROMPT).toContain('why.chain has at most 5 steps and how.steps at most 5');
    expect(s.why.properties.chain.maxItems).toBe(6);
    expect(s.how.properties.steps.maxItems).toBe(6);
  });
});
