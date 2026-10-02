import { execFile } from 'node:child_process';
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
        const startedAt = Date.now();
        const [trigger, kind] = next;
        await this.throttled(() => this.snapshot(sessionId, trigger, kind));
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
        const wait = this.minIntervalMs - (Date.now() - startedAt);
        if (next && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    } finally {
      this.inFlight.delete(sessionId);
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

/** HEAD, branch and dirty paths of the repository containing `cwd`, read with git itself. */
export async function readGitObservation(cwd: string): Promise<GitObservation | undefined> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return undefined;
  const repoRoot = top.trim();
  const head = (await git(cwd, ['rev-parse', 'HEAD']))?.trim();
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  const status = (await git(cwd, ['status', '--porcelain=v2', '--untracked-files=normal'])) ?? '';
  const dirty: Array<{ path: string; status: string }> = [];
  for (const line of status.split('\n')) {
    if (!line) continue;
    const parts = line.split(' ');
    if (line.startsWith('1 ') || line.startsWith('2 '))
      dirty.push({
        status: parts[1] ?? '',
        path: parts.slice(8).join(' ').split('\t')[0] ?? '',
      });
    else if (line.startsWith('u ')) dirty.push({ status: 'U', path: parts.slice(10).join(' ') });
    else if (line.startsWith('? ')) dirty.push({ status: '?', path: line.slice(2) });
    if (dirty.length >= 200) break;
  }
  return {
    repoRoot,
    head: head || undefined,
    branch: branch && branch !== 'HEAD' ? branch : undefined,
    dirty,
    dirtyTruncated: dirty.length >= 200 || undefined,
  };
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const trust = { environment: process.env, untrustedRoots: [process.cwd(), cwd] };
    const command = resolveTrustedExecutable('git', trust);
    if (!command) return undefined;
    const { stdout } = await run(command, ['-C', cwd, ...args], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: trustedPathEntries(trust).join(process.platform === 'win32' ? ';' : ':'),
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    return stdout;
  } catch {
    return undefined;
  }
}
