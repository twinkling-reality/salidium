import type { CanonicalEvent, CanonicalTimestamp, ProviderId } from '@salidium/protocol';

export interface SessionFileMatch {
  /** Salidium session id (provider:providerSessionId) this file belongs to. */
  sessionId: string;
  providerSessionId: string;
  /** Sub-agent lane id when the file is a subagent transcript. */
  agentId?: string;
}

export interface RecordParserContext {
  sessionId: string;
  providerSessionId: string;
  agentId?: string;
  path: string;
  /** Canonical instant this parser generation began observing the source. */
  observedAt: CanonicalTimestamp;
}

/**
 * Stateful parser for one provider session file. Adapters keep per-file state (e.g. the map
 * from tool call id to tool name/input) so a result record can be normalized without the daemon
 * knowing provider details. `parseRecord` receives one raw line and its 0-based line number.
 */
export interface RecordParser {
  parseRecord(line: string, lineNo: number): CanonicalEvent[];
}

export interface HookParseContext {
  /** Exact UTC millisecond time the daemon received the payload (hooks carry no timestamps). */
  receivedAt: CanonicalTimestamp;
}

export interface HookInstallPlan {
  /** Human-readable description of what will be written where. */
  description: string;
  /** Path of the settings file to modify. */
  settingsPath: string;
  /** Events the hooks subscribe to. */
  events: string[];
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  /** Directories to watch for session files (absolute; ~ expanded by the daemon). */
  sessionRoots(home: string): string[];
  /** Whether a path is a session file for this provider, and which session it belongs to. */
  matchSessionFile(path: string): SessionFileMatch | undefined;
  createRecordParser(ctx: RecordParserContext): RecordParser;
  /** Hook payload (already parsed JSON) → events. Returns [] for unknown/irrelevant payloads. */
  parseHookPayload(payload: unknown, ctx: HookParseContext): CanonicalEvent[];
  /** Extracts the transcript path a hook payload advertises, so the daemon can start tailing. */
  transcriptPathFromHook(
    payload: unknown,
  ): { sessionId: string; path: string; cwd?: string } | undefined;
}
