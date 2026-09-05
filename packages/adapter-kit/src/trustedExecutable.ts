import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, win32 } from 'node:path';

export interface TrustedPathOptions {
  environment?: NodeJS.ProcessEnv;
  /** Compatibility alias for a working tree that must never supply daemon executables. */
  cwd?: string;
  /** Repository or other untrusted roots whose directories and executable targets are excluded. */
  untrustedRoots?: readonly string[];
  platform?: NodeJS.Platform;
}

function normalized(path: string, platform: NodeJS.Platform): string {
  const value = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return platform === 'win32' ? value.toLowerCase() : value;
}

function inside(path: string, root: string, platform: NodeJS.Platform): boolean {
  const value = normalized(resolve(path), platform);
  const boundary = normalized(resolve(root), platform);
  return value === boundary || value.startsWith(`${boundary}/`);
}

function untrustedRoots(options: TrustedPathOptions, environment: NodeJS.ProcessEnv): string[] {
  const configured = options.untrustedRoots ?? [options.cwd ?? process.cwd()];
  const homes = [environment.HOME, environment.USERPROFILE]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalized(realpathOrSelf(value), options.platform ?? process.platform));
  return (
    configured
      .map(realpathOrSelf)
      // Running a command from the home directory must not make normal ~/.local installations
      // unavailable. A concrete repository below it remains excluded.
      .filter((root) => !homes.includes(normalized(root, options.platform ?? process.platform)))
  );
}

function trusted(path: string, platform: NodeJS.Platform, roots: readonly string[]): boolean {
  const value = normalized(path, platform);
  return (
    !/(^|\/)node_modules\/\.bin($|\/)/.test(value) &&
    !roots.some((root) => inside(path, root, platform))
  );
}

/**
 * PATH entries inherited from a package runner can put the current project's binaries first.
 * They are not an installation boundary: a dependency in the repository can supply a same-named
 * executable and receive daemon tokens, prompts, or provider credentials. Keep only absolute,
 * existing directories outside every `node_modules/.bin` and every untrusted root, and on a POSIX
 * host only those no other user can write to. Absolute user paths remain valid even when Salidium
 * was started from the user's home directory.
 */
export function trustedPathEntries(options: TrustedPathOptions = {}): string[] {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const roots = untrustedRoots(options, environment);
  const path = environment.PATH;
  if (!path) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of path.split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const directory = realpathOrSelf(entry);
    if (!trusted(directory, platform, roots)) continue;
    try {
      const metadata = statSync(directory);
      if (!metadata.isDirectory()) continue;
      // The shared-writable rule reads host permission bits, so it is a fact about the host rather
      // than about the platform being modelled for path semantics. Windows derives `mode` from the
      // read-only attribute alone and reports 0o777 for every writable directory, while the access
      // that actually governs it lives in an ACL these bits cannot express. Applying the rule there
      // would reject the whole PATH without observing a single permission.
      if (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0) continue;
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
  const roots = untrustedRoots(options, environment);
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
        if (trusted(resolved, platform, roots)) return resolved;
      } catch {
        // Missing, unreadable and non-executable candidates are ordinary PATH misses.
      }
    }
  }
  return undefined;
}

/** Resolves only the small set of OS-owned desktop helpers Salidium invokes automatically. */
export function resolveSystemExecutable(
  command:
    | 'cmd'
    | 'notify-send'
    | 'open'
    | 'osascript'
    | 'powershell'
    | 'powershell.exe'
    | 'xdg-open',
  options: Pick<TrustedPathOptions, 'environment' | 'platform'> = {},
): string | undefined {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  let candidates: string[] = [];
  if (platform === 'darwin') {
    if (command === 'open') candidates = ['/usr/bin/open'];
    if (command === 'osascript') candidates = ['/usr/bin/osascript'];
  } else if (platform === 'win32') {
    const windows = environment.SystemRoot ?? environment.WINDIR ?? 'C:\\Windows';
    if (command === 'cmd') candidates = [win32.join(windows, 'System32', 'cmd.exe')];
    if (command === 'powershell' || command === 'powershell.exe')
      candidates = [win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
  } else {
    if (command === 'xdg-open') candidates = ['/usr/bin/xdg-open', '/bin/xdg-open'];
    if (command === 'notify-send') candidates = ['/usr/bin/notify-send', '/bin/notify-send'];
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      /* A platform helper is optional. */
    }
  }
  return undefined;
}
