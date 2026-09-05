import { CLAUDE_CODE_HOOK_EVENT_BUDGET } from './hookPayloads.ts';

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
  const out: Record<string, HookGroup[]> = {};
  for (const { name: event, pressure } of CLAUDE_CODE_HOOK_EVENT_BUDGET.events) {
    const spec: HookCommandSpec = {
      type: 'command',
      command: `${relayCommand} ${event} ${pressure}`,
      async: true,
      timeout: 5,
    };
    // SessionEnd hooks share a 1.5 s budget; keep the timeout small there.
    const hooks = event === 'SessionEnd' ? [{ ...spec, timeout: 1 }] : [spec];
    out[event] = [{ hooks }];
  }
  return out;
}

export function isSalidiumHook(spec: unknown): boolean {
  if (
    typeof spec !== 'object' ||
    spec === null ||
    typeof (spec as { command?: unknown }).command !== 'string'
  )
    return false;
  const command = (spec as { command: string }).command.trim();
  const current =
    command.startsWith(`${SALIDIUM_HOOK_MARKER} '`) && /\/hooks\/relay\.sh'(?:\s|$)/.test(command);
  const legacy = /^(?:\/bin\/sh\s+)?['"]?[^\s'"]*\/\.salidium\/hooks\//.test(command);
  return current || (command.includes(LEGACY_SALIDIUM_HOOK_MARKER) && legacy);
}
