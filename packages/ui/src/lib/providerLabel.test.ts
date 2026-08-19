import { describe, expect, it } from 'vitest';
import { providerLabel } from './providerLabel.ts';

describe('providerLabel', () => {
  it('names built-ins and leaves extension ids intact', () => {
    expect(providerLabel('claude-code')).toBe('Claude Code');
    expect(providerLabel('codex')).toBe('Codex');
    expect(providerLabel('example.com/acme-agent')).toBe('example.com/acme-agent');
  });
});
