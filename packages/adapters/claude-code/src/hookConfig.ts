import { CLAUDE_CODE_HOOK_EVENTS } from './hookPayloads.ts';

/**
 * Builds the `hooks` entries Salidium adds to `~/.claude/settings.json`. Every hook is an
 * async command hook running the Salidium relay script, so it never blocks or decides anything
 * and never surfaces an error in the agent's session when the daemon is down.
 */
export interface HookCommandSpec {
  type: 'command';
  command: string;
  async: true;
  timeout: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommandSpec[];
}

export const SALIDIUM_HOOK_MARKER = 'SALIDIUM_HOOK=1';
const LEGACY_SALIDIUM_HOOK_MARKER = '/.salidium/hooks/';

export function buildClaudeCodeHooks(relayCommand: string): Record<string, HookGroup[]> {
  const spec: HookCommandSpec = { type: 'command', command: relayCommand, async: true, timeout: 5 };
  const out: Record<string, HookGroup[]> = {};
  for (const event of CLAUDE_CODE_HOOK_EVENTS) {
    // SessionEnd hooks share a 1.5 s budget; keep the timeout small there.
    const hooks = event === 'SessionEnd' ? [{ ...spec, timeout: 1 }] : [spec];
    out[event] = [{ hooks }];
  }
  return out;
}

export function isSalidiumHook(spec: unknown): boolean {
  return (
    typeof spec === 'object' &&
    spec !== null &&
    typeof (spec as { command?: unknown }).command === 'string' &&
    ((spec as { command: string }).command.includes(SALIDIUM_HOOK_MARKER) ||
      (spec as { command: string }).command.includes(LEGACY_SALIDIUM_HOOK_MARKER))
  );
}
