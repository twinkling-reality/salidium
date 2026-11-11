import { join } from 'node:path';
import {
  expandSourceList,
  type HookParseContext,
  PROVIDER_ADAPTER_CONTRACT_VERSION,
  type ProviderAdapter,
  type ProviderDescriptor,
  type RecordParserContext,
  type SessionFileMatch,
} from '@salidium/adapter-kit';
import { makeSessionId } from '@salidium/protocol';
import {
  CODEX_HOOK_EVENT_BUDGET,
  parseCodexHookPayload,
  transcriptPathFromCodexHook,
} from './hookPayloads.ts';
import { CodexRolloutParser } from './rolloutParser.ts';

/** ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl or ~/.codex/archived_sessions/rollout-…jsonl */
const ROLLOUT =
  /\/(?:sessions\/\d{4}\/\d{2}\/\d{2}|archived_sessions)\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/;

/**
 * Codex homes read beside the default one, for a local tool that runs Codex in homes of its own.
 * Colon-separated absolute paths; one component of a path may be a `*` pattern (`.../homes/*`),
 * which matches only real folders, never links. See `expandSourceList`.
 */
export const CODEX_EXTRA_HOMES_ENV = 'SALIDIUM_EXTRA_CODEX_HOMES';

/**
 * Every Codex home read now: `CODEX_HOME` (else `~/.codex`) first, always, then the extra homes.
 * The default is never replaced, because Salidium's Codex hooks live in it and a hook's
 * transcript path is only followed under these homes.
 */
export function codexHomes(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const homes = [env.CODEX_HOME ?? join(home, '.codex')];
  for (const extra of expandSourceList(env[CODEX_EXTRA_HOMES_ENV], 'directory'))
    if (!homes.includes(extra)) homes.push(extra);
  return homes;
}

export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  sessionRoots(home: string): string[] {
    return codexHomes(home).flatMap((codexHome) => [
      join(codexHome, 'sessions'),
      join(codexHome, 'archived_sessions'),
    ]);
  },
  matchSessionFile(path: string): SessionFileMatch | undefined {
    const normalizedPath = path.replaceAll('\\', '/');
    const m = ROLLOUT.exec(normalizedPath);
    if (!m?.[1]) return undefined;
    return { sessionId: makeSessionId('codex', m[1]), providerSessionId: m[1] };
  },
  createRecordParser(ctx: RecordParserContext) {
    return new CodexRolloutParser(ctx);
  },
  parseHookPayload(payload: unknown, ctx: HookParseContext) {
    return parseCodexHookPayload(payload, ctx);
  },
  transcriptPathFromHook(payload: unknown) {
    return transcriptPathFromCodexHook(payload);
  },
};

export const codexProvider = {
  contractVersion: PROVIDER_ADAPTER_CONTRACT_VERSION,
  displayName: 'Codex',
  hookEventBudget: CODEX_HOOK_EVENT_BUDGET,
  adapter: codexAdapter,
} satisfies ProviderDescriptor;
