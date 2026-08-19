import { CODEX_HOOK_EVENTS } from './hookPayloads.ts';

/**
 * Builds the `~/.codex/hooks.json` entries. Codex runs only `command` handlers and requires the
 * user to trust non-managed hooks once (`/hooks` in the TUI or the desktop app's hooks screen);
 * trust is a hash of the hook definition, so a stable relay command survives Salidium upgrades.
 */
export const SALIDIUM_HOOK_MARKER = 'SALIDIUM_HOOK=1';
const LEGACY_SALIDIUM_HOOK_MARKER = '/.salidium/hooks/';

export function buildCodexHooks(relayCommand: string): {
  hooks: Record<
    string,
    Array<{ hooks: Array<{ type: 'command'; command: string; async: boolean; timeout: number }> }>
  >;
} {
  const hooks: Record<
    string,
    Array<{ hooks: Array<{ type: 'command'; command: string; async: boolean; timeout: number }> }>
  > = {};
  for (const event of CODEX_HOOK_EVENTS) {
    hooks[event] = [
      {
        hooks: [
          {
            type: 'command',
            command: relayCommand,
            async: event !== 'SessionEnd',
            timeout: event === 'SessionEnd' ? 1 : 5,
          },
        ],
      },
    ];
  }
  return { hooks };
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
