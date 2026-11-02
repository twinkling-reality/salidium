import type { IconName } from '../components/Icon.tsx';

/** Human names for the built-ins; extension ids remain truthful instead of being called Codex. */
export function providerLabel(provider: string): string {
  if (provider === 'claude-code') return 'Claude Code';
  if (provider === 'codex') return 'Codex';
  if (provider === 'salidium/opencode') return 'OpenCode';
  return provider;
}

/** Monochrome 16px geometric vector glyph for the provider. */
export function providerIcon(provider: string): IconName {
  if (provider === 'claude-code') return 'claude';
  if (provider === 'codex') return 'codex';
  if (provider === 'salidium/opencode') return 'opencode';
  return 'terminal';
}

/** Compact model identifier for sidebar rows (strips date suffixes and redundant prefixes). */
export function shortModelLabel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model.replace(/-\d{8}$/, '').replace(/^claude-/, '');
}

/** Maps a recorded entrypoint/originator to a concise label and surface icon. */
export function entrypointMeta(
  entrypoint: string | undefined,
): { label: string; icon: IconName } | undefined {
  if (!entrypoint) return undefined;
  const lower = entrypoint.trim().toLowerCase();
  if (!lower) return undefined;
  if (lower === 'cli' || lower === 'codex_cli_rs' || lower === 'terminal') {
    return { label: 'CLI', icon: 'terminal' };
  }
  if (lower.includes('antigravity')) {
    return { label: 'Antigravity', icon: 'ide' };
  }
  if (lower.includes('vscode') || lower === 'vs-code') {
    return { label: 'VS Code', icon: 'ide' };
  }
  if (lower.includes('cursor')) {
    return { label: 'Cursor', icon: 'ide' };
  }
  if (lower.includes('zed')) {
    return { label: 'Zed', icon: 'ide' };
  }
  if (lower === 'ide' || lower === 'desktop' || lower === 'app') {
    return { label: lower === 'ide' ? 'IDE' : 'Desktop', icon: 'ide' };
  }
  if (lower.startsWith('sdk')) {
    return { label: entrypoint.toUpperCase(), icon: 'opencode' };
  }
  const isIde = /ide|code|edit|desktop|gui|window/i.test(lower);
  return { label: entrypoint, icon: isIde ? 'ide' : 'terminal' };
}
