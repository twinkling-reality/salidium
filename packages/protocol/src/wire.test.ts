import { describe, expect, it } from 'vitest';
import { SessionListSchema, SessionSummarySchema } from './wire.ts';

const summary = {
  id: 'claude-code:abc',
  provider: 'claude-code',
  providerSessionId: 'abc',
  cwd: '/repo',
  status: 'ended',
  latestSeq: 3,
  counts: {
    turns: 1,
    toolCalls: 0,
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    reviewOpen: 0,
    remaining: 0,
  },
};

const list = { sessions: [summary], matched: 76, total: 740, query: 'sample-app' };

describe('SessionListSchema', () => {
  it('carries the rows, what matched, what was searched, and the query it answers', () => {
    const parsed = SessionListSchema.parse(list);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.matched).toBe(76);
    expect(parsed.total).toBe(740);
    expect(parsed.query).toBe('sample-app');
    expect(SessionSummarySchema.parse(parsed.sessions[0]).id).toBe('claude-code:abc');
  });

  it('accepts the shapes the panel actually has to render', () => {
    // Nothing matched: the rows are empty but the two counts are still facts about the store.
    expect(SessionListSchema.parse({ ...list, sessions: [], matched: 0 }).total).toBe(740);
    // The default view asks for the counts and no rows, so the query is the empty string.
    expect(
      SessionListSchema.parse({ sessions: [], matched: 740, total: 740, query: '' }).query,
    ).toBe('');
    // An empty store: every number is zero and none of them is missing.
    expect(SessionListSchema.parse({ sessions: [], matched: 0, total: 0, query: '' }).total).toBe(
      0,
    );
  });

  it('refuses counts that could not have been counted', () => {
    expect(() => SessionListSchema.parse({ ...list, matched: -1 })).toThrow();
    expect(() => SessionListSchema.parse({ ...list, total: 1.5 })).toThrow();
    expect(() => SessionListSchema.parse({ ...list, total: '740' })).toThrow();
  });

  it('refuses an envelope missing a field the panel would then have to invent', () => {
    for (const drop of ['sessions', 'matched', 'total', 'query'] as const) {
      const { [drop]: _gone, ...rest } = list;
      expect(() => SessionListSchema.parse(rest)).toThrow();
    }
  });
});
