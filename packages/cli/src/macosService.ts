import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { trustedPathEntries } from '@salidium/adapter-kit';

export const MACOS_DAEMON_LABEL = 'com.salidium.daemon';
export const MACOS_MENU_LABEL = 'com.salidium.menubar';

const MANIFEST_VERSION = 1 as const;
const SWIFT_SOURCE_NAME = 'SalidiumMenuBar.swift';

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type ServiceCommandRunner = (command: string, args: string[]) => CommandResult;

export interface MacOSServiceSources {
  runtime: string;
  ui: string;
  menuSource: string;
}

export interface MacOSServiceOptions {
  home?: string;
  userHome?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  environment?: NodeJS.ProcessEnv;
  currentScript?: string;
  nodeExecutable?: string;
  launchctl?: string;
  swiftc?: string;
  version?: string;
  sources?: MacOSServiceSources;
  run?: ServiceCommandRunner;
  now?: () => number;
}

export interface MacOSServicePaths {
  root: string;
  current: string;
  previous: string;
  runtime: string;
  ui: string;
  menuSource: string;
  menuBinary: string;
  daemonLauncher: string;
  menuLauncher: string;
  manifest: string;
  launchAgents: string;
  daemonPlist: string;
  menuPlist: string;
  daemonLog: string;
  menuLog: string;
}

export interface MacOSServiceState {
  supported: boolean;
  installed: boolean;
  installedVersion: string | null;
  enabled: boolean;
  daemonLoaded: boolean;
  menuLoaded: boolean;
  paths: MacOSServicePaths;
}

export type ManagedDaemonKickstart =
  | { kind: 'not-installed' | 'disabled' }
  | { kind: 'started' }
  | { kind: 'failed'; message: string };

interface InstallationManifest {
  version: typeof MANIFEST_VERSION;
  salidiumVersion: string;
  installedAt: string;
  labels: [typeof MACOS_DAEMON_LABEL, typeof MACOS_MENU_LABEL];
}

function commandRunner(environment: NodeJS.ProcessEnv): ServiceCommandRunner {
  return (command, args) => {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 60_000,
      env: environment,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
    };
  };
}

export function macOSServicePaths(home: string, userHome = homedir()): MacOSServicePaths {
  const root = join(home, 'service');
  const current = join(root, 'current');
  return {
    root,
    current,
    previous: join(root, 'previous'),
    runtime: join(current, 'salidium.mjs'),
    ui: join(current, 'ui'),
    menuSource: join(current, SWIFT_SOURCE_NAME),
    menuBinary: join(current, 'salidium-menubar'),
    daemonLauncher: join(current, 'launch-daemon.sh'),
    menuLauncher: join(current, 'launch-menubar.sh'),
    manifest: join(root, 'installation.json'),
    launchAgents: join(userHome, 'Library', 'LaunchAgents'),
    daemonPlist: join(userHome, 'Library', 'LaunchAgents', `${MACOS_DAEMON_LABEL}.plist`),
    menuPlist: join(userHome, 'Library', 'LaunchAgents', `${MACOS_MENU_LABEL}.plist`),
    daemonLog: join(home, 'daemon-startup.log'),
    menuLog: join(home, 'menu-bar.log'),
  };
}

/** XML text nodes in launchd plists are data, never markup. */
export function escapePlistText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistArray(values: string[]): string {
  return `<array>\n${values.map((value) => `      <string>${escapePlistText(value)}</string>`).join('\n')}\n    </array>`;
}

function environmentPlist(environment: Record<string, string>): string {
  const entries = Object.entries(environment)
    .map(
      ([key, value]) =>
        `      <key>${escapePlistText(key)}</key>\n      <string>${escapePlistText(value)}</string>`,
    )
    .join('\n');
  return `<dict>\n${entries}\n    </dict>`;
}

export function renderLaunchAgent(options: {
  label: string;
  programArguments: string[];
  environment: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  aquaOnly?: boolean;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlistText(options.label)}</string>
  <key>ProgramArguments</key>
  ${plistArray(options.programArguments)}
  <key>EnvironmentVariables</key>
  ${environmentPlist(options.environment)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
${options.aquaOnly ? '  <key>LimitLoadToSessionType</key>\n  <string>Aqua</string>\n' : ''}  <key>StandardOutPath</key>
  <string>${escapePlistText(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlistText(options.stderrPath)}</string>
</dict>
</plist>
`;
}

function assertMacOS(platform: NodeJS.Platform): void {
  if (platform !== 'darwin')
    throw new Error('the always-on service and menu bar are currently available on macOS only');
}

function assertOwnedOrAbsent(paths: MacOSServicePaths): void {
  const hasManagedFiles =
    existsSync(paths.root) || existsSync(paths.daemonPlist) || existsSync(paths.menuPlist);
  if (hasManagedFiles && !existsSync(paths.manifest))
    throw new Error(
      `service files already exist without Salidium's ownership marker (${paths.manifest}); they were not changed`,
    );
  if (!existsSync(paths.manifest)) return;
  try {
    const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8')) as InstallationManifest;
    if (
      manifest.version !== MANIFEST_VERSION ||
      manifest.labels?.[0] !== MACOS_DAEMON_LABEL ||
      manifest.labels?.[1] !== MACOS_MENU_LABEL
    )
      throw new Error('unexpected manifest');
  } catch {
    throw new Error(`service ownership marker is invalid (${paths.manifest}); nothing was changed`);
  }
}

function readManifest(paths: MacOSServicePaths): InstallationManifest | undefined {
  if (!existsSync(paths.manifest)) return undefined;
  try {
    const value = JSON.parse(readFileSync(paths.manifest, 'utf8')) as InstallationManifest;
    return value.version === MANIFEST_VERSION &&
      value.labels?.[0] === MACOS_DAEMON_LABEL &&
      value.labels?.[1] === MACOS_MENU_LABEL
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function validateSource(path: string, kind: 'file' | 'directory', description: string): void {
  try {
    const stat = statSync(path);
    if (kind === 'file' ? stat.isFile() : stat.isDirectory()) return;
  } catch {
    // The single actionable error below covers missing and unreadable sources.
  }
  throw new Error(`${description} was not found at ${path}; run \`pnpm package\` and try again`);
}

export function resolveMacOSServiceSources(currentScript: string): MacOSServiceSources {
  const requested = resolve(currentScript);
  let script = requested;
  try {
    // npm exposes package bins through a prefix-level symlink. Resolve it before looking beside
    // the running bundle or `service install` cannot find the UI and native helper in a normal
    // global, prefix, or npx installation.
    script = realpathSync(requested);
  } catch {
    // Keep the requested path so the final diagnostic still names what the user launched.
  }
  const candidates = [dirname(script), join(dirname(script), '..', 'bundle')];
  for (const candidate of candidates) {
    const runtime = join(candidate, 'salidium.mjs');
    const ui = join(candidate, 'ui');
    const menuSources = [
      join(candidate, 'native', SWIFT_SOURCE_NAME),
      join(candidate, SWIFT_SOURCE_NAME),
    ];
    const menuSource = menuSources.find((path) => existsSync(path));
    if (existsSync(runtime) && existsSync(join(ui, 'index.html')) && menuSource)
      return { runtime, ui, menuSource };
  }
  throw new Error(
    `could not find Salidium's packaged runtime beside ${requested}; run \`pnpm package\` and try again`,
  );
}

function safePath(environment: NodeJS.ProcessEnv): string {
  const entries = trustedPathEntries({ environment, platform: 'darwin' });
  for (const required of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (!entries.includes(required)) entries.push(required);
  }
  return entries.join(delimiter);
}

function atomicWrite(path: string, contents: string, mode: number, now: () => number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${now()}`;
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', mode, flag: 'wx' });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function shellQuote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('service paths must not contain newlines');
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function launcherScript(logPath: string, command: string, arguments_: string[]): string {
  const invocation = [command, ...arguments_].map(shellQuote).join(' ');
  return `#!/bin/sh
umask 077
LOG=${shellQuote(logPath)}
if [ -f "$LOG" ]; then
  SIZE=$(/usr/bin/stat -f%z "$LOG" 2>/dev/null || printf '0')
  case "$SIZE" in ''|*[!0-9]*) SIZE=0;; esac
  if [ "$SIZE" -ge 1048576 ]; then
    /bin/rm -f "$LOG.2"
    [ ! -f "$LOG.1" ] || /bin/mv "$LOG.1" "$LOG.2"
    /bin/mv "$LOG" "$LOG.1"
  fi
fi
exec ${invocation} >> "$LOG" 2>&1
`;
}

/** Prefer a stable PATH entry that resolves to this Node binary over a versioned Cellar path. */
export function resolveStableNodeExecutable(
  currentExecutable: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const current = resolve(currentExecutable);
  let target: string;
  try {
    target = realpathSync(current);
  } catch {
    return current;
  }
  const preferred = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...trustedPathEntries({
      environment,
      platform: 'darwin',
    }),
  ];
  const seen = new Set<string>();
  for (const directory of preferred) {
    const candidate = join(directory, 'node');
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (statSync(candidate).isFile() && realpathSync(candidate) === target) return candidate;
    } catch {
      /* Try the next installation entry. */
    }
  }
  return current;
}

function normalizedOptions(options: MacOSServiceOptions) {
  const environment = options.environment ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = options.home ?? environment.SALIDIUM_HOME ?? join(userHome, '.salidium');
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? (platform === 'darwin' ? process.getuid?.() : 0);
  if (!Number.isInteger(uid) || (uid ?? -1) < 0)
    throw new Error('could not determine the current macOS user id');
  return {
    environment,
    userHome,
    home,
    platform,
    uid: uid as number,
    nodeExecutable:
      options.nodeExecutable === undefined
        ? resolveStableNodeExecutable(process.execPath, environment)
        : resolve(options.nodeExecutable),
    launchctl: options.launchctl ?? '/bin/launchctl',
    swiftc: options.swiftc ?? '/usr/bin/swiftc',
    version: options.version ?? '0.0.0',
    now: options.now ?? Date.now,
    run: options.run ?? commandRunner(environment),
    paths: macOSServicePaths(home, userHome),
  };
}

/**
 * Builds a complete versioned runtime before touching either LaunchAgent. The active directory is
 * swapped only after Swift compilation succeeds, so a compiler error cannot break an installation
 * that is already running.
 */
export function prepareMacOSService(options: MacOSServiceOptions = {}): MacOSServicePaths {
  const resolved = normalizedOptions(options);
  assertMacOS(resolved.platform);
  assertOwnedOrAbsent(resolved.paths);
  const firstInstallation = !existsSync(resolved.paths.manifest);
  const sources =
    options.sources ?? resolveMacOSServiceSources(options.currentScript ?? process.argv[1] ?? '');
  validateSource(sources.runtime, 'file', 'packaged Salidium runtime');
  validateSource(sources.ui, 'directory', 'packaged Salidium UI');
  validateSource(sources.menuSource, 'file', 'native menu-bar source');
  validateSource(resolved.nodeExecutable, 'file', 'Node.js runtime');
  validateSource(resolved.swiftc, 'file', 'Swift compiler');

  mkdirSync(resolved.home, { recursive: true, mode: 0o700 });
  chmodSync(resolved.home, 0o700);
  mkdirSync(resolved.paths.root, { recursive: true, mode: 0o700 });
  chmodSync(resolved.paths.root, 0o700);
  const staging = join(resolved.paths.root, `.installing-${process.pid}-${resolved.now()}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    cpSync(sources.runtime, join(staging, 'salidium.mjs'));
    chmodSync(join(staging, 'salidium.mjs'), 0o700);
    writeFileSync(
      join(staging, 'package.json'),
      `${JSON.stringify({ name: 'salidium-service-runtime', private: true, version: resolved.version }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    cpSync(sources.ui, join(staging, 'ui'), { recursive: true });
    cpSync(sources.menuSource, join(staging, SWIFT_SOURCE_NAME));
    chmodSync(join(staging, SWIFT_SOURCE_NAME), 0o600);
    const menuBinary = join(staging, 'salidium-menubar');
    const compiled = resolved.run(resolved.swiftc, [
      '-swift-version',
      '5',
      '-O',
      '-framework',
      'AppKit',
      '-framework',
      'Foundation',
      join(staging, SWIFT_SOURCE_NAME),
      '-o',
      menuBinary,
    ]);
    if (compiled.status !== 0 || !existsSync(menuBinary)) {
      const detail =
        compiled.error?.message ?? compiled.stderr.trim() ?? 'compiler returned no binary';
      throw new Error(`could not build the native menu-bar helper: ${detail}`);
    }
    chmodSync(menuBinary, 0o700);
    const stagedDaemonLauncher = join(staging, 'launch-daemon.sh');
    const stagedMenuLauncher = join(staging, 'launch-menubar.sh');
    writeFileSync(
      stagedDaemonLauncher,
      launcherScript(resolved.paths.daemonLog, resolved.nodeExecutable, [
        resolved.paths.runtime,
        'daemon',
      ]),
      { encoding: 'utf8', mode: 0o700 },
    );
    chmodSync(stagedDaemonLauncher, 0o700);
    writeFileSync(
      stagedMenuLauncher,
      launcherScript(resolved.paths.menuLog, resolved.paths.menuBinary, [
        '--home',
        resolved.home,
        '--node',
        resolved.nodeExecutable,
        '--cli',
        resolved.paths.runtime,
      ]),
      { encoding: 'utf8', mode: 0o700 },
    );
    chmodSync(stagedMenuLauncher, 0o700);

    rmSync(resolved.paths.previous, { recursive: true, force: true });
    if (existsSync(resolved.paths.current))
      renameSync(resolved.paths.current, resolved.paths.previous);
    try {
      renameSync(staging, resolved.paths.current);
    } catch (error) {
      if (!existsSync(resolved.paths.current) && existsSync(resolved.paths.previous))
        renameSync(resolved.paths.previous, resolved.paths.current);
      throw error;
    }

    const path = safePath(resolved.environment);
    const commonEnvironment: Record<string, string> = {
      HOME: resolved.userHome,
      SALIDIUM_HOME: resolved.home,
      PATH: path,
    };
    for (const key of [
      'SALIDIUM_PORT',
      'SALIDIUM_HISTORY_DAYS',
      'SALIDIUM_NO_GIT',
      'SALIDIUM_EXPLAIN',
      'SALIDIUM_EXPLAINER',
      'SALIDIUM_EXPLAIN_MODEL',
      'SALIDIUM_LOG',
    ]) {
      const value = resolved.environment[key];
      if (value !== undefined) commonEnvironment[key] = value;
    }
    const manifest: InstallationManifest = {
      version: MANIFEST_VERSION,
      salidiumVersion: resolved.version,
      installedAt: new Date(resolved.now()).toISOString(),
      labels: [MACOS_DAEMON_LABEL, MACOS_MENU_LABEL],
    };
    // The marker precedes the LaunchAgents so an interrupted first install remains repairable and
    // is never mistaken for somebody else's file on the next attempt.
    atomicWrite(
      resolved.paths.manifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      0o600,
      resolved.now,
    );
    atomicWrite(
      resolved.paths.daemonPlist,
      renderLaunchAgent({
        label: MACOS_DAEMON_LABEL,
        programArguments: [resolved.paths.daemonLauncher],
        environment: {
          ...commonEnvironment,
          SALIDIUM_LOG_FILE: join(resolved.home, 'daemon.log'),
        },
        stdoutPath: '/dev/null',
        stderrPath: '/dev/null',
      }),
      0o600,
      resolved.now,
    );
    atomicWrite(
      resolved.paths.menuPlist,
      renderLaunchAgent({
        label: MACOS_MENU_LABEL,
        programArguments: [resolved.paths.menuLauncher],
        environment: commonEnvironment,
        stdoutPath: '/dev/null',
        stderrPath: '/dev/null',
        aquaOnly: true,
      }),
      0o600,
      resolved.now,
    );
    return resolved.paths;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (firstInstallation && !existsSync(resolved.paths.manifest))
      rmSync(resolved.paths.root, { recursive: true, force: true });
  }
}

function commandFailure(action: string, result: CommandResult): Error {
  const detail = result.error?.message ?? result.stderr.trim() ?? result.stdout.trim();
  return new Error(`${action} failed${detail ? `: ${detail}` : ''}`);
}

function target(uid: number, label: string): string {
  return `gui/${uid}/${label}`;
}

function bootoutIfLoaded(
  run: ServiceCommandRunner,
  launchctl: string,
  uid: number,
  label: string,
): void {
  if (run(launchctl, ['print', target(uid, label)]).status !== 0) return;
  const removed = run(launchctl, ['bootout', target(uid, label)]);
  if (removed.status !== 0) throw commandFailure(`stopping ${label}`, removed);
}

export function activateMacOSService(options: MacOSServiceOptions = {}): MacOSServicePaths {
  const resolved = normalizedOptions(options);
  assertMacOS(resolved.platform);
  assertOwnedOrAbsent(resolved.paths);
  if (!existsSync(resolved.paths.manifest))
    throw new Error('the macOS service is not installed; run `salidium service install` first');

  bootoutIfLoaded(resolved.run, resolved.launchctl, resolved.uid, MACOS_MENU_LABEL);
  bootoutIfLoaded(resolved.run, resolved.launchctl, resolved.uid, MACOS_DAEMON_LABEL);
  for (const label of [MACOS_DAEMON_LABEL, MACOS_MENU_LABEL]) {
    const enabled = resolved.run(resolved.launchctl, ['enable', target(resolved.uid, label)]);
    if (enabled.status !== 0) throw commandFailure(`enabling ${label}`, enabled);
  }
  const daemon = resolved.run(resolved.launchctl, [
    'bootstrap',
    `gui/${resolved.uid}`,
    resolved.paths.daemonPlist,
  ]);
  if (daemon.status !== 0) throw commandFailure('starting the Salidium login service', daemon);
  const menu = resolved.run(resolved.launchctl, [
    'bootstrap',
    `gui/${resolved.uid}`,
    resolved.paths.menuPlist,
  ]);
  if (menu.status !== 0) {
    bootoutIfLoaded(resolved.run, resolved.launchctl, resolved.uid, MACOS_DAEMON_LABEL);
    throw commandFailure('starting the Salidium menu bar', menu);
  }
  return resolved.paths;
}

export function disableMacOSService(options: MacOSServiceOptions = {}): MacOSServicePaths {
  const resolved = normalizedOptions(options);
  assertMacOS(resolved.platform);
  assertOwnedOrAbsent(resolved.paths);
  for (const label of [MACOS_DAEMON_LABEL, MACOS_MENU_LABEL]) {
    const disabled = resolved.run(resolved.launchctl, ['disable', target(resolved.uid, label)]);
    if (disabled.status !== 0) throw commandFailure(`disabling ${label}`, disabled);
  }
  bootoutIfLoaded(resolved.run, resolved.launchctl, resolved.uid, MACOS_DAEMON_LABEL);
  bootoutIfLoaded(resolved.run, resolved.launchctl, resolved.uid, MACOS_MENU_LABEL);
  return resolved.paths;
}

export function uninstallMacOSService(options: MacOSServiceOptions = {}): MacOSServicePaths {
  const resolved = normalizedOptions(options);
  assertMacOS(resolved.platform);
  assertOwnedOrAbsent(resolved.paths);
  disableMacOSService(options);
  rmSync(resolved.paths.daemonPlist, { force: true });
  rmSync(resolved.paths.menuPlist, { force: true });
  rmSync(resolved.paths.root, { recursive: true, force: true });
  return resolved.paths;
}

function disabledLabels(output: string): Set<string> {
  const labels = new Set<string>();
  for (const line of output.split('\n')) {
    // launchctl has emitted both plist-style booleans and human-readable states across macOS
    // releases. In both forms the entry records an override away from the default enabled state.
    const match = /"([^"]+)"\s*=>\s*(?:true|disabled)\b/.exec(line);
    if (match?.[1]) labels.add(match[1]);
  }
  return labels;
}

export function inspectMacOSService(options: MacOSServiceOptions = {}): MacOSServiceState {
  const resolved = normalizedOptions(options);
  const supported = resolved.platform === 'darwin';
  const manifest = readManifest(resolved.paths);
  const installed = manifest !== undefined;
  if (!supported || !installed)
    return {
      supported,
      installed,
      installedVersion: manifest?.salidiumVersion ?? null,
      enabled: false,
      daemonLoaded: false,
      menuLoaded: false,
      paths: resolved.paths,
    };
  const disabled = disabledLabels(
    resolved.run(resolved.launchctl, ['print-disabled', `gui/${resolved.uid}`]).stdout,
  );
  return {
    supported,
    installed,
    installedVersion: manifest?.salidiumVersion ?? null,
    enabled: installed && !disabled.has(MACOS_DAEMON_LABEL) && !disabled.has(MACOS_MENU_LABEL),
    daemonLoaded:
      resolved.run(resolved.launchctl, ['print', target(resolved.uid, MACOS_DAEMON_LABEL)])
        .status === 0,
    menuLoaded:
      resolved.run(resolved.launchctl, ['print', target(resolved.uid, MACOS_MENU_LABEL)]).status ===
      0,
    paths: resolved.paths,
  };
}

/** Starts a loaded, cleanly stopped LaunchAgent instead of escaping launchd supervision. */
export function kickstartManagedDaemon(options: MacOSServiceOptions = {}): ManagedDaemonKickstart {
  const resolved = normalizedOptions(options);
  if (resolved.platform !== 'darwin' || !existsSync(resolved.paths.manifest))
    return { kind: 'not-installed' };
  const state = inspectMacOSService(options);
  if (!state.enabled) return { kind: 'disabled' };
  if (options.version && state.installedVersion !== options.version)
    return {
      kind: 'failed',
      message: `the always-on runtime is ${state.installedVersion ?? 'unknown'}, but this CLI is ${options.version}; run \`salidium service install\` to update it`,
    };
  if (!state.daemonLoaded) {
    const loaded = resolved.run(resolved.launchctl, [
      'bootstrap',
      `gui/${resolved.uid}`,
      resolved.paths.daemonPlist,
    ]);
    if (loaded.status !== 0)
      return {
        kind: 'failed',
        message: commandFailure('loading the Salidium login service', loaded).message,
      };
  }
  const started = resolved.run(resolved.launchctl, [
    'kickstart',
    target(resolved.uid, MACOS_DAEMON_LABEL),
  ]);
  return started.status === 0
    ? { kind: 'started' }
    : {
        kind: 'failed',
        message: commandFailure('starting the supervised daemon', started).message,
      };
}

/** Only for user-facing diagnostics; never place secrets or daemon tokens in a LaunchAgent. */
export function describeMacOSService(state: MacOSServiceState): string[] {
  if (!state.supported) return ['Always-on mode: unavailable on this operating system'];
  if (!state.installed)
    return ['Always-on mode: not installed', 'Install: salidium service install'];
  return [
    `Always-on mode: ${state.enabled ? 'enabled' : 'disabled'}`,
    `Installed runtime: ${state.installedVersion ?? 'unknown'}`,
    `Daemon service: ${state.daemonLoaded ? 'loaded' : 'not loaded'}`,
    `Menu bar: ${state.menuLoaded ? 'loaded' : 'not loaded'}`,
    `Runtime: ${state.paths.current}`,
    `Login items: ${dirname(state.paths.daemonPlist)}`,
  ];
}
