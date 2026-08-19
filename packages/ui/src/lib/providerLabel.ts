/** Human names for the built-ins; extension ids remain truthful instead of being called Codex. */
export function providerLabel(provider: string): string {
  if (provider === 'claude-code') return 'Claude Code';
  if (provider === 'codex') return 'Codex';
  return provider;
}
