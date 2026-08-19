import { type DaemonInfo, ProviderIdSchema, parseSessionId } from '@salidium/protocol';

/**
 * Search the provider's own session id, while retaining arbitrary text that only happens to use a
 * colon. ProviderIdSchema is the authority here: hard-coding built-ins makes extension session ids
 * unfindable, while blindly dropping every prefix changes ordinary search text.
 */
export function sessionSearchQuery(wanted: string | undefined): string {
  if (!wanted) return '';
  const parsed = parseSessionId(wanted);
  return parsed && ProviderIdSchema.safeParse(parsed.provider).success
    ? parsed.providerSessionId
    : wanted;
}

/** A descriptor label wins; built-ins remain friendly with old daemons; unknown ids name themselves. */
export function providerDisplayName(
  provider: string,
  providers: DaemonInfo['providers'] = [],
): string {
  const descriptor = providers.find((candidate) => candidate.id === provider);
  if (descriptor?.displayName) return descriptor.displayName;
  if (provider === 'claude-code') return 'Claude Code';
  if (provider === 'codex') return 'Codex';
  return provider;
}
