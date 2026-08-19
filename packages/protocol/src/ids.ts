import type { ProviderId } from './provenance.ts';

/**
 * Salidium session id: `<provider>:<providerSessionId>`. Deterministic so that hook payloads
 * and transcript records for the same provider session converge on one Salidium session.
 */
export function makeSessionId(provider: ProviderId, providerSessionId: string): string {
  return `${provider}:${providerSessionId}`;
}

export function parseSessionId(id: string): { provider: string; providerSessionId: string } | null {
  const i = id.indexOf(':');
  if (i <= 0) return null;
  return { provider: id.slice(0, i), providerSessionId: id.slice(i + 1) };
}

/**
 * Deterministic event id within a session. Adapters compose these from provider identifiers
 * (tool_use_id, record uuid, rollout line number). Both channels (hook + transcript) must produce
 * the same id for the same underlying record so ingestion is idempotent.
 */
export function makeEventId(sessionId: string, ...parts: Array<string | number>): string {
  return `${sessionId}#${parts.join(':')}`;
}
