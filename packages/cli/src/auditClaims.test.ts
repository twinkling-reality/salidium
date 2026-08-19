import { describe, expect, it } from 'vitest';
import { type AuditOptions, auditClaims, renderAudit } from './auditClaims.ts';

/**
 * The audit is the standing answer to "the confidence model was tuned on one corpus". It is only
 * worth anything if two runs over the same store agree, so the sampling is seeded and the counts
 * are exact.
 */
const OPTS: AuditOptions = { sample: 3, only: [], seed: 7, limit: 1000, json: false };

const CORPUS = [
  {
    messages: [
      // Asserted: a first-person forward statement, and a runner outcome.
      {
        text: "I'll start by reading the script and getting the CI failure logs.",
        phase: 'commentary' as const,
      },
      { text: 'All 36 E2E tests pass across desktop and mobile.', phase: 'commentary' as const },
      // Not narration at all: a Codex reasoning header, wrapped whole in bold.
      { text: '**Evaluating guest draft persistence gaps**', phase: 'commentary' as const },
      // Recorded, asserted nowhere: a list header, and prose that mentions "remaining".
      { text: 'Key decisions and changes:', phase: 'commentary' as const },
      {
        text: 'Two things I did not do, so you can decide: Records is still 2,730px, over half the remaining page.',
        phase: 'commentary' as const,
      },
    ],
  },
  {
    messages: [
      {
        text: 'Found it: the tailer re-read the partial line bytes twice.',
        phase: 'commentary' as const,
      },
      { text: 'Still need to wire the adapter for Codex hooks', phase: 'final' as const },
    ],
  },
];

describe('auditClaims', () => {
  const r = auditClaims(CORPUS, OPTS);

  it('counts what was seen, what was silent, and what was actually asserted', () => {
    expect(r.sessions).toBe(2);
    expect(r.messages).toBe(7);
    // The reasoning header produces no claim at all; it is not a weaker claim, it is not one.
    expect(r.silentMessages).toBe(1);
    expect(r.asserted).toBe(4);
    expect(r.byKind.approach).toBe(1);
    expect(r.byKind.verification).toBe(1);
    expect(r.byKind.discovery).toBe(1);
    expect(r.byKind.remaining).toBe(1);
  });

  it('separates recorded from asserted, so a near miss cannot be mistaken for a claim', () => {
    // Both of these read like claims and are stated nowhere; the rule that nearly fired is kept.
    expect(r.byKind.other).toBe(2);
    expect(r.byRule['other/announces-list']).toBe(1);
    expect(r.byRule['other/task-word-in-body']).toBe(1);
    expect(r.asserted + (r.byKind.other ?? 0)).toBe(r.claims);
  });

  it('samples reproducibly, because an audit nobody can re-run is an anecdote', () => {
    const again = auditClaims(CORPUS, OPTS);
    expect(again.samples).toEqual(r.samples);
    const different = auditClaims(CORPUS, { ...OPTS, seed: 99 });
    expect(different.byRule).toEqual(r.byRule);
  });

  it('takes every claim when a rule has fewer than the sample size', () => {
    expect(r.samples['approach/intent-modal-lead']).toHaveLength(1);
  });

  it('reports markdown that survived the flatten', () => {
    expect(r.markdownLeaks).toBe(0);
  });

  it('renders a report a person can read, and JSON a script can', () => {
    const text = renderAudit(r, OPTS);
    expect(text).toContain('CLAIMS AUDIT');
    expect(text).toContain('approach/intent-modal-lead');
    expect(JSON.parse(renderAudit(r, { ...OPTS, json: true })).claims).toBe(r.claims);
  });
});
