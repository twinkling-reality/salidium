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
import { parseClaudeCodeHookPayload, transcriptPathFromClaudeCodeHook } from './hookPayloads.ts';
import { ClaudeCodeTranscriptParser } from './transcriptParser.ts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** ~/.claude/projects/<slug>/<sessionId>.jsonl */
const MAIN_FILE = new RegExp(`/projects/[^/]+/(${UUID})\\.jsonl$`);
/** ~/.claude/projects/<slug>/<sessionId>/subagents/(workflows/<wf>/)?agent-<agentId>.jsonl */
const SUBAGENT_FILE = new RegExp(
  `/projects/[^/]+/(${UUID})/subagents/(?:[^/]+/)*agent-([0-9a-z]+)\\.jsonl$`,
);

export const claudeCodeAdapter: ProviderAdapter = {
  id: 'claude-code',
  sessionRoots(home: string): string[] {
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
    return [join(configDir, 'projects')];
  },
  matchSessionFile(path: string): SessionFileMatch | undefined {
    const normalizedPath = path.replaceAll('\\', '/');
    const main = MAIN_FILE.exec(normalizedPath);
    if (main?.[1])
      return { sessionId: makeSessionId('claude-code', main[1]), providerSessionId: main[1] };
    const sub = SUBAGENT_FILE.exec(normalizedPath);
    if (sub?.[1] && sub[2])
      return {
        sessionId: makeSessionId('claude-code', sub[1]),
        providerSessionId: sub[1],
        agentId: sub[2],
      };
    return undefined;
  },
  createRecordParser(ctx: RecordParserContext) {
    return new ClaudeCodeTranscriptParser(ctx);
  },
  parseHookPayload(payload: unknown, ctx: HookParseContext) {
    return parseClaudeCodeHookPayload(payload, ctx);
  },
  transcriptPathFromHook(payload: unknown) {
    return transcriptPathFromClaudeCodeHook(payload);
  },
};

export const claudeCodeProvider = {
  contractVersion: PROVIDER_ADAPTER_CONTRACT_VERSION,
  displayName: 'Claude Code',
  adapter: claudeCodeAdapter,
} satisfies ProviderDescriptor;
