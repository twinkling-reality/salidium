import { clearProviderStateOverrides } from './packages/adapter-kit/src/testing/providerIsolation.ts';

/*
 * Runs in every worker before each test file. A developer who exports `CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME` or `XDG_DATA_HOME` would otherwise redirect every test that plants provider state
 * under its own `userHome`, and point OpenCode discovery at their real store. Processes a test
 * spawns get scratch values back from `isolateProviders`.
 */
clearProviderStateOverrides();
