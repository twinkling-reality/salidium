import { describe, expect, it } from 'vitest';
import { providerDisplayName, sessionSearchQuery } from './showSession.ts';

describe('show session provider handling', () => {
  it('searches the provider session suffix for built-in and namespaced full ids', () => {
    expect(sessionSearchQuery('claude-code:session-1')).toBe('session-1');
    expect(sessionSearchQuery('example/agent:session-2')).toBe('session-2');
  });

  it('does not reinterpret arbitrary colon-shaped search text as a provider id', () => {
    expect(sessionSearchQuery('Not/A/Provider:session-2')).toBe('Not/A/Provider:session-2');
    expect(sessionSearchQuery('project: task')).toBe('project: task');
  });

  it('uses descriptor labels and never calls an unknown provider Codex', () => {
    expect(
      providerDisplayName('example/agent', [
        {
          id: 'example/agent',
          displayName: 'Example Agent',
          hooksInstalled: false,
          sourcesWatched: 0,
        },
      ]),
    ).toBe('Example Agent');
    expect(providerDisplayName('another/agent')).toBe('another/agent');
    expect(providerDisplayName('claude-code')).toBe('Claude Code');
    expect(providerDisplayName('codex')).toBe('Codex');
  });
});
