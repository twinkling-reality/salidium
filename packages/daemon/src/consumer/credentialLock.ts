import { randomBytes } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * The lock that serializes read-modify-write of `consumer-credentials.json` between processes.
 *
 * Without it, a revoke racing a create can write back a list read before the revoke, which
 * resurrects a credential the person just withdrew. Every holder finishes in milliseconds.
 *
 * The lock is a directory holding an `owner` file with its holder's pid, the layout earlier
 * releases use, and `mkdir` takes it, as it does for them, so they and this one exclude each other.
 * Three rules keep two writers out:
 *
 * - An owner that cannot be read, absent, empty or garbled, is a holder not yet known, not a dead
 *   one. Such a lock is recovered only once nothing in it has changed for a grace period. This
 *   release writes its pid in full beforehand and links it in as the owner just after `mkdir`, so
 *   its own owner is never partial, and it renames the lock aside before removing it, so the lock
 *   never sits empty at its path.
 * - A lock whose holder died is taken over in place, never removed by path. Each reclaimer links a
 *   claim named after the holder it judged dead; `link` refuses every name that exists, so exactly
 *   one reclaimer of that holder wins. The winner then confirms the claim landed in the very lock
 *   it judged, since the path may by then name a fresh lock, and only then becomes the owner.
 *
 * A claim whose winner died before taking ownership is the next holder in a chain, judged and
 * claimed the same way, so no crash leaves a lock that cannot be recovered. A claim that landed in
 * a fresh lock is harmless: it is named for a holder that lock does not have, so it is never part
 * of its chain, and it is removed with the lock.
 *
 * Earlier releases remove a lock whose owner names a dead pid by path, without these checks. Run
 * alongside this one while a holder has died, one of them can still delete a lock this release has
 * just taken over; nothing on this side can prevent that.
 */
const LOCK_DIRECTORY = 'consumer-credentials.lock';
const OWNER = 'owner';
const CLAIM_PREFIX = 'reclaimed-';
const LEFTOVER = /^consumer-credentials\.lock\.([1-9][0-9]*)\.[0-9a-f]{12}$/;
const UNKNOWN_OWNER_GRACE_MS = 5_000;
const ATTEMPTS = 60;
const PAUSE_MS = 50;
const MAX_CHAIN = 64;

/** A holder named in the lock: its file's identity, and its pid when the file holds one. */
interface Holder {
  identity: string;
  pid: number | undefined;
  modifiedMs: number;
}

interface LockState {
  ino: bigint;
  modifiedMs: number;
  owner: Holder | undefined;
  /** Claims in the order they were won, each named after the holder before it. */
  claims: Holder[];
}

export interface CredentialLockOptions {
  /** How many times to look again before giving up, at 50 ms apart. */
  attempts?: number;
  /** Called after a lock is judged abandoned and before it is claimed. For tests. */
  beforeClaim?: () => void;
  /** Called before this process names itself the owner, of a free lock or one taken over. For tests. */
  beforeOwner?: () => void;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Reads a holder file through one descriptor, so its identity and its pid are of the same file. */
function readHolder(path: string): Holder | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return undefined;
    throw error;
  }
  try {
    const info = fstatSync(descriptor, { bigint: true });
    const text = readFileSync(descriptor, 'utf8');
    const pid = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : undefined;
    return {
      identity: `${info.ino}-${info.mtimeNs}`,
      pid: pid !== undefined && pid <= 2 ** 31 - 1 ? pid : undefined,
      modifiedMs: Number(info.mtimeMs),
    };
  } finally {
    closeSync(descriptor);
  }
}

/** The lock as one consistent snapshot, or undefined when there is none. */
function readLockState(lock: string): LockState | undefined {
  for (let read = 0; read < 5; read++) {
    const state = readLockStateOnce(lock);
    if (state !== 'changed') return state;
  }
  return undefined;
}

function readLockStateOnce(lock: string): LockState | 'changed' | undefined {
  let info: BigIntStats;
  try {
    info = lstatSync(lock, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isDirectory())
    throw new Error(`${lock} is not a directory; remove it if no salidium command is running`);
  const owner = readHolder(join(lock, OWNER));
  const claims: Holder[] = [];
  let previous = owner?.identity ?? 'none';
  for (;;) {
    const claim = readHolder(join(lock, `${CLAIM_PREFIX}${previous}`));
    if (!claim) break;
    if (claims.length >= MAX_CHAIN) throw new Error(`${lock} holds too many claims`);
    claims.push(claim);
    previous = claim.identity;
  }
  // The holders were read from whatever directory was at the path by then. Only if that is still
  // the directory first seen, unchanged, do they belong to it.
  try {
    const after = lstatSync(lock, { bigint: true });
    if (after.ino !== info.ino || after.mtimeNs !== info.mtimeNs) return 'changed';
  } catch {
    return 'changed';
  }
  return { ino: info.ino, modifiedMs: Number(info.mtimeMs), owner, claims };
}

function holderOf(state: LockState): Holder | undefined {
  return state.claims.at(-1) ?? state.owner;
}

/**
 * Whether the lock's holder is gone. A pid answers that directly. A holder with no readable pid is
 * an older release between creating the lock and writing its owner, or one that died there; only
 * the passing of the grace period without any change to the lock tells them apart.
 */
function abandoned(state: LockState): boolean {
  const holder = holderOf(state);
  if (holder?.pid !== undefined) return !processAlive(holder.pid);
  return Date.now() - Math.max(state.modifiedMs, holder?.modifiedMs ?? 0) > UNKNOWN_OWNER_GRACE_MS;
}

function sameHolders(state: LockState, seen: LockState, claimed: string): boolean {
  const expected = [...seen.claims.map((claim) => claim.identity), claimed];
  return (
    state.ino === seen.ino &&
    state.owner?.identity === seen.owner?.identity &&
    state.claims.length === expected.length &&
    state.claims.every((claim, index) => claim.identity === expected[index])
  );
}

/**
 * Takes a free lock. The pid goes in by `link` of a file already written, so it is whole. Only a
 * reclaimer that judged this lock ownerless can contend, and only after the grace period, which
 * this process would have to stall through between the two calls. Each of us writes, then reads
 * what the other wrote, so at least one sees the other and gives way: here, a claim on the empty
 * lock means it is not ours. Giving way leaves our live pid as the owner, so the lock is recovered
 * once this process is gone, never while either of us could still be writing.
 */
function tryTakeFree(lock: string, ticket: string, options: CredentialLockOptions): boolean {
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
  options.beforeOwner?.();
  try {
    linkSync(ticket, join(lock, OWNER));
  } catch (error) {
    // Recovered by a reclaimer while we stalled, and perhaps released since.
    if (['EEXIST', 'ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) return false;
    throw error;
  }
  return readHolder(join(lock, `${CLAIM_PREFIX}none`)) === undefined;
}

/** One attempt: take a free lock, or take over an abandoned one. */
function tryTake(
  lock: string,
  ticket: string,
  mine: string,
  options: CredentialLockOptions,
): boolean {
  if (tryTakeFree(lock, ticket, options)) return true;
  const seen = readLockState(lock);
  if (!seen || !abandoned(seen)) return false;
  options.beforeClaim?.();
  try {
    linkSync(ticket, join(lock, `${CLAIM_PREFIX}${holderOf(seen)?.identity ?? 'none'}`));
  } catch (error) {
    // Another reclaimer won this holder, or the lock is gone; look again.
    if (['EEXIST', 'ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) return false;
    throw error;
  }
  const now = readLockState(lock);
  if (!now || !sameHolders(now, seen, mine)) return false;
  // Ours now. Writing our pid as the owner also keeps older releases, which read only the owner,
  // from judging the lock abandoned. A dead owner is replaced. An absent one is linked, never
  // overwritten: a writer that stalled after creating the lock may name itself first, and then
  // its owner ends the chain, so it holds the lock and this claim gives way.
  options.beforeOwner?.();
  try {
    if (seen.owner) renameSync(ticket, join(lock, OWNER));
    else linkSync(ticket, join(lock, OWNER));
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EEXIST') return false;
    throw error;
  }
  return true;
}

/** Removes what a process that died mid-lock left beside it: a ticket, or a lock set aside. */
function sweepLeftovers(home: string): void {
  for (const name of readdirSync(home)) {
    const pid = Number(LEFTOVER.exec(name)?.[1] ?? 0);
    if (pid > 0 && pid !== process.pid && !processAlive(pid))
      rmSync(join(home, name), { recursive: true, force: true });
  }
}

/** Takes the lock and returns its release. Throws once it has stayed held for the whole budget. */
export function acquireCredentialLock(
  home: string,
  options: CredentialLockOptions = {},
): () => void {
  const lock = join(home, LOCK_DIRECTORY);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // This process's pid, written in full before it is linked into the lock as its owner or a claim.
  const ticket = `${lock}.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(ticket, String(process.pid), { mode: 0o600, flag: 'wx' });
    const mine = (readHolder(ticket) as Holder).identity;
    for (let attempt = 0; !tryTake(lock, ticket, mine, options); attempt++) {
      if (attempt >= (options.attempts ?? ATTEMPTS))
        throw new Error('consumer credentials are being changed elsewhere');
      pause(PAUSE_MS);
    }
    sweepLeftovers(home);
    return () => {
      const state = readLockState(lock);
      // Not ours any more only if an older release judged it abandoned; leave whatever is there.
      if (!state || holderOf(state)?.identity !== mine) return;
      // Set aside under the ticket's name, free again by now, so it is never empty at its path.
      renameSync(lock, ticket);
      rmSync(ticket, { recursive: true, force: true });
    };
  } finally {
    // The lock keeps its own link to the pid; this name is no longer needed.
    rmSync(ticket, { force: true });
  }
}

export function withCredentialLock<T>(
  home: string,
  work: () => T,
  options: CredentialLockOptions = {},
): T {
  const release = acquireCredentialLock(home, options);
  try {
    return work();
  } finally {
    // The change is made by now. A lock that could not be removed names this process, so it is
    // recovered as soon as the process exits, and reporting failure here would hide a created
    // credential's only copy of its token.
    try {
      release();
    } catch {
      /* recovered later, as above */
    }
  }
}
