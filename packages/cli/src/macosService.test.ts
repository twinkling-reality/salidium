import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { byteLabelVectors } from '@salidium/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateMacOSService,
  disableMacOSService,
  inspectMacOSService,
  kickstartManagedDaemon,
  MACOS_DAEMON_LABEL,
  MACOS_MENU_LABEL,
  macOSServicePaths,
  prepareMacOSService,
  renderLaunchAgent,
  resolveMacOSServiceSources,
  resolveStableNodeExecutable,
  type ServiceCommandRunner,
  uninstallMacOSService,
} from './macosService.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-macos-service-'));
  temporaryDirectories.push(path);
  return path;
}

function fixture() {
  const root = temporaryDirectory();
  const userHome = join(root, 'user');
  const home = join(root, 'state');
  const sources = {
    runtime: join(root, 'source', 'salidium.mjs'),
    ui: join(root, 'source', 'ui'),
    menuSource: join(root, 'source', 'SalidiumMenuBar.swift'),
  };
  mkdirSync(sources.ui, { recursive: true });
  writeFileSync(sources.runtime, '#!/usr/bin/env node\n// bundled runtime\n');
  writeFileSync(join(sources.ui, 'index.html'), '<main>Salidium</main>');
  writeFileSync(sources.menuSource, 'import AppKit\n');
  const swiftc = join(root, 'swiftc');
  const node = join(root, 'node');
  writeFileSync(swiftc, 'compiler');
  writeFileSync(node, 'runtime');
  return { root, userHome, home, sources, swiftc, node };
}

function launchctlRunner(swiftc: string) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const loaded = new Set<string>();
  const disabled = new Set<string>();
  let compilerFailure: string | undefined;
  const run: ServiceCommandRunner = (command, args) => {
    calls.push({ command, args });
    if (command === swiftc) {
      if (compilerFailure) return { status: 1, stdout: '', stderr: compilerFailure };
      const output = args.at(-1);
      if (!output) throw new Error('test compiler did not receive an output path');
      writeFileSync(output, 'native binary');
      return { status: 0, stdout: '', stderr: '' };
    }
    const action = args[0];
    const target = args[1] ?? '';
    if (action === 'print-disabled') {
      return {
        status: 0,
        stdout: [...disabled].map((label) => `"${label}" => disabled`).join('\n'),
        stderr: '',
      };
    }
    if (action === 'print') return { status: loaded.has(target) ? 0 : 113, stdout: '', stderr: '' };
    if (action === 'enable') {
      disabled.delete(target.split('/').at(-1) ?? '');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (action === 'disable') {
      disabled.add(target.split('/').at(-1) ?? '');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (action === 'bootstrap') {
      const label = basename(args[2] ?? '').replace(/\.plist$/, '');
      loaded.add(`gui/501/${label}`);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (action === 'bootout') {
      loaded.delete(target);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (action === 'kickstart')
      return { status: loaded.has(target) ? 0 : 113, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return {
    run,
    calls,
    loaded,
    disabled,
    failCompiler(message: string | undefined) {
      compilerFailure = message;
    },
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('macOS always-on service', () => {
  it('finds packaged service sources when npm launches the bundle through a bin symlink', () => {
    const root = temporaryDirectory();
    const bundle = join(root, 'node_modules', 'salidium', 'bundle');
    const bin = join(root, 'node_modules', '.bin');
    mkdirSync(join(bundle, 'ui'), { recursive: true });
    mkdirSync(join(bundle, 'native'));
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bundle, 'salidium.mjs'), '#!/usr/bin/env node\n');
    writeFileSync(join(bundle, 'ui', 'index.html'), '<main>Salidium</main>');
    writeFileSync(join(bundle, 'native', 'SalidiumMenuBar.swift'), 'import AppKit\n');
    const installedBin = join(bin, 'salidium');
    symlinkSync(join('..', 'salidium', 'bundle', 'salidium.mjs'), installedBin);
    const installedBundle = realpathSync(bundle);

    expect(resolveMacOSServiceSources(installedBin)).toEqual({
      runtime: join(installedBundle, 'salidium.mjs'),
      ui: join(installedBundle, 'ui'),
      menuSource: join(installedBundle, 'native', 'SalidiumMenuBar.swift'),
    });
  });

  it('prefers a stable PATH symlink to a versioned Node executable', () => {
    const root = temporaryDirectory();
    const versioned = join(root, 'Cellar', 'node', '24.1.0', 'bin', 'node');
    const stableBin = join(root, 'bin');
    mkdirSync(join(root, 'Cellar', 'node', '24.1.0', 'bin'), { recursive: true });
    mkdirSync(stableBin);
    writeFileSync(versioned, 'node');
    const stable = join(stableBin, 'node');
    symlinkSync(versioned, stable);
    expect(resolveStableNodeExecutable(versioned, { PATH: stableBin })).toBe(
      join(realpathSync(stableBin), 'node'),
    );
  });

  it('renders escaped, crash-only restart LaunchAgents', () => {
    const plist = renderLaunchAgent({
      label: 'com.salidium.test',
      programArguments: ['/A & B/node', '<runtime>', 'daemon'],
      environment: { HOME: "/Users/O'Neil & Co" },
      stdoutPath: '/tmp/a>b',
      stderrPath: '/tmp/a>b',
      aquaOnly: true,
    });
    expect(plist).toContain('<string>/A &amp; B/node</string>');
    expect(plist).toContain('<string>&lt;runtime&gt;</string>');
    expect(plist).toContain('<string>/Users/O&apos;Neil &amp; Co</string>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(plist).toContain('<key>LimitLoadToSessionType</key>\n  <string>Aqua</string>');
  });

  it('stages a private stable runtime and never writes the daemon token to login files', () => {
    const value = fixture();
    const launchctl = launchctlRunner(value.swiftc);
    const paths = prepareMacOSService({
      home: value.home,
      userHome: value.userHome,
      platform: 'darwin',
      uid: 501,
      nodeExecutable: value.node,
      swiftc: value.swiftc,
      sources: value.sources,
      environment: {
        PATH: `${join(value.root, 'node_modules', '.bin')}:/usr/bin:/bin`,
        SALIDIUM_PORT: '49111',
      },
      version: '1.2.3',
      now: () => 1_700_000_000_000,
      run: launchctl.run,
    });

    expect(readFileSync(paths.runtime, 'utf8')).toContain('bundled runtime');
    expect(JSON.parse(readFileSync(join(paths.current, 'package.json'), 'utf8'))).toMatchObject({
      version: '1.2.3',
      private: true,
    });
    expect(readFileSync(join(paths.ui, 'index.html'), 'utf8')).toContain('Salidium');
    expect(readFileSync(paths.menuBinary, 'utf8')).toBe('native binary');
    expect(statSync(paths.runtime).mode & 0o777).toBe(0o700);
    expect(statSync(paths.menuBinary).mode & 0o777).toBe(0o700);
    expect(statSync(paths.daemonLauncher).mode & 0o777).toBe(0o700);
    expect(statSync(paths.menuLauncher).mode & 0o777).toBe(0o700);
    expect(statSync(paths.daemonPlist).mode & 0o777).toBe(0o600);
    const daemonPlist = readFileSync(paths.daemonPlist, 'utf8');
    const menuPlist = readFileSync(paths.menuPlist, 'utf8');
    expect(daemonPlist).toContain(paths.daemonLauncher);
    expect(daemonPlist).toContain('<key>SALIDIUM_PORT</key>\n      <string>49111</string>');
    expect(daemonPlist).toContain('<string>/usr/bin:/bin:/usr/sbin:/sbin</string>');
    expect(daemonPlist).not.toContain('node_modules/.bin');
    expect(`${daemonPlist}${menuPlist}`).not.toContain('token');
    expect(menuPlist).toContain(paths.menuLauncher);
    expect(readFileSync(paths.daemonLauncher, 'utf8')).toContain(paths.runtime);
    expect(readFileSync(paths.daemonLauncher, 'utf8')).toContain('1048576');
    expect(readFileSync(paths.menuLauncher, 'utf8')).toContain(paths.menuBinary);
    expect(`${daemonPlist}${menuPlist}`).toContain('<string>/dev/null</string>');
    expect(JSON.parse(readFileSync(paths.manifest, 'utf8'))).toMatchObject({
      version: 1,
      salidiumVersion: '1.2.3',
      labels: [MACOS_DAEMON_LABEL, MACOS_MENU_LABEL],
    });
  });

  it('keeps the previous runtime active when native compilation fails', () => {
    const value = fixture();
    const launchctl = launchctlRunner(value.swiftc);
    const options = {
      home: value.home,
      userHome: value.userHome,
      platform: 'darwin' as const,
      uid: 501,
      nodeExecutable: value.node,
      swiftc: value.swiftc,
      sources: value.sources,
      version: '1.0.0',
      run: launchctl.run,
    };
    const paths = prepareMacOSService(options);
    writeFileSync(value.sources.runtime, '// replacement that must not be installed\n');
    launchctl.failCompiler('deliberate compiler failure');
    expect(() => prepareMacOSService(options)).toThrow('deliberate compiler failure');
    expect(readFileSync(paths.runtime, 'utf8')).toContain('bundled runtime');
  });

  it('leaves no false installation marker after a first-build failure', () => {
    const value = fixture();
    const launchctl = launchctlRunner(value.swiftc);
    launchctl.failCompiler('compiler unavailable');
    expect(() =>
      prepareMacOSService({
        home: value.home,
        userHome: value.userHome,
        platform: 'darwin',
        uid: 501,
        nodeExecutable: value.node,
        swiftc: value.swiftc,
        sources: value.sources,
        run: launchctl.run,
      }),
    ).toThrow('compiler unavailable');
    expect(existsSync(macOSServicePaths(value.home, value.userHome).root)).toBe(false);
  });

  it('enables, loads, kickstarts, disables, and uninstalls only its managed files', () => {
    const value = fixture();
    const launchctl = launchctlRunner(value.swiftc);
    const options = {
      home: value.home,
      userHome: value.userHome,
      platform: 'darwin' as const,
      uid: 501,
      nodeExecutable: value.node,
      swiftc: value.swiftc,
      launchctl: '/bin/launchctl',
      sources: value.sources,
      run: launchctl.run,
    };
    const paths = prepareMacOSService(options);
    const data = join(value.home, 'salidium.db');
    writeFileSync(data, 'user data');
    activateMacOSService(options);
    expect(inspectMacOSService(options)).toMatchObject({
      installed: true,
      enabled: true,
      daemonLoaded: true,
      menuLoaded: true,
    });
    expect(kickstartManagedDaemon(options)).toEqual({ kind: 'started' });

    disableMacOSService(options);
    expect(inspectMacOSService(options)).toMatchObject({
      installed: true,
      enabled: false,
      daemonLoaded: false,
      menuLoaded: false,
    });
    uninstallMacOSService(options);
    expect(existsSync(paths.root)).toBe(false);
    expect(existsSync(paths.daemonPlist)).toBe(false);
    expect(existsSync(paths.menuPlist)).toBe(false);
    expect(readFileSync(data, 'utf8')).toBe('user data');
  });

  it('refuses to start a supervised runtime from a different CLI version', () => {
    const value = fixture();
    const launchctl = launchctlRunner(value.swiftc);
    const options = {
      home: value.home,
      userHome: value.userHome,
      platform: 'darwin' as const,
      uid: 501,
      nodeExecutable: value.node,
      swiftc: value.swiftc,
      sources: value.sources,
      version: '1.0.0',
      run: launchctl.run,
    };
    prepareMacOSService(options);
    expect(kickstartManagedDaemon({ ...options, version: '2.0.0' })).toEqual({
      kind: 'failed',
      message:
        'the always-on runtime is 1.0.0, but this CLI is 2.0.0; run `salidium service install` to update it',
    });
    expect(launchctl.calls.some(({ args }) => args[0] === 'kickstart')).toBe(false);
  });

  it('refuses to overwrite an unowned service directory', () => {
    const value = fixture();
    const paths = macOSServicePaths(value.home, value.userHome);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(join(paths.root, 'someone-elses-file'), 'keep');
    expect(() =>
      prepareMacOSService({
        home: value.home,
        userHome: value.userHome,
        platform: 'darwin',
        uid: 501,
        nodeExecutable: value.node,
        swiftc: value.swiftc,
        sources: value.sources,
        run: launchctlRunner(value.swiftc).run,
      }),
    ).toThrow("without Salidium's ownership marker");
    expect(readFileSync(join(paths.root, 'someone-elses-file'), 'utf8')).toBe('keep');
  });
});

/*
 * The menu bar renders bytes the same way the app and the CLI do.
 *
 * It used `ByteCountFormatter` with `.file`, which is decimal, while `formatBytes` in
 * `@salidium/core` is binary. One store read at one instant was "2.71 GB" in the menu and
 * "2.53 GiB" in the window that menu opens, and nothing on either surface said which convention
 * produced it.
 *
 * Swift cannot import the module, so this reads the source and checks that every unit and
 * precision `byteLabelVectors` implies is present in it. That catches the drift that actually
 * happens, which is one side being changed and the other forgotten; it does not execute the Swift,
 * so it cannot catch a wrong threshold. The vectors were verified against a real `swift` run when
 * the function was written.
 */
describe('menu bar byte rendering', () => {
  it('uses the units and precision the shared formatter produces', () => {
    const swift = readFileSync(
      join(import.meta.dirname, '..', 'native', 'SalidiumMenuBar.swift'),
      'utf8',
    );
    const body = /private static func byteLabel[\s\S]*?\n {4}}/.exec(swift)?.[0];
    expect(body).toBeDefined();

    const expected = new Set(
      byteLabelVectors.map(([, label]) => {
        const [value, unit] = label.split(' ');
        const decimals = value.includes('.') ? (value.split('.')[1]?.length ?? 0) : 0;
        return unit === 'B' ? 'B' : `%.${decimals}f ${unit}`;
      }),
    );
    for (const form of expected) {
      if (form === 'B') expect(body).toContain(') B"');
      else expect(body).toContain(form);
    }
    expect(body).not.toContain('ByteCountFormatter');
  });
});
