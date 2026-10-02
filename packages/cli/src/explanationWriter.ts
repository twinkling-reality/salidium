import type { ExplainerSettings } from '@salidium/protocol';

/**
 * The writer in words. The local model gets its own name so it is never mistaken for Local only,
 * which means no model call at all.
 */
export function explanationWriter(settings: ExplainerSettings): string | undefined {
  if (settings.envOff || settings.cadence === 'off') return undefined;
  if (settings.activeBackend === 'ollama') {
    if (settings.ollama?.refused)
      return `Local model · Ollama (refused: ${settings.ollama.refused})`;
    const where = settings.ollama?.endpoint ? ` at ${settings.ollama.endpoint}` : '';
    return settings.activeModel
      ? `Local model · Ollama on this machine${where} · ${settings.activeModel}`
      : `Local model · Ollama on this machine${where} · no model chosen`;
  }
  const names = { claude: 'Claude Code', codex: 'Codex', ollama: 'Ollama' } as const;
  const route = (r: ExplainerSettings['routes']['claudeCode']) =>
    r.backend ? `${names[r.backend]} (${r.model ?? 'default model'})` : 'unavailable';
  if (settings.activeBackend === 'auto')
    return `same agent as the session · Claude Code sessions: ${route(settings.routes.claudeCode)}, Codex sessions: ${route(settings.routes.codex)}`;
  return route(settings.routes.claudeCode);
}
