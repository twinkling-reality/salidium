import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export interface TrustedPathOptions {
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
}

function normalized(path: string, platform: NodeJS.Platform): string {
  const value = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return platform === 'win32' ? value.toLowerCase() : value;
}

function trusted(path: string, platform: NodeJS.Platform): boolean {
  const value = normalized(path, platform);
  return !/(^|\/)node_modules\/\.bin($|\/)/.test(value);
}

/**
 * PATH entries inherited from a package runner can put the current project's binaries first.
 * They are not an installation boundary: a dependency in the repository can supply a same-named
 * executable and receive daemon tokens, prompts, or provider credentials. Keep only absolute,
 * existing directories outside every `node_modules/.bin`. Absolute user paths remain valid even
 * when Salidium was started from the user's home directory.
 */
export function trustedPathEntries(options: TrustedPathOptions = {}): string[] {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = environment.PATH;
  if (!path) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of path.split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const directory = realpathOrSelf(entry);
    if (!trusted(directory, platform)) continue;
    try {
      if (!statSync(directory).isDirectory()) continue;
    } catch {
      continue;
    }
    const key = normalized(directory, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(directory);
  }
  return entries;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Resolves a fixed command name once, to the same trusted absolute path used for detection. */
export function resolveTrustedExecutable(
  command: string,
  options: TrustedPathOptions = {},
): string | undefined {
  if (!command || command.includes('/') || command.includes('\\')) return undefined;
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const extensions =
    platform === 'win32'
      ? (environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const directory of trustedPathEntries({ ...options, environment, platform })) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        if (!statSync(candidate).isFile()) continue;
        const resolved = realpathSync(candidate);
        if (trusted(resolved, platform)) return resolved;
      } catch {
        // Missing, unreadable and non-executable candidates are ordinary PATH misses.
      }
    }
  }
  return undefined;
}
