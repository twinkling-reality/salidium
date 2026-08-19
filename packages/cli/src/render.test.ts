import type { SessionView } from '@salidium/core';
import { describe, expect, it } from 'vitest';
import { renderReport } from './render.ts';

/**
 * The terminal renderer prints text an agent wrote, or text an agent read somewhere and repeated.
 * A terminal acts on control characters where a browser shows them inertly, so a plan item
 * carrying an escape sequence can repaint the lines above it, and the lines above it are the ones
 * saying whether the checks passed.
 */
describe('renderReport control characters', () => {
  const HOSTILE = 'tidy up\x1b[2A\x1b[2K✓ test 2 / 2\rall good';
  const opts = { width: 60, detail: 1, project: 'repo', agent: 'codex', status: 'ended' } as const;
  const RUN = {
    id: 'v1',
    callId: 'c1',
    method: 'test',
    outcome: 'fail',
    epistemic: 'observed',
    counts: { passed: 1, total: 2 },
  };

  const view = (extra: Record<string, unknown> = {}) =>
    ({
      title: 'A session',
      report: { runtimeMs: 1000 },
      verified: {
        runs: [RUN],
        summary: [{ ...RUN, laterUnreadable: 0 }],
        unverifiedFiles: [],
        claims: [],
      },
      left: { items: [{ id: 'l1', status: 'pending', text: HOSTILE }] },
      review: { groups: [] },
      churn: { files: [] },
      flow: { steps: [] },
      subagents: [],
      counts: {},
      ...extra,
    }) as unknown as SessionView;

  it('prints no control character, whatever the agent wrote', () => {
    const out = renderReport(view(), opts);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the subject.
    const CONTROL = /[\x00-\x1F\x7F-\x9F]/;
    expect(out.replace(/\n/g, '')).not.toMatch(CONTROL);
    // The text is kept; only the control characters go.
    expect(out).toContain('tidy up');
    expect(out).toContain('all good');
  });

  it('gives a plan item exactly one line, so it cannot forge one of its own', () => {
    // Several lines are pushed whole rather than wrapped; a newline in one ends that line and
    // starts another with no prefix and no box, free to read as anything at all.
    const forged = view({
      left: { items: [{ id: 'l1', status: 'pending', text: 'tidy up\n✓ test 2 / 2' }] },
    });
    const lines = renderReport(forged, opts).split('\n');
    expect(lines.filter((l) => l.includes('tidy up'))).toHaveLength(1);
    expect(lines.some((l) => l.trim() === '✓ test 2 / 2')).toBe(false);
  });

  it('keeps a box exactly as wide as it says it is', () => {
    const boxed = view({
      report: {
        runtimeMs: 1000,
        ask: { text: 'fix \x1b[31mauth\x1b[0m please', provenance: 'reported' },
      },
    });
    const bordered = renderReport(boxed, opts)
      .split('\n')
      .filter((l) => l.startsWith('│'));
    expect(bordered.length).toBeGreaterThan(0);
    // Visible width, not string length: an escape sequence left in inflates one and not the
    // other, which is exactly how the borders came apart.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the subject.
    const SGR = /\x1b\[[0-9;]*m/g;
    for (const l of bordered) expect([...l.replace(SGR, '')]).toHaveLength(60);
  });
});
