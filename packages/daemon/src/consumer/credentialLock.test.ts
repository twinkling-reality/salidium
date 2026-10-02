import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { acquireCredentialLock, withCredentialLock } from './credentialLock.ts';
import { createConsumerCredential, listConsumerCredentials } from './credentials.ts';

const root = mkdtempSync(join(tmpdir(), 'salidium-credential-lock-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let homes = 0;
const freshHome = (): string => {
  const home = join(root, `home-${homes++}`);
  mkdirSync(home, { mode: 0o700 });
  return home;
};
const lockOf = (home: string): string => join(home, 'consumer-credentials.lock');
const moduleUrl = pathToFileURL(join(import.meta.dirname, 'credentialLock.ts')).href;

/** A pid that belonged to a process that has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  if (child.pid === undefined) throw new Error('could not start a process');
  return child.pid;
}

/** Plants a lock directory as an earlier process would have left it. */
function plantLock(home: string, owner: string | undefined, ageMs = 0): string {
  const lock = lockOf(home);
  mkdirSync(lock, { mode: 0o700 });
  if (owner !== undefined) writeFileSync(join(lock, 'owner'), owner, { mode: 0o600 });
  age(lock, ageMs);
  return lock;
}

function age(lock: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  for (const name of readdirSync(lock)) utimesSync(join(lock, name), when, when);
  utimesSync(lock, when, when);
}

function identity(path: string): string {
  const info = statSync(path, { bigint: true });
  return `${info.ino}-${info.mtimeNs}`;
}

/** What identifies the lock now held: the directory and its owner file. */
function lockIdentity(home: string): string {
  return `${statSync(lockOf(home)).ino}:${identity(join(lockOf(home), 'owner'))}`;
}

describe('credential lock', () => {
  test('is free again after its holder releases it, and leaves nothing behind', () => {
    const home = freshHome();
    expect(withCredentialLock(home, () => readFileSync(join(lockOf(home), 'owner'), 'utf8'))).toBe(
      String(process.pid),
    );
    expect(readdirSync(home)).toEqual([]);
  });

  test('a held lock is waited for and then refused, not taken', () => {
    const home = freshHome();
    const release = acquireCredentialLock(home);
    const held = lockIdentity(home);
    expect(() => acquireCredentialLock(home, { attempts: 2 })).toThrow(/changed elsewhere/);
    expect(lockIdentity(home)).toBe(held);
    release();
    acquireCredentialLock(home)();
  });

  test('a lock whose holder died is taken over at once', () => {
    const home = freshHome();
    plantLock(home, String(deadPid()));
    expect(withCredentialLock(home, () => 'ran', { attempts: 0 })).toBe('ran');
    expect(existsSync(lockOf(home))).toBe(false);
  });

  test.each([
    ['empty', ''],
    ['zero', '0'],
    ['garbled', '12ab'],
    ['whitespace', ' \n'],
    ['out of range', '99999999999'],
  ])(
    'an owner that is %s is not yet known: waited out while recent, recovered once old',
    (_, owner) => {
      const home = freshHome();
      const lock = plantLock(home, owner);
      const planted = lockIdentity(home);
      expect(() => acquireCredentialLock(home, { attempts: 2 })).toThrow(/changed elsewhere/);
      expect(lockIdentity(home)).toBe(planted);
      age(lock, 60_000);
      expect(withCredentialLock(home, () => 'ran', { attempts: 0 })).toBe('ran');
    },
  );

  test('an empty lock directory, as an older release leaves it before writing its owner, is not yet known', () => {
    const home = freshHome();
    const lock = plantLock(home, undefined);
    expect(() => acquireCredentialLock(home, { attempts: 2 })).toThrow(/changed elsewhere/);
    expect(existsSync(lock)).toBe(true);
    expect(readdirSync(lock)).toEqual([]);
    age(lock, 60_000);
    expect(withCredentialLock(home, () => 'ran', { attempts: 0 })).toBe('ran');
  });

  test('a writer that stalls between creating the lock and naming itself loses it to a reclaimer', () => {
    const home = freshHome();
    let releaseReclaimer: (() => void) | undefined;
    expect(() =>
      acquireCredentialLock(home, {
        attempts: 1,
        beforeOwner: () => {
          if (releaseReclaimer) return;
          // Past the grace period the empty lock is recovered, and the reclaimer owns it.
          age(lockOf(home), 60_000);
          releaseReclaimer = acquireCredentialLock(home, { attempts: 0 });
        },
      }),
    ).toThrow(/changed elsewhere/);
    expect(releaseReclaimer).toBeDefined();
    releaseReclaimer?.();
    expect(existsSync(lockOf(home))).toBe(false);
  });

  test('a writer that names itself while a reclaimer is mid-claim gives way', () => {
    const home = freshHome();
    let gaveWay = false;
    expect(() =>
      acquireCredentialLock(home, {
        attempts: 1,
        beforeOwner: () => {
          if (gaveWay) return;
          gaveWay = true;
          // A reclaimer's claim on the ownerless lock, linked before it has confirmed it.
          writeFileSync(join(lockOf(home), 'reclaimed-none'), String(process.pid));
        },
      }),
    ).toThrow(/changed elsewhere/);
    // Left to the process that is still running; recovered once it is gone, never taken by it.
    expect(readFileSync(join(lockOf(home), 'owner'), 'utf8')).toBe(String(process.pid));
  });

  test('a reclaimer of an ownerless lock gives way to the writer that names itself first', () => {
    const home = freshHome();
    plantLock(home, undefined, 60_000);
    let named = false;
    expect(() =>
      acquireCredentialLock(home, {
        attempts: 1,
        beforeOwner: () => {
          if (named) return;
          named = true;
          // The writer that created the lock links its owner after the claim was confirmed.
          writeFileSync(join(lockOf(home), 'owner'), String(process.pid));
        },
      }),
    ).toThrow(/changed elsewhere/);
    expect(named).toBe(true);
    const owner = join(lockOf(home), 'owner');
    expect(readFileSync(owner, 'utf8')).toBe(String(process.pid));
    expect(readdirSync(lockOf(home)).sort()).toEqual(['owner', 'reclaimed-none']);
  });

  test('a release leaves alone a lock that is no longer its own', () => {
    const home = freshHome();
    const release = acquireCredentialLock(home);
    // As an older release does: recovered by path and taken afresh by another writer.
    rmSync(lockOf(home), { recursive: true });
    plantLock(home, String(process.pid));
    const other = lockIdentity(home);
    release();
    expect(lockIdentity(home)).toBe(other);
  });

  // Root writes to a directory whatever its mode, so the lock could be removed after all.
  test.skipIf(process.getuid?.() === 0)(
    'a change that is made is reported even when its lock cannot be removed',
    () => {
      const home = freshHome();
      try {
        expect(
          withCredentialLock(home, () => {
            chmodSync(home, 0o500);
            return 'made';
          }),
        ).toBe('made');
      } finally {
        chmodSync(home, 0o700);
      }
      expect(readFileSync(join(lockOf(home), 'owner'), 'utf8')).toBe(String(process.pid));
    },
  );

  test('two reclaimers of one abandoned lock: one takes it, the other waits for it', () => {
    const home = freshHome();
    plantLock(home, String(deadPid()));
    let releaseFirst: (() => void) | undefined;
    let taken = '';
    // Both judge the lock abandoned; the first to claim it wins before the second claims.
    expect(() =>
      acquireCredentialLock(home, {
        attempts: 2,
        beforeClaim: () => {
          if (releaseFirst) return;
          releaseFirst = acquireCredentialLock(home, { attempts: 0 });
          taken = lockIdentity(home);
        },
      }),
    ).toThrow(/changed elsewhere/);
    expect(releaseFirst).toBeDefined();
    expect(readFileSync(join(lockOf(home), 'owner'), 'utf8')).toBe(String(process.pid));
    expect(lockIdentity(home)).toBe(taken);
    releaseFirst?.();
    expect(existsSync(lockOf(home))).toBe(false);
    acquireCredentialLock(home, { attempts: 0 })();
  });

  test('a fresh lock taken between the check and the claim is left alone', () => {
    const home = freshHome();
    plantLock(home, String(deadPid()));
    let releaseFresh: (() => void) | undefined;
    let fresh = '';
    expect(() =>
      acquireCredentialLock(home, {
        attempts: 2,
        beforeClaim: () => {
          if (releaseFresh) return;
          // Another reclaimer recovered the abandoned lock and finished, then a new writer took
          // the lock afresh. The waiting reclaimer's claim now resolves into that new lock.
          withCredentialLock(home, () => undefined, { attempts: 0 });
          releaseFresh = acquireCredentialLock(home, { attempts: 0 });
          fresh = lockIdentity(home);
        },
      }),
    ).toThrow(/changed elsewhere/);
    expect(lockIdentity(home)).toBe(fresh);
    // The stray claim is not part of the fresh lock's chain: its holder is still the fresh writer.
    expect(readdirSync(lockOf(home)).filter((name) => name.startsWith('reclaimed-'))).toHaveLength(
      1,
    );
    expect(() => acquireCredentialLock(home, { attempts: 1 })).toThrow(/changed elsewhere/);
    releaseFresh?.();
    expect(existsSync(lockOf(home))).toBe(false);
    acquireCredentialLock(home, { attempts: 0 })();
  });

  test('a fresh lock an older release took between the check and the claim is left alone', () => {
    const home = freshHome();
    const lock = plantLock(home, String(deadPid()));
    let fresh = '';
    expect(() =>
      acquireCredentialLock(home, {
        attempts: 2,
        beforeClaim: () => {
          if (fresh) return;
          rmSync(lock, { recursive: true });
          plantLock(home, String(process.pid));
          fresh = lockIdentity(home);
        },
      }),
    ).toThrow(/changed elsewhere/);
    expect(lockIdentity(home)).toBe(fresh);
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toBe(String(process.pid));
  });

  test('a reclaimer that died after its claim and before taking ownership is reclaimed in turn', () => {
    const home = freshHome();
    const lock = plantLock(home, String(deadPid()));
    const claim = join(lock, `reclaimed-${identity(join(lock, 'owner'))}`);
    writeFileSync(claim, String(deadPid()), { mode: 0o600 });
    // While that reclaimer lived, its claim made it the holder.
    const live = join(lock, `reclaimed-${identity(claim)}`);
    writeFileSync(live, String(process.pid), { mode: 0o600 });
    expect(() => acquireCredentialLock(home, { attempts: 1 })).toThrow(/changed elsewhere/);
    rmSync(live);
    expect(withCredentialLock(home, () => 'ran', { attempts: 0 })).toBe('ran');
    expect(existsSync(lock)).toBe(false);
  });

  test('a crash mid-write leaves nothing that blocks the next writer', async () => {
    const home = freshHome();
    createConsumerCredential(home, 'before the crash');
    // A process that died holding the lock, partway through changing the credentials.
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { acquireCredentialLock } from ${JSON.stringify(moduleUrl)};
         import { writeFileSync } from 'node:fs';
         import { join } from 'node:path';
         acquireCredentialLock(process.argv[1]);
         writeFileSync(join(process.argv[1], '.consumer-credentials.json-partial.tmp'), '{"vers');
         process.stdout.write('held');
         setInterval(() => {}, 60_000);`,
        home,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise<void>((resolve, reject) => {
      holder.stdout?.on('data', () => resolve());
      holder.on('exit', () => reject(new Error('the holder exited before taking the lock')));
    });
    // And one that died after writing its pid under its private name, before linking it in.
    const leftover = join(home, `consumer-credentials.lock.${deadPid()}.0123456789ab`);
    writeFileSync(leftover, '');
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.on('exit', resolve));
    expect(existsSync(lockOf(home))).toBe(true);
    createConsumerCredential(home, 'after the crash');
    expect(listConsumerCredentials(home).map((credential) => credential.label)).toEqual([
      'before the crash',
      'after the crash',
    ]);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(lockOf(home))).toBe(false);
  });

  test('processes reclaiming one abandoned lock never hold it at once', async () => {
    const home = freshHome();
    plantLock(home, String(deadPid()));
    const log = join(home, 'holders.log');
    const go = join(home, 'go');
    const rounds = 6;
    const run = (): ChildProcess =>
      spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { withCredentialLock } from ${JSON.stringify(moduleUrl)};
           import { appendFileSync, existsSync } from 'node:fs';
           const [home, log, go] = process.argv.slice(1);
           const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
           while (!existsSync(go)) pause(5);
           for (let round = 0; round < ${rounds}; round++)
             withCredentialLock(home, () => {
               appendFileSync(log, 'in ' + process.pid + '\\n');
               pause(5);
               appendFileSync(log, 'out ' + process.pid + '\\n');
             });`,
          home,
          log,
          go,
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      );
    const children = [run(), run(), run()];
    const exits = children.map(
      (child) => new Promise<number | null>((resolve) => child.on('exit', resolve)),
    );
    // Lets every child reach its wait before any of them can start.
    await new Promise((resolve) => setTimeout(resolve, 500));
    writeFileSync(go, '');
    expect(await Promise.all(exits)).toEqual([0, 0, 0]);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(children.length * rounds * 2);
    for (let index = 0; index < lines.length; index += 2) {
      const [entered, left] = [lines[index], lines[index + 1]];
      expect(entered).toMatch(/^in /);
      expect(left).toBe(entered?.replace(/^in /, 'out '));
    }
    expect(existsSync(lockOf(home))).toBe(false);
  });
});
