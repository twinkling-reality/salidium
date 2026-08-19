import { describe, expect, it } from 'vitest';
import { SemanticChangeSchema } from './changes.ts';
import { CanonicalEventSchema } from './events.ts';
import { CanonicalTimestampSchema } from './timestamps.ts';
import { SessionSummarySchema } from './wire.ts';

describe('CanonicalTimestampSchema', () => {
  it('accepts only exact UTC millisecond timestamps', () => {
    expect(CanonicalTimestampSchema.parse('2026-08-19T12:34:56.789Z')).toBe(
      '2026-08-19T12:34:56.789Z',
    );
    for (const value of [
      '2026-08-19T12:34:56Z',
      '2026-08-19T12:34:56.78Z',
      '2026-08-19T12:34:56.7890Z',
      '2026-08-19T08:34:56.789-04:00',
      '2026-08-19 12:34:56.789Z',
      '2026-02-30T12:34:56.789Z',
      'not-a-time',
    ]) {
      expect(CanonicalTimestampSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('is enforced by event, change, and session wire envelopes', () => {
    const canonical = '2026-08-19T12:34:56.789Z';
    const noncanonical = '2026-08-19T08:34:56.789-04:00';
    const event = {
      id: 'codex:s1#notice',
      sessionId: 'codex:s1',
      ts: canonical,
      tsSource: 'ingest',
      source: { provider: 'codex', channel: 'salidium' },
      kind: 'notification',
      message: 'hello',
    };
    const change = {
      sessionId: 'codex:s1',
      seq: 1,
      ordinal: 0,
      ts: canonical,
      facet: 'status',
      summary: 'Changed',
      epistemic: 'observed',
      refs: [event.id],
    };
    const summary = {
      id: 'codex:s1',
      provider: 'codex',
      providerSessionId: 's1',
      cwd: '/repo',
      status: 'working',
      startedAt: canonical,
      latestSeq: 1,
      counts: {
        turns: 0,
        toolCalls: 0,
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        reviewOpen: 0,
        remaining: 0,
      },
    };

    expect(CanonicalEventSchema.safeParse(event).success).toBe(true);
    expect(SemanticChangeSchema.safeParse(change).success).toBe(true);
    expect(SessionSummarySchema.safeParse(summary).success).toBe(true);
    expect(CanonicalEventSchema.safeParse({ ...event, ts: noncanonical }).success).toBe(false);
    expect(SemanticChangeSchema.safeParse({ ...change, ts: noncanonical }).success).toBe(false);
    expect(SessionSummarySchema.safeParse({ ...summary, startedAt: noncanonical }).success).toBe(
      false,
    );
  });
});
