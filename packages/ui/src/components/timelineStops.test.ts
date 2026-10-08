import type { SemanticChange } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { stopAt, timelineSegments, timelineStops } from './timelineStops.ts';

const at = (minute: number) => `2026-10-07T09:${String(minute).padStart(2, '0')}:00.000Z`;
const change = (minute: number, seq: number): SemanticChange => ({
  sessionId: 'session',
  ts: at(minute),
  seq,
  ordinal: 0,
  facet: 'what',
  summary: 'Recorded change',
  epistemic: 'observed',
  refs: [],
});
const turn = (index: number, minute: number, prompt = `Request ${index + 1}`) => ({
  id: `turn-${index}`,
  index,
  prompt,
  startedAt: at(minute),
});

describe('timeline replay stops', () => {
  it('merges simultaneous changes and retains all state already reached by sequence', () => {
    const stops = timelineStops([change(1, 9), change(1, 10), change(2, 5), change(3, 12)]);
    expect(stops).toEqual([
      { ts: at(1), seq: 10 },
      { ts: at(2), seq: 10 },
      { ts: at(3), seq: 12 },
    ]);
  });

  it('resolves an external history moment even when that timestamp has no change stop', () => {
    const stops = timelineStops([change(2, 2), change(4, 4)]);
    expect(stopAt(stops, at(1))).toBe(-1);
    expect(stopAt(stops, at(2))).toBe(0);
    expect(stopAt(stops, at(3))).toBe(0);
    expect(stopAt(stops, at(5))).toBe(1);
    expect(stopAt([], at(5))).toBe(-1);
  });
});

describe('recorded turn segments', () => {
  it('orders recorded turns and chooses actual stops within each turn chapter', () => {
    const stops = timelineStops([change(0, 0), change(2, 2), change(5, 5), change(8, 8)]);
    const segments = timelineSegments([turn(1, 5), turn(0, 1)], stops);
    expect(segments.map((segment) => [segment.id, segment.target])).toEqual([
      ['turn-0', 1],
      ['turn-1', 2],
    ]);
    expect(segments[0]?.nextAt).toBe(at(5));
  });

  it('keeps unavailable turns from selecting the previous or next turn in a partial snapshot', () => {
    const segments = timelineSegments(
      [turn(0, 1), turn(1, 4), turn(2, 8)],
      timelineStops([change(0, 0), change(4, 4), change(5, 5)]),
    );
    expect(segments.map((segment) => segment.target)).toEqual([undefined, 1, undefined]);
  });

  it('recomputes target positions when the full history replaces a recent snapshot', () => {
    const turns = [turn(0, 1), turn(1, 4)];
    const partial = timelineSegments(turns, timelineStops([change(4, 4)]));
    const complete = timelineSegments(
      turns,
      timelineStops([change(1, 1), change(2, 2), change(4, 4)]),
    );
    expect(partial.map((segment) => segment.target)).toEqual([undefined, 0]);
    expect(complete.map((segment) => segment.target)).toEqual([0, 2]);
  });

  it('uses supplied headline or request text, with a one-based neutral fallback', () => {
    const segments = timelineSegments(
      [
        { ...turn(0, 1), headline: '  Recorded headline  ' },
        turn(1, 2, '  Request text  '),
        turn(2, 3, ''),
      ],
      [],
    );
    expect(segments.map((segment) => segment.title)).toEqual([
      'Recorded headline',
      'Request text',
      'Turn 3',
    ]);
    expect(timelineSegments([], [])).toEqual([]);
  });

  it('does not offer two different replay states for turns beginning at the same timestamp', () => {
    const segments = timelineSegments([turn(0, 1), turn(1, 1)], timelineStops([change(1, 1)]));
    expect(segments.map((segment) => segment.target)).toEqual([undefined, 0]);
  });
});
