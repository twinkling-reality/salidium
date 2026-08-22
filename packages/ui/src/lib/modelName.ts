const CODEX_AUTOMATIC = 'Codex CLI default (not pinned)';

/** Translate the daemon's exact routing label into language meant for the interface. */
export function modelName(model: string | null | undefined): string {
  return model === CODEX_AUTOMATIC ? 'Automatic' : (model ?? 'Unavailable');
}

export function isAutomaticModel(model: string | null | undefined): boolean {
  return model === CODEX_AUTOMATIC;
}
