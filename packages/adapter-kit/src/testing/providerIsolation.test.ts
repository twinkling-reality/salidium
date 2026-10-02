import { describe, expect, it } from 'vitest';
import {
  clearProviderStateOverrides,
  isolateProviders,
  PROVIDER_EXECUTABLES,
} from './providerIsolation.ts';

describe('provider isolation', () => {
  it('clears every variable that redirects provider state, OpenCode store included', () => {
    const environment: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: '/real/claude',
      CODEX_HOME: '/real/codex',
      XDG_DATA_HOME: '/real/share',
      KEEP: 'yes',
    };
    clearProviderStateOverrides(environment);
    expect(environment).toEqual({ KEEP: 'yes' });
  });

  it('keeps every provider command line tool, opencode included, off a spawned PATH', () => {
    expect(PROVIDER_EXECUTABLES).toContain('opencode');
    const isolation = isolateProviders();
    try {
      const env = isolation.environment({}, { PATH: '' });
      expect(env.XDG_DATA_HOME).toBe(isolation.xdgDataHome);
    } finally {
      isolation.dispose();
    }
  });
});
