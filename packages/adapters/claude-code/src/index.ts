export { claudeCodeAdapter, claudeCodeProvider } from './claudeCodeAdapter.ts';
export type { HookCommandSpec, HookGroup } from './hookConfig.ts';
export { buildClaudeCodeHooks, isSalidiumHook, SALIDIUM_HOOK_MARKER } from './hookConfig.ts';
export {
  CLAUDE_CODE_HOOK_EVENTS,
  parseClaudeCodeHookPayload,
  transcriptPathFromClaudeCodeHook,
} from './hookPayloads.ts';
export { mapPlanUpdate, mapToolInput, mapToolResult, parseFailure } from './toolMapping.ts';
export { ClaudeCodeTranscriptParser } from './transcriptParser.ts';
