import type { ExplainerSettings } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { explanationWriter } from './explanationWriter.ts';

const base: ExplainerSettings = {
  cadence: 'session',
  backend: 'auto',
  model: null,
  envOff: false,
  backendLocked: false,
  modelLocked: false,
  activeBackend: 'auto',
  activeModel: null,
  availableBackends: ['claude', 'codex'],
  routes: {
    claudeCode: { backend: 'claude', model: 'claude-haiku-4-5-20251001' },
    codex: { backend: 'codex', model: 'Codex CLI default (not pinned)' },
  },
};

describe('salidium explanations names the writer', () => {
  it('names a local Ollama model distinctly from Local only', () => {
    const route = { backend: 'ollama' as const, model: 'qwen:1b · Ollama' };
    expect(
      explanationWriter({
        ...base,
        backend: 'ollama',
        activeBackend: 'ollama',
        model: 'qwen:1b',
        activeModel: 'qwen:1b',
        routes: { claudeCode: route, codex: route },
        ollama: { endpoint: 'http://127.0.0.1:11434', refused: null },
      }),
    ).toBe('Local model · Ollama on this machine at http://127.0.0.1:11434 · qwen:1b');
  });

  it('says when the local route has no model or a refused address', () => {
    const ollama = { ...base, backend: 'ollama' as const, activeBackend: 'ollama' as const };
    expect(
      explanationWriter({ ...ollama, ollama: { endpoint: null, refused: 'not loopback' } }),
    ).toBe('Local model · Ollama (refused: not loopback)');
    expect(explanationWriter(ollama)).toBe(
      'Local model · Ollama on this machine · no model chosen',
    );
  });

  it('says nothing about a writer when no model call will be made', () => {
    expect(explanationWriter({ ...base, cadence: 'off' })).toBeUndefined();
    expect(explanationWriter({ ...base, envOff: true })).toBeUndefined();
  });

  it('names both agent routes under auto', () => {
    expect(explanationWriter(base)).toContain('Claude Code sessions: Claude Code');
  });
});
