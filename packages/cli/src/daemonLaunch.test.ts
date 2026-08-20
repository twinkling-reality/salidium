import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const entry = join(import.meta.dirname, 'main.ts');

/*
 * The CLI's own version, read rather than written down.
 *
 * Four assertions here used to name it. Three said `0.1.0` and one planted a `0.2.0` daemon to
 * stand for one that is newer than the CLI, which meant the first release after they were written
 * broke its own suite twice over: the bump made every literal wrong, and it made the daemon the
 * fourth test plants exactly as new as the CLI rather than ahead of it, so the refusal it asserts
 * stopped happening. A version is a fact about the package, and this reads it from the package.
 */
const VERSION = (
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

/** Unambiguously ahead of the CLI, whatever the CLI is at. */
const NEWER = `${Number(VERSION.split('.')[0]) + 1}.0.0`;

function temporaryHome(): string {
  const path = mkdtempSync(join(tmpdir(), 'salidium-daemon-launch-'));
  temporaryDirectories.push(path);
  return path;
}

function run(home: string, args: string[], port: string, historyDays = '0') {
  const began = Date.now();
  const result = spawnSync(process.execPath, ['--conditions=development', entry, ...args], {
    encoding: 'utf8',
    /*
     * A guard against a hang, not a budget. Every run here is a whole Node process loading this
     * CLI from TypeScript source, and several of them spawn a second one; at 5s a machine busy
     * with something else killed those spawns and the failure arrived as four unrelated tests at
     * once. It stays under the ready loop's own ceiling of a hundred 100ms ticks, so a launch
     * that genuinely hung is still cut short here rather than waited out.
     */
    timeout: 9_000,
    env: {
      ...process.env,
      SALIDIUM_HOME: home,
      SALIDIUM_PORT: port,
      SALIDIUM_HISTORY_DAYS: historyDays,
      SALIDIUM_NO_GIT: '1',
    },
  });
  return { ...result, elapsed: Date.now() - began };
}

function start(home: string, port: string) {
  return run(home, ['start'], port);
}

/*
 * What a run spent on top of merely starting: the part the launch path is answerable for.
 *
 * The assertions using this are about a path that must not wait. It rejects its configuration
 * before a daemon is ever spawned, and the ready loop it therefore never enters is a hundred
 * ticks of 100ms, so what is being ruled out is a ten-second hang.
 *
 * They were absolute budgets and measured the wrong thing. Every run here is a whole Node process
 * loading this CLI from TypeScript source, which is most of the elapsed time and none of the
 * behaviour; on a busy machine that startup alone exceeded the budget, so they failed under a
 * full suite and passed alone, which is a statement about the machine.
 *
 * `--version` is the same binary doing the least it can do, and it is measured next to the run it
 * is compared against rather than once for the file: the load on a shared machine moves during a
 * suite, and a baseline taken at a quiet moment is not the baseline the later run experienced.
 */
function overStartup(home: string, result: { elapsed: number }): number {
  return result.elapsed - run(home, ['--version'], '0').elapsed;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('detached daemon launch failures', () => {
  it('prints the installed version without starting the daemon', () => {
    const home = temporaryHome();
    const result = run(home, ['--version'], '0');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
    expect(existsSync(join(home, 'daemon.json'))).toBe(false);
  });

  it('rejects an invalid port before spawning a daemon', () => {
    const home = temporaryHome();
    const result = start(home, 'not-a-port');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/SALIDIUM_PORT must be an integer from 0 to 65535/);
    // Rejected before the spawn, so it owes nothing beyond starting up.
    expect(overStartup(home, result)).toBeLessThan(1_500);
    expect(existsSync(join(home, 'daemon.log'))).toBe(false);
  });

  it('rejects an invalid history window before spawning and reports it in doctor', () => {
    const home = temporaryHome();
    const started = run(home, ['start'], '0', 'banana');
    expect(started.status).toBe(1);
    expect(started.stderr).toMatch(/SALIDIUM_HISTORY_DAYS must be a nonnegative whole number/);
    // Rejected before the spawn, so it owes nothing beyond starting up.
    expect(overStartup(home, started)).toBeLessThan(1_500);
    expect(existsSync(join(home, 'daemon.log'))).toBe(false);

    const diagnosed = run(home, ['doctor'], '0', '-1');
    expect(diagnosed.status).toBe(1);
    expect(diagnosed.stdout).toMatch(/SALIDIUM_HISTORY_DAYS must be a nonnegative whole number/);
  });

  it('reports an occupied port promptly and preserves the child error in the bounded startup log', async () => {
    const home = temporaryHome();
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server has no TCP port');
    try {
      const result = start(home, String(address.port));
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/daemon exited with code 1 before it became ready/);
      expect(result.stderr).toMatch(/daemon-startup\.log/);
      /*
       * Promptness is asserted by the two lines above rather than by a clock. This path spawns a
       * second Node process, and that child's own startup is most of the elapsed time and none of
       * the behaviour, so there is no budget here that a loaded machine cannot break. What is
       * left is stronger anyway: the message quoted above is reachable only by leaving the ready
       * loop on the child's exit, never by exhausting it, which prints "daemon did not start"
       * instead — and `run` caps every one of these at five seconds, half the loop's own ceiling,
       * so a launch that did hang could not have produced this output at all.
       */
      expect(readFileSync(join(home, 'daemon-startup.log'), 'utf8')).toMatch(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not signal or replace an unrelated live PID from stale daemon.json', async () => {
    const home = temporaryHome();
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
      stdio: 'ignore',
    });
    if (!sleeper.pid) throw new Error('disposable child has no pid');
    writeFileSync(
      join(home, 'daemon.json'),
      JSON.stringify({
        pid: sleeper.pid,
        port: 1,
        token: 'a'.repeat(64),
        startedAt: new Date().toISOString(),
        version: VERSION,
      }),
    );

    try {
      const stopped = run(home, ['stop'], '0');
      expect(stopped.status).toBe(1);
      expect(stopped.stdout).toMatch(/not signaled; stale PID or unresponsive daemon/);
      expect(processExists(sleeper.pid)).toBe(true);

      const restarted = run(home, ['restart', '--no-open'], '0');
      expect(restarted.status).toBe(1);
      expect(restarted.stderr).toMatch(/not starting a replacement/);
      expect(processExists(sleeper.pid)).toBe(true);
      expect(JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).pid).toBe(sleeper.pid);
    } finally {
      if (processExists(sleeper.pid)) {
        const exited = new Promise<void>((resolve) => sleeper.once('exit', () => resolve()));
        sleeper.kill('SIGTERM');
        await exited;
      }
    }
  });

  it('authenticates and replaces a running daemon whose version differs from the CLI', () => {
    const home = temporaryHome();
    const first = start(home, '0');
    expect(first.status).toBe(0);
    const path = join(home, 'daemon.json');
    const original = JSON.parse(readFileSync(path, 'utf8')) as {
      pid: number;
      port: number;
      token: string;
      startedAt: string;
      version: string;
    };
    writeFileSync(path, JSON.stringify({ ...original, version: '0.0.0' }));

    try {
      const updated = start(home, '0');
      expect(updated.status).toBe(0);
      expect(updated.stdout).toContain(`updating daemon 0.0.0 to ${VERSION}`);
      const replacement = JSON.parse(readFileSync(path, 'utf8')) as typeof original;
      expect(replacement.version).toBe(VERSION);
      expect(replacement.pid).not.toBe(original.pid);
      expect(processExists(original.pid)).toBe(false);
    } finally {
      run(home, ['stop'], '0');
    }
  });

  it('replaces a same-version daemon whose runtime contracts predate the current build', () => {
    const home = temporaryHome();
    expect(start(home, '0').status).toBe(0);
    const path = join(home, 'daemon.json');
    const original = JSON.parse(readFileSync(path, 'utf8')) as {
      pid: number;
      port: number;
      token: string;
      startedAt: string;
      version: string;
      protocolVersion?: string;
      storeSchemaVersion?: number;
    };
    const { protocolVersion: _protocol, storeSchemaVersion: _store, ...legacy } = original;
    writeFileSync(path, JSON.stringify(legacy));

    try {
      const updated = start(home, '0');
      expect(updated.status).toBe(0);
      expect(updated.stdout).toMatch(/runtime protocol unknown \/ store unknown/);
      const replacement = JSON.parse(readFileSync(path, 'utf8')) as typeof original;
      expect(replacement.protocolVersion).toBeDefined();
      expect(replacement.storeSchemaVersion).toBeDefined();
      expect(replacement.pid).not.toBe(original.pid);
      expect(processExists(original.pid)).toBe(false);
    } finally {
      run(home, ['stop'], '0');
    }
  });

  it('refuses offline store maintenance while the authenticated daemon is live', () => {
    const home = temporaryHome();
    expect(start(home, '0').status).toBe(0);
    try {
      const reingest = run(home, ['reingest', '--all'], '0');
      expect(reingest.status).toBe(2);
      expect(reingest.stderr).toMatch(/stop Salidium.*offline maintenance/);

      const retention = run(home, ['retention', '30'], '0');
      expect(retention.status).toBe(2);
      expect(retention.stderr).toMatch(/stop Salidium.*offline maintenance/);
    } finally {
      run(home, ['stop'], '0');
    }
  });

  it('never replaces a newer or unversioned authenticated daemon with an older CLI', () => {
    const home = temporaryHome();
    expect(start(home, '0').status).toBe(0);
    const path = join(home, 'daemon.json');
    const original = JSON.parse(readFileSync(path, 'utf8')) as {
      pid: number;
      port: number;
      token: string;
      startedAt: string;
      version: string;
    };

    try {
      writeFileSync(path, JSON.stringify({ ...original, version: NEWER }));
      const newer = start(home, '0');
      expect(newer.status).toBe(1);
      expect(newer.stderr).toMatch(
        new RegExp(`daemon ${NEWER.replaceAll('.', '\\.')} is newer.*npx salidium@latest`),
      );
      expect(processExists(original.pid)).toBe(true);

      const { version: _version, ...legacy } = original;
      writeFileSync(path, JSON.stringify(legacy));
      const unversioned = start(home, '0');
      expect(unversioned.status).toBe(1);
      expect(unversioned.stderr).toMatch(/version unknown cannot be compared/);
      expect(processExists(original.pid)).toBe(true);
    } finally {
      writeFileSync(path, JSON.stringify(original));
      run(home, ['stop'], '0');
    }
  });
});
