import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/*
 * Keeping a test away from the developer's real Claude Code and Codex state.
 *
 * Provider state is found in two ways. Code that is handed a `userHome` looks under it, unless
 * `CLAUDE_CONFIG_DIR` or `CODEX_HOME` says otherwise, in which case the variable wins. A process a
 * test spawns is handed nothing and inherits everything, so it reads the real home, and with the
 * real `claude` and `codex` on its PATH it can reach a hosted model from inside a test.
 *
 * Neither environment the developer can choose is safe for both. With the variables unset a
 * spawned daemon watches their live sessions; with them set to scratch directories every test that
 * passed its own `userHome` is silently redirected away from the files it planted. So the suite
 * owns this rather than the shell: the overrides are cleared in every worker, which lets a planted
 * `userHome` mean what it says, and every spawned process is given scratch directories of its own.
 */

/** The variables that redirect provider state away from a `userHome` a caller passed. */
export const PROVIDER_STATE_OVERRIDES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;

/** Provider command line tools a spawned daemon could otherwise find and run. */
export const PROVIDER_EXECUTABLES = ['claude', 'codex'] as const;

/**
 * Removes the provider state overrides, so code given a `userHome` resolves provider state under
 * it whatever the developer's shell exports.
 */
export function clearProviderStateOverrides(environment: NodeJS.ProcessEnv = process.env): void {
  for (const name of PROVIDER_STATE_OVERRIDES) delete environment[name];
}

/**
 * PATH without any directory that holds a provider command line tool.
 *
 * Whole directories go rather than single files because a PATH cannot hide one name inside a
 * directory. That can take unrelated tools with it, such as a Homebrew `git` beside `codex`, which
 * is why this is opt-out per spawn rather than something a test could not avoid.
 */
export function withoutProviderExecutables(
  path: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const suffixes = platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.ps1'] : [''];
  return (path ?? '')
    .split(delimiter)
    .filter(
      (directory) =>
        directory !== '' &&
        !PROVIDER_EXECUTABLES.some((name) =>
          suffixes.some((suffix) => existsSync(join(directory, `${name}${suffix}`))),
        ),
    )
    .join(delimiter);
}

export interface ProviderIsolationOptions {
  /** Keep `claude` and `codex` reachable, for a test that exercises them deliberately. */
  keepProviderExecutables?: boolean;
}

export interface ProviderIsolation {
  readonly claudeConfigDir: string;
  readonly codexHome: string;
  readonly xdgDataHome: string;
  /** The environment for a spawned daemon or CLI: `base`, then the isolation, then `overrides`. */
  environment(overrides?: NodeJS.ProcessEnv, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Removes the scratch directories. Safe to call more than once. */
  dispose(): void;
}

/**
 * Fresh, empty provider state for the processes one test spawns.
 *
 * Create one per test and pass the same one to every process in it, so a daemon and the CLI
 * commands that inspect it agree about where provider state lives.
 */
export function isolateProviders(options: ProviderIsolationOptions = {}): ProviderIsolation {
  const root = mkdtempSync(join(tmpdir(), 'salidium-providers-'));
  const claudeConfigDir = join(root, 'claude');
  const codexHome = join(root, 'codex');
  const xdgDataHome = join(root, 'xdg-data');
  for (const directory of [claudeConfigDir, codexHome, xdgDataHome]) mkdirSync(directory);
  return {
    claudeConfigDir,
    codexHome,
    xdgDataHome,
    environment(overrides = {}, base = process.env) {
      return {
        ...base,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        CODEX_HOME: codexHome,
        XDG_DATA_HOME: xdgDataHome,
        PATH: options.keepProviderExecutables ? base.PATH : withoutProviderExecutables(base.PATH),
        ...overrides,
      };
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
