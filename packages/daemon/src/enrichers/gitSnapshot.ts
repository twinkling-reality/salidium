import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { resolveTrustedExecutable, trustedPathEntries } from '@salidium/adapter-kit';
import {
  type CanonicalEvent,
  type CanonicalEventOf,
  makeEventId,
  type StoredEvent,
} from '@salidium/protocol';
import type { Logger } from '../logging/logger.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { isRemoteOrDevicePath } from './fileLocation.ts';

const run = promisify(execFile);

type GitSnapshotEvent = CanonicalEventOf<'git.snapshot'>;
type SnapshotTrigger = NonNullable<GitSnapshotEvent['trigger']>;

/** What one read of the repository found, before it becomes an event. */
export type GitObservation = Pick<
  GitSnapshotEvent,
  'repoRoot' | 'head' | 'branch' | 'dirty' | 'dirtyTruncated'
>;

/**
 * A boundary that prompts a read. `restart` is a session starting again (resumed, cleared,
 * compacted): HEAD is worth reading, but it is not where the session's work started, so its
 * snapshot names no trigger and anchors nothing.
 */
type Boundary = SnapshotTrigger | 'restart';

/** Order in which waiting snapshots run: the boundary that happened first is read first. */
const BOUNDARY_ORDER: readonly Boundary[] = ['session.started', 'restart', 'commit', 'turn.ended'];

/** Reads running at once across all sessions, and the least time between one session's reads. */
const MAX_CONCURRENT_READS = 4;
const MIN_READ_INTERVAL_MS = 1000;

function boundaryOf(e: StoredEvent): Boundary | undefined {
  if (e.kind === 'turn.ended') return 'turn.ended';
  if (e.kind === 'session.started')
    return e.reason === undefined || e.reason === 'startup' ? 'session.started' : 'restart';
  if (e.kind === 'tool.completed' && e.result.kind === 'command' && e.result.gitOperation?.commit)
    return 'commit';
  return undefined;
}

/**
 * Read-only git observation at turn boundaries for LIVE sessions only: HEAD, branch, and dirty
 * paths. Emitted as `git.snapshot` events (observed by Salidium) so commit-aware session diffs
 * and "changes not attributable to a tool call" are possible. Never writes to the repo and never
 * runs for historical backfills (the repo now says nothing about the repo then).
 *
 * Each snapshot names its trigger, because the session report anchors work to the HEAD seen at
 * session start and at the latest turn end. So no boundary is dropped: one read runs per session
 * at a time, and boundaries that arrive meanwhile wait, at most one per kind, and run next. A
 * turn end that closely follows a commit used to be skipped by a fixed interval, which left the
 * turn without a snapshot of its own. Waiting coalesces instead: a session's reads are at least a
 * second apart, and at most four git reads run at once across all sessions.
 */
export class GitSnapshotEnricher {
  private readonly registry: SessionRegistry;
  private readonly log: Logger;
  private readonly read: (cwd: string) => Promise<GitObservation | undefined>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly inFlight = new Set<string>();
  /** When each session's latest read started, so the gap holds across bursts too. Bounded. */
  private readonly lastReadAt = new Map<string, number>();
  private readonly waiting = new Map<string, Map<Boundary, StoredEvent>>();
  private reading = 0;
  private readonly readers: Array<() => void> = [];
  private unsubscribe: (() => void) | undefined;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    registry: SessionRegistry,
    log: Logger,
    options: {
      read?: (cwd: string) => Promise<GitObservation | undefined>;
      now?: () => number;
      minIntervalMs?: number;
    } = {},
  ) {
    this.registry = registry;
    this.log = log;
    this.read = options.read ?? readGitObservation;
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? MIN_READ_INTERVAL_MS;
  }

  start(): void {
    this.unsubscribe = this.registry.subscribeAll((sessionId, events) => {
      // The last boundary in a batch is the one the repository reflects when it is read.
      const trigger = events.findLast((e) => boundaryOf(e) !== undefined);
      if (!trigger) return;
      const age = this.now() - Date.parse(trigger.ts);
      // Live means recent and not from the future: a record dated ahead is not evidence of now.
      if (!(age >= 0 && age <= 120_000)) return;
      this.request(sessionId, trigger);
    });
  }

  /** Resolves once no snapshot is running or waiting. For tests and orderly shutdown. */
  settled(): Promise<void> {
    return this.idle;
  }

  private request(sessionId: string, trigger: StoredEvent): void {
    const kind = boundaryOf(trigger);
    if (!kind) return;
    if (this.inFlight.has(sessionId)) {
      const queue = this.waiting.get(sessionId) ?? new Map<Boundary, StoredEvent>();
      queue.set(kind, trigger);
      this.waiting.set(sessionId, queue);
      return;
    }
    this.inFlight.add(sessionId);
    const done = this.drain(sessionId, trigger, kind);
    this.idle = this.idle.then(() => done);
  }

  private async drain(sessionId: string, first: StoredEvent, firstKind: Boundary): Promise<void> {
    let next: [StoredEvent, Boundary] | undefined = [first, firstKind];
    try {
      while (next) {
        const since = Date.now() - (this.lastReadAt.get(sessionId) ?? Number.NEGATIVE_INFINITY);
        if (since < this.minIntervalMs)
          await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs - since));
        const [trigger, kind] = next;
        await this.throttled(() => {
          // Stamped once the read holds a slot, so time spent queued does not count as a gap.
          this.rememberRead(sessionId, Date.now());
          return this.snapshot(sessionId, trigger, kind);
        });
        next = undefined;
        const queue = this.waiting.get(sessionId);
        for (const waitingKind of BOUNDARY_ORDER) {
          const waitingTrigger = queue?.get(waitingKind);
          if (!waitingTrigger) continue;
          queue?.delete(waitingKind);
          next = [waitingTrigger, waitingKind];
          break;
        }
        if (queue && queue.size === 0) this.waiting.delete(sessionId);
      }
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private rememberRead(sessionId: string, at: number): void {
    this.lastReadAt.delete(sessionId);
    this.lastReadAt.set(sessionId, at);
    if (this.lastReadAt.size > 1024) {
      const oldest = this.lastReadAt.keys().next().value;
      if (oldest !== undefined) this.lastReadAt.delete(oldest);
    }
  }

  /** Runs one read once fewer than the maximum are running; a finished read hands its slot on. */
  private async throttled(work: () => Promise<void>): Promise<void> {
    if (this.reading >= MAX_CONCURRENT_READS)
      await new Promise<void>((resolve) => this.readers.push(resolve));
    else this.reading += 1;
    try {
      await work();
    } finally {
      const nextReader = this.readers.shift();
      if (nextReader) nextReader();
      else this.reading -= 1;
    }
  }

  private async snapshot(sessionId: string, trigger: StoredEvent, kind: Boundary): Promise<void> {
    const cwd = this.registry.peek(sessionId)?.state.cwd;
    if (!cwd) return;
    try {
      const observed = await this.read(cwd);
      if (!observed) return;
      const event: CanonicalEvent = {
        id: makeEventId(sessionId, 'git', 'snapshot', trigger.seq),
        sessionId,
        ts: new Date(this.now()).toISOString(),
        tsSource: 'ingest',
        turnId: trigger.turnId,
        source: { provider: trigger.source.provider, channel: 'salidium' },
        kind: 'git.snapshot',
        ...(kind === 'restart' ? {} : { trigger: kind }),
        ...observed,
      };
      this.registry.ingest(sessionId, [event]);
    } catch (err) {
      this.log.debug('git snapshot skipped', { sessionId, err: String(err) });
    }
  }

  stop(): void {
    this.unsubscribe?.();
  }
}

/**
 * The working tree, HEAD and branch of the repository containing `cwd`, read with git itself.
 *
 * Only `rev-parse`, which reads refs and configuration and runs nothing they name. `git status`
 * used to run here too, and status runs a repository's own `core.fsmonitor` command and its clean
 * filters, so a repository an agent works in could have run code as Salidium. Its output was used
 * only for the snapshot's own drill-through, so the dirty list is no longer read at all.
 */
export async function readGitObservation(cwd: string): Promise<GitObservation | undefined> {
  if (!isAbsolute(cwd) || isRemoteOrDevicePath(cwd)) return undefined;
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return undefined;
  const repoRoot = top.trim();
  const head = (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']))?.trim();
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  return {
    repoRoot,
    head: head || undefined,
    branch: branch && branch !== 'HEAD' ? branch : undefined,
  };
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const trust = { environment: process.env, untrustedRoots: [process.cwd(), cwd] };
    const command = resolveTrustedExecutable('git', trust);
    if (!command) return undefined;
    // fsmonitor is off as defence in depth: nothing run here should consult it.
    const { stdout } = await run(command, ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      env: gitEnvironment(
        process.env,
        trustedPathEntries(trust).join(process.platform === 'win32' ? ';' : ':'),
      ),
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/** Variables git may inherit. Everything else, every GIT_* variable included, is left out. */
const GIT_ENVIRONMENT = new Set(
  [
    'HOME',
    'LANG',
    'TMPDIR',
    'DEVELOPER_DIR',
    'XDG_CONFIG_HOME',
    // What git needs to start on Windows, where names are case-insensitive.
    'SYSTEMROOT',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'TEMP',
    'TMP',
  ].map((name) => name.toUpperCase()),
);

/**
 * The environment git runs in: an allowlist, not the daemon's own environment. A daemon started
 * from a git hook or `rebase --exec` inherits GIT_DIR or GIT_WORK_TREE, which would make git read
 * a different repository from the one `cwd` names, and GIT_CONFIG_PARAMETERS or GIT_EXEC_PATH
 * would change what it runs.
 */
export function gitEnvironment(from: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: path, GIT_OPTIONAL_LOCKS: '0' };
  for (const [name, value] of Object.entries(from))
    if (
      value !== undefined &&
      (GIT_ENVIRONMENT.has(name.toUpperCase()) || name.toUpperCase().startsWith('LC_'))
    )
      env[name] = value;
  return env;
}
