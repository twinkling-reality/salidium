import { join } from 'node:path';
import {
  type HookParseContext,
  PROVIDER_ADAPTER_CONTRACT_VERSION,
  type ProviderAdapter,
  type ProviderDescriptor,
  type RecordParserContext,
  type SessionFileMatch,
} from '@salidium/adapter-kit';
import { makeSessionId } from '@salidium/protocol';
import { parseCodexHookPayload, transcriptPathFromCodexHook } from './hookPayloads.ts';
import { CodexRolloutParser } from './rolloutParser.ts';

/** ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl or ~/.codex/archived_sessions/rollout-…jsonl */
const ROLLOUT =
  /\/(?:sessions\/\d{4}\/\d{2}\/\d{2}|archived_sessions)\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/;

export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  sessionRoots(home: string): string[] {
    const codexHome = process.env.CODEX_HOME ?? join(home, '.codex');
    return [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')];
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
  adapter: codexAdapter,
} satisfies ProviderDescriptor;
