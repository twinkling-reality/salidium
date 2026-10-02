import { statSync } from 'node:fs';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { StoreCursor, StoreRawRecord, StoreSource } from '@salidium/adapter-kit';
import type { EventSource, ProviderId } from '@salidium/protocol';
import type { Logger } from '../logging/logger.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';
import type { ReingestJob, SalidiumStore } from '../storage/salidiumStore.ts';
import { MAX_INGEST_PAYLOAD_BYTES } from './limits.ts';
import { sourceToStoreCursor, storeCursorToSource, storePathOf } from './storeCursors.ts';

export interface StoreProvider {
  id: ProviderId;
  source: StoreSource;
}

interface Tracked {
  provider: StoreProvider;
  path: string;
  /** Size and modification time of the source's change indicators at the last completed read. */
  signature: string;
  cursors: Map<string, StoreCursor>;
}

const DEFAULT_POLL_MS = 1000;
const DEFAULT_ROW_BUDGET = 2000;

/**
 * Polls providers whose durable record is a local database. The source reads; this class decides
 * when, persists every accepted batch before advancing its cursor (as the transcript tailer does
 * for byte offsets), and leaves the database alone while it has not changed.
 *
 * A poll is cheap when nothing happened: it compares the size and modification time of the store
 * and its write-ahead log and returns. When they move, the source reads only sessions whose
 * durable sequence moved.
 */
export class StoreTailer {
  private readonly providers: readonly StoreProvider[];
  private readonly registry: SessionRegistry;
  private readonly store: SalidiumStore;
  private readonly log: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pollIntervalMs: number;
  private readonly rowBudget: number;
  private readonly tracked = new Map<ProviderId, Tracked>();
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private startedWith: { userHome: string; historyDays: number } | undefined;
  private paused = false;
  private stopped = false;

  constructor(args: {
    providers: readonly StoreProvider[];
    registry: SessionRegistry;
    store: SalidiumStore;
    log: Logger;
    /** Environment used to locate stores (XDG_DATA_HOME). Test seam; production uses process.env. */
    env?: NodeJS.ProcessEnv;
    pollIntervalMs?: number;
    rowBudget?: number;
  }) {
    this.providers = args.providers;
    this.registry = args.registry;
    this.store = args.store;
    this.log = args.log;
    this.env = args.env ?? process.env;
    this.pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.rowBudget = args.rowBudget ?? DEFAULT_ROW_BUDGET;
  }

  /** Providers this tailer owns; the transcript tailer leaves their re-ingest jobs alone. */
  get providerIds(): ProviderId[] {
    return this.providers.map((p) => p.id);
  }

  countForProvider(providerId: string): number {
    return this.tracked.get(providerId as ProviderId)?.cursors.size ?? 0;
  }

  /** Reads re-ingest jobs, then the history window, then keeps polling. */
  start(userHome: string, historyDays: number): Promise<void> {
    this.startedWith = { userHome, historyDays };
    if (this.providers.length === 0) return Promise.resolve();
    const initial = this.run(true);
    this.timer = setInterval(() => void this.run(false), this.pollIntervalMs);
    this.timer.unref?.();
    return initial;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (this.stopped) return;
    this.paused = false;
    void this.run(false);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Waits for a poll in progress; a test seam for "nothing is being read now". */
  async idle(): Promise<void> {
    await this.inFlight;
  }

  /** Runs one poll now. Test seam; production polls on its interval. */
  pollNow(): Promise<void> {
    return this.run(false);
  }

  /**
   * Re-reads a record an event cites, for the raw-evidence view. Undefined when the event's
   * provider is not a store-backed provider this tailer serves (it is disabled or not one).
   */
  readRawRecord(
    providerId: string,
    ref: NonNullable<EventSource['ref']>,
  ): StoreRawRecord | undefined {
    const provider = this.providers.find((p) => p.id === providerId);
    if (!provider || !this.startedWith) return undefined;
    const path = provider.source.locate({ userHome: this.startedWith.userHome, env: this.env });
    if (!path) return { raw: undefined, reason: 'provider store no longer on disk' };
    return provider.source.readRawRecord(path, ref);
  }

  private run(initial: boolean): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.pollAll(initial).finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private async pollAll(initial: boolean): Promise<void> {
    const started = this.startedWith;
    if (!started || this.stopped || this.paused) return;
    for (const provider of this.providers) {
      if (this.stopped || this.paused) return;
      try {
        await this.pollProvider(provider, started, initial);
      } catch (error) {
        // A store being migrated or locked by its writer is retried on the next tick.
        this.log.warn('provider store could not be read', {
          provider: provider.id,
          err: String(error),
        });
      }
    }
  }

  private signature(provider: StoreProvider, path: string): string {
    return provider.source
      .changeIndicators(path)
      .map((file) => {
        try {
          const st = statSync(file);
          return `${st.ino}:${st.size}:${st.mtimeMs}`;
        } catch {
          return '-';
        }
      })
      .join('|');
  }

  private trackedFor(provider: StoreProvider, path: string): Tracked {
    const existing = this.tracked.get(provider.id);
    if (existing?.path === path) return existing;
    const cursors = new Map<string, StoreCursor>();
    for (const source of this.store.allSources()) {
      if (source.provider !== provider.id || storePathOf(source.path) !== path) continue;
      const cursor = sourceToStoreCursor(source);
      if (cursor) cursors.set(cursor.key, cursor);
    }
    const tracked: Tracked = { provider, path, signature: '', cursors };
    this.tracked.set(provider.id, tracked);
    return tracked;
  }

  private async pollProvider(
    provider: StoreProvider,
    started: { userHome: string; historyDays: number },
    initial: boolean,
  ): Promise<void> {
    const path = provider.source.locate({ userHome: started.userHome, env: this.env });
    const jobs = this.store.pendingReingestJobs().filter((job) => job.provider === provider.id);
    if (!path) {
      for (const job of jobs) {
        this.store.startReingestJob(job.id);
        this.store.finishReingestJob(job.id, 'missing', 'provider store no longer exists');
      }
      return;
    }
    const tracked = this.trackedFor(provider, path);
    let origin: 'ingest' | 'backfill' = 'ingest';
    if (jobs.length) {
      this.log.info('re-ingesting provider store evidence', {
        provider: provider.id,
        jobs: jobs.length,
      });
      for (const job of jobs) {
        this.store.startReingestJob(job.id);
        this.forget(tracked, job);
      }
      origin = 'backfill';
      tracked.signature = '';
    }
    const signature = this.signature(provider, path);
    if (!initial && !jobs.length && signature === tracked.signature) return;
    const activeSinceMs = Math.max(0, Date.now() - started.historyDays * 24 * 60 * 60_000);
    let complete = true;
    for (let round = 0; ; round++) {
      if (this.stopped || this.paused) {
        complete = false;
        break;
      }
      const result = provider.source.poll({
        path,
        activeSinceMs,
        cursors: tracked.cursors,
        observedAt: new Date().toISOString(),
        maxRecordBytes: MAX_INGEST_PAYLOAD_BYTES,
        rowBudget: this.rowBudget,
      });
      for (const batch of result.batches) {
        if (batch.events.length)
          this.registry.ingest(batch.cursor.sessionId, batch.events, { fingerprintOrigin: origin });
        // The cursor is the recovery boundary: persist the events first. On failure the old cursor
        // stays, and the next poll reads the same rows again; event ids make that harmless.
        if (!this.registry.flush(batch.cursor.sessionId)) {
          complete = false;
          continue;
        }
        this.store.upsertSource(storeCursorToSource(batch.cursor, provider.id));
        tracked.cursors.set(batch.cursor.key, batch.cursor);
      }
      if (!result.more) break;
      if (round % 4 === 3) await yieldToLoop();
    }
    if (complete) tracked.signature = signature;
    for (const job of jobs)
      this.store.finishReingestJob(
        job.id,
        complete ? 'completed' : 'failed',
        complete ? undefined : 'read or persistence failed; retry on next daemon start',
      );
  }

  /**
   * A re-ingest job reads its session (or, for the store path itself, every session Salidium has
   * read) again from the first row. The cursor is reset rather than dropped, so a session older
   * than the history window is still read.
   */
  private forget(tracked: Tracked, job: ReingestJob): void {
    if (storePathOf(job.path) !== tracked.path) return;
    for (const [key, cursor] of tracked.cursors) {
      if (job.path === tracked.path || key === job.path || cursor.sessionId === job.sessionId)
        tracked.cursors.set(key, { ...cursor, position: -1, count: 0 });
    }
  }
}
