import { applyEvent, createInitialState, REDUCER_VERSION, type RunState } from '@salidium/core';
import type { ProviderId, SemanticChange } from '@salidium/protocol';
import type { Logger } from '../logging/logger.ts';
import type { SalidiumStore, SessionNeedingReplay } from '../storage/salidiumStore.ts';

/** Where the warm-up stands, for status and the operations contract. */
export interface HistoryWarmupProgress {
  state: 'running' | 'paused';
  /** Sessions brought up to the current reducer since it first asked, across restarts. */
  updated: number;
  total: number;
  reducerVersion: string;
}

export interface HistoryWarmupOptions {
  store: SalidiumStore;
  log: Logger;
  /** A session a coordinator holds is its own; the warm-up leaves it alone. */
  isLive: (sessionId: string) => boolean;
  /** Collection pause or maintenance: no work until it ends. */
  isPaused: () => boolean;
  /** Events replayed between yields to the event loop, and the time one slice may take. */
  sliceEvents?: number;
  sliceMs?: number;
  /** Lets the event loop run between slices. A test can count or delay it. */
  yieldToLoop?: () => Promise<void>;
  /** How long to wait while paused before looking again. */
  pausePollMs?: number;
  now?: () => number;
  reducerVersion?: string;
}

const PAGE = 500;

/**
 * Brings stored sessions up to the current reducer in the background, so the first open of an
 * older session after an upgrade does not replay its whole log while the daemon waits.
 *
 * A reducer change invalidates every checkpoint, and the replay that follows ran on first open, on
 * the main thread, in one piece: a large session held the daemon for seconds, and hooks, the CLI
 * and stop all timed out behind it. This replays the same way an interface load does, newest
 * activity first, in slices that yield to the event loop, so no slice holds it for more than about
 * `sliceMs`. When a session is done it writes what that load would have written, the checkpoint
 * and the rewritten change log, and drops the session's checkpoints from older reducers, in one
 * transaction. It never creates a coordinator, so it neither marks a session as loaded for
 * retention nor schedules an explanation.
 *
 * Progress is durable without a separate cursor: a session that has a checkpoint at the current
 * version is done, so after a restart the work continues with what remains. A session the person
 * opens meanwhile is replayed by that open, as before, and then counts as done. One whose replay
 * fails is left to its first open and not retried in this process.
 */
export class HistoryWarmup {
  private readonly opts: Required<
    Omit<HistoryWarmupOptions, 'yieldToLoop' | 'now' | 'reducerVersion'>
  > &
    Pick<HistoryWarmupOptions, 'yieldToLoop'> & { now: () => number; reducerVersion: string };
  private readonly failed = new Set<string>();
  private stopped = false;
  private running: Promise<void> | undefined;
  private total = 0;
  private remaining = 0;
  private paused = false;
  private finished = false;

  constructor(options: HistoryWarmupOptions) {
    this.opts = {
      sliceEvents: 2000,
      sliceMs: 150,
      pausePollMs: 1000,
      now: Date.now,
      reducerVersion: REDUCER_VERSION,
      ...options,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = this.run().catch((error) => {
      this.opts.log.warn('session history update stopped', { err: String(error) });
    });
  }

  /** Stops after the current slice. Nothing half-replayed is written. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  /** Resolves when the work is done or stopped. For tests. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /** Null when there is nothing to update. */
  progress(): HistoryWarmupProgress | null {
    if (!this.running || this.finished || this.remaining === 0) return null;
    return {
      state: this.paused ? 'paused' : 'running',
      updated: Math.max(0, this.total - this.remaining),
      total: this.total,
      reducerVersion: this.opts.reducerVersion,
    };
  }

  private async run(): Promise<void> {
    const { store, reducerVersion } = this.opts;
    if (!store.sessionsNeedingReplay || !store.saveReplayedSession) return;
    this.refreshCounts();
    if (this.remaining > 0)
      this.opts.log.info('updating session history for a new reducer', {
        reducerVersion,
        sessions: this.remaining,
        total: this.total,
      });
    while (!this.stopped) {
      if (this.opts.isPaused()) {
        this.paused = true;
        await sleep(this.opts.pausePollMs);
        continue;
      }
      this.paused = false;
      const next = store
        .sessionsNeedingReplay(reducerVersion, this.failed.size + 16)
        .find((s) => !this.failed.has(s.sessionId) && !this.opts.isLive(s.sessionId));
      // Nothing left but sessions a coordinator holds, which write their own checkpoints, and
      // ones that failed here, which their first open will replay as before.
      if (!next) break;
      try {
        await this.warm(next);
      } catch (error) {
        this.failed.add(next.sessionId);
        this.opts.log.warn('session history update skipped a session', {
          sessionId: next.sessionId,
          err: String(error),
        });
      }
      this.refreshCounts();
      // Between sessions too: thousands of small ones would otherwise run back to back.
      await this.yieldToLoop();
    }
    this.finished = true;
    if (!this.stopped) this.opts.log.info('session history is up to date', { reducerVersion });
  }

  private refreshCounts(): void {
    const { store, reducerVersion } = this.opts;
    this.remaining = store.countSessionsNeedingReplay?.(reducerVersion) ?? 0;
    this.total = store.replayTotal?.(reducerVersion, this.remaining) ?? this.remaining;
  }

  /** Replays one session in slices, then stores it unless it went live or the work stopped. */
  private async warm(session: SessionNeedingReplay): Promise<void> {
    const { store, reducerVersion, sliceEvents, sliceMs, now } = this.opts;
    const state: RunState = createInitialState({
      sessionId: session.sessionId,
      provider: session.provider as ProviderId,
      providerSessionId: session.providerSessionId,
      cwd: session.cwd,
    });
    const changes: SemanticChange[] = [];
    let cursor = -1;
    for (;;) {
      let inSlice = 0;
      const sliceStart = now();
      let reachedEnd = false;
      while (inSlice < sliceEvents && now() - sliceStart < sliceMs) {
        const latest = store.latestSeq(session.sessionId);
        const page = store.eventsAfter(
          session.sessionId,
          cursor,
          latest,
          Math.min(PAGE, sliceEvents - inSlice),
        );
        if (page.length === 0) {
          reachedEnd = true;
          break;
        }
        for (const event of page) {
          const derived = applyEvent(state, event);
          if (derived.length) changes.push(...derived);
        }
        cursor = page[page.length - 1]?.seq ?? cursor;
        inSlice += page.length;
      }
      if (reachedEnd) break;
      await this.yieldToLoop();
      // Checked after every slice: a session someone opened, or work told to stop, is not ours.
      if (this.stopped || this.opts.isPaused() || this.opts.isLive(session.sessionId)) return;
    }
    // Written in the same turn of the event loop as the final checks, so no event or load can
    // come between them.
    if (this.opts.isLive(session.sessionId)) return;
    if (store.latestSeq(session.sessionId) !== state.latestSeq) return; // grew; next pass redoes it
    if (state.latestSeq < 0) return;
    store.saveReplayedSession?.(session.sessionId, state.latestSeq, reducerVersion, state, changes);
  }

  private yieldToLoop(): Promise<void> {
    return this.opts.yieldToLoop
      ? this.opts.yieldToLoop()
      : new Promise((resolve) => setImmediate(resolve));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
