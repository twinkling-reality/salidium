import { clearProviderStateOverrides } from './packages/adapter-kit/src/testing/providerIsolation.ts';

/*
 * Runs in every worker before each test file. A developer who exports `CLAUDE_CONFIG_DIR` or
 * `CODEX_HOME` would otherwise redirect every test that plants provider state under its own
 * `userHome`. Processes a test spawns get scratch values back from `isolateProviders`.
 */
clearProviderStateOverrides();
