import {
  applyEvent,
  cloneState,
  createInitialState,
  REDUCER_VERSION,
  type RunState,
  replayEvents,
} from '@salidium/core';
import {
  type CanonicalEvent,
  type ExplainerCadence,
  type ExplainerUsage,
  type ProviderId,
  parseSessionId,
  type SemanticChange,
  type SessionList,
  type SessionSnapshot,
  type SessionSummary,
  type StoredEvent,
} from '@salidium/protocol';
import type { RetentionPreview, SalidiumStore } from '../storage/salidiumStore.ts';
import { type CoordinatorListener, SessionCoordinator } from './sessionCoordinator.ts';

export type EventSubscriber = (events: StoredEvent[], changes: SemanticChange[]) => void;
export type SummarySubscriber = (summary: SessionSummary) => void;
export type RemovalSubscriber = (sessionId: string) => void;

/**
 * Holds live coordinators for sessions and fans events out to subscribers. Sessions are loaded
 * from the store on first access (checkpoint + tail) and evicted when idle for a long time.
 */
/**
 * Salidium's own enrichment calls are real agent sessions and appear in the transcript like any
 * other. The title check covers a summary persisted before its first turn arrived, when the flag
 * is not set yet. Every path that emits a summary must use this — the list and the stream both.
 */
export function isUserSession(s: SessionSummary): boolean {
  return !s.internal && !s.title?.includes('[salidium-explainer]');
}

/** Last activity first, which is the order every session surface presents. */
function byRecency(a: SessionSummary, b: SessionSummary): number {
  return (b.lastEventAt ?? b.startedAt ?? '').localeCompare(a.lastEventAt ?? a.startedAt ?? '');
}

export class SessionRegistry {
  private readonly store: SalidiumStore;
  private readonly live = new Map<string, SessionCoordinator>();
  private readonly lastTouched = new Map<string, number>();
  private readonly eventSubscribers = new Map<string, Set<EventSubscriber>>();
  private readonly summarySubscribers = new Set<SummarySubscriber>();
  private readonly removalSubscribers = new Set<RemovalSubscriber>();
  private readonly allSubscribers = new Set<(sessionId: string, events: StoredEvent[]) => void>();
  private readonly listener: CoordinatorListener;
  private evictTimer: NodeJS.Timeout | undefined;
  /** Called when a coordinator fails to persist a batch (it will retry with backoff). */
  onPersistError: ((sessionId: string, err: unknown) => void) | undefined;
  private lastTimeState:
    | { sessionId: string; ts: string; latestSeq: number; state: RunState }
    | undefined;
  /**
   * The stop every coordinator is loaded with. Held here rather than read from the store on each
   * load: it is one value for the whole daemon, and a coordinator is created on the ingest path.
   */
  private explainerCadence: ExplainerCadence = 'turn';

  constructor(store: SalidiumStore, opts: { explainerCadence?: ExplainerCadence } = {}) {
    this.store = store;
    if (opts.explainerCadence) this.explainerCadence = opts.explainerCadence;
    this.listener = {
      onEvents: (sessionId, events, changes) => {
        for (const s of this.allSubscribers) {
          try {
            s(sessionId, events);
          } catch {
            /* ignore */
          }
        }
        const subs = this.eventSubscribers.get(sessionId);
        if (!subs) return;
        for (const s of subs) {
          try {
            s(events, changes);
          } catch {
            /* subscriber errors never affect ingest */
          }
        }
      },
      onSummary: (summary) => {
        for (const s of this.summarySubscribers) {
          try {
            s(summary);
          } catch {
            /* ignore */
          }
        }
      },
    };
    this.evictTimer = setInterval(() => this.evictIdle(), 60_000);
    this.evictTimer.unref?.();
  }

  /** Returns the coordinator for a session, loading it if needed. */
  get(sessionId: string, hint?: { cwd?: string }): SessionCoordinator {
    let c = this.live.get(sessionId);
    if (!c) {
      const parsed = parseSessionId(sessionId);
      const provider = (parsed?.provider ?? 'claude-code') as ProviderId;
      c = SessionCoordinator.load({
        sessionId,
        provider,
        providerSessionId: parsed?.providerSessionId ?? sessionId,
        cwd: hint?.cwd,
        store: this.store,
        listener: this.listener,
        options: { cadence: this.explainerCadence },
      });
      c.onError = (err) => this.onPersistError?.(sessionId, err);
      this.live.set(sessionId, c);
    }
    this.lastTouched.set(sessionId, Date.now());
    return c;
  }

  peek(sessionId: string): SessionCoordinator | undefined {
    return this.live.get(sessionId);
  }

  ingest(
    sessionId: string,
    events: CanonicalEvent[],
    hint?: { cwd?: string; fingerprintOrigin?: 'ingest' | 'backfill' },
  ): number {
    if (events.length === 0) return 0;
    // Retention and explicit Forget keep source cursors, so an old provider file cannot silently
    // recreate a session the user deliberately removed.
    if (this.store.isSessionTombstoned(sessionId)) return 0;
    return this.get(sessionId, hint).ingest(events, hint?.fingerprintOrigin);
  }

  /** Persists one session's accepted events before an external recovery cursor is advanced. */
  flush(sessionId: string): boolean {
    return this.live.get(sessionId)?.flush() ?? true;
  }

  listSessions(): SessionSummary[] {
    const fromStore = this.store.listSessions();
    const byId = new Map(fromStore.map((s) => [s.id, s]));
    for (const [id, c] of this.live) byId.set(id, c.summary);
    // Salidium's own enrichment calls are real agent sessions; they are not the user's work.
    return (
      [...byId.values()]
        // Title as well as the flag: a summary persisted before the first turn arrived has no
        // flag yet, but its title is the marker-prefixed prompt.
        .filter(isUserSession)
        .sort(byRecency)
    );
  }

  /**
   * The sessions matching a query, over the whole store, with the size of the matched set and of
   * the store beside them.
   *
   * The live coordinators are an overlay here rather than an extra source: a row the store returned
   * is replaced by its live summary, but a live session the query did not find is not added. That
   * is a deliberate narrowing. A coordinator upserts its summary inside every flush on a 40 ms
   * timer, and the four searched fields — title, repo, cwd, provider session id — are fixed after
   * the first record, so the only session the store can be missing is one under 40 ms old, which
   * the summary stream pushes to the panel within 100 ms anyway. The alternative, unioning
   * live-only matches in and incrementing `matched`, makes the number a sum of two sources, and
   * then the panel can show a row the number it prints does not count.
   */
  searchSessions(opts: { query?: string; limit?: number } = {}): SessionList {
    const query = opts.query?.trim() ?? '';
    // Lowercased here, not in SQL: this is the same casing rule the browser's matcher applied, and
    // SQLite's lower() is ASCII-only.
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const { sessions, matched, total } = this.store.searchSessions(terms, opts.limit);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    for (const [id, c] of this.live) if (byId.has(id)) byId.set(id, c.summary);
    return {
      sessions: [...byId.values()].filter(isUserSession).sort(byRecency),
      matched,
      total,
      query,
    };
  }

  /** The stop new coordinators are loaded with, and the one every live coordinator now follows. */
  setExplainerCadence(cadence: ExplainerCadence): void {
    this.explainerCadence = cadence;
    for (const c of this.live.values()) c.setCadence(cadence);
  }

  /**
   * What Salidium observed its own explainer consume, or undefined when it observed nothing.
   *
   * Read from the store, which folds per response in SQL. It was summed from the coordinators the
   * daemon happened to be holding, on the reasoning that they had already collapsed their own
   * events — true, but `this.live` starts empty on every start and is evicted after 60 s idle, so
   * the figure was `undefined` on essentially every read and reset on restart. For a number whose
   * whole job is to say what the explainer has cost so far, the only reading that answers the
   * question is the one over everything recorded.
   *
   * The claim that stood here — that `--no-session-persistence` means the explainer writes no
   * transcript to read — is not true. The flag is passed (`explainerBackends.ts`), and Claude Code
   * can write a transcript anyway; some of those sessions also carry usage records.
   *
   * Still undefined rather than a row of zeroes when nothing was observed, so the surface can omit
   * itself instead of printing a confident nothing.
   */
  explainerUsage(): ExplainerUsage | undefined {
    return this.store.usageTotals(true);
  }

  /** The same reading for the user's own sessions, which is the larger of the two by far. */
  ownUsage(): ExplainerUsage | undefined {
    return this.store.usageTotals(false);
  }

  snapshot(sessionId: string, recentChanges = 200): SessionSnapshot | undefined {
    const c =
      this.live.get(sessionId) ??
      (this.store.getSession(sessionId) ? this.get(sessionId) : undefined);
    if (!c) return undefined;
    c.flush();
    return {
      summary: c.summary,
      state: c.state,
      reducerVersion: REDUCER_VERSION,
      seq: c.state.latestSeq,
      changes: this.store.changesBefore(sessionId, c.state.latestSeq, recentChanges),
    };
  }

  /** State as of `seq` (inclusive), replayed from the nearest checkpoint at or before it. */
  stateAt(
    sessionId: string,
    seq: number,
  ): { state: RunState; changes: SemanticChange[] } | undefined {
    const c =
      this.live.get(sessionId) ??
      (this.store.getSession(sessionId) ? this.get(sessionId) : undefined);
    if (!c) return undefined;
    c.flush();
    const cp = this.store.checkpointAtOrBefore(sessionId, REDUCER_VERSION, seq);
    const base = cp
      ? cloneState(cp.state)
      : createInitialState({
          sessionId,
          provider: c.state.provider,
          providerSessionId: c.state.providerSessionId,
          cwd: c.state.cwd,
        });
    const PAGE = 5000;
    let cursor = cp?.seq ?? -1;
    while (cursor < seq) {
      const page = this.store.eventsAfter(sessionId, cursor, seq, PAGE);
      if (page.length === 0) break;
      replayEvents(base, page, seq);
      cursor = page[page.length - 1]?.seq ?? cursor;
      if (page.length < PAGE) break;
    }
    return { state: base, changes: this.store.changesRange(sessionId, -1, seq) };
  }

  /**
   * State as of wall-clock time `ts`: replays every stored event with `event.ts <= ts` in seq
   * order from an empty state. Ingest order can differ from time order across sources (main
   * transcript, subagent transcripts, hooks), so time-based scrubbing cannot use seq checkpoints.
   * Events are compact; even long sessions replay in well under a second.
   */
  stateAtTime(sessionId: string, ts: string): { state: RunState } | undefined {
    const c =
      this.live.get(sessionId) ??
      (this.store.getSession(sessionId) ? this.get(sessionId) : undefined);
    if (!c) return undefined;
    c.flush();
    const memo = this.lastTimeState;
    if (
      memo &&
      memo.sessionId === sessionId &&
      memo.ts === ts &&
      memo.latestSeq === c.state.latestSeq
    ) {
      return { state: memo.state };
    }
    const base = createInitialState({
      sessionId,
      provider: c.state.provider,
      providerSessionId: c.state.providerSessionId,
      cwd: c.state.cwd,
    });
    const PAGE = 5000;
    let cursor = -1;
    for (;;) {
      const page = this.store.eventsAfter(sessionId, cursor, undefined, PAGE);
      if (page.length === 0) break;
      for (const e of page) if (e.ts <= ts) applyEvent(base, e);
      cursor = page[page.length - 1]?.seq ?? cursor;
      if (page.length < PAGE) break;
    }
    this.lastTimeState = { sessionId, ts, latestSeq: c.state.latestSeq, state: base };
    return { state: base };
  }

  eventsAfter(
    sessionId: string,
    afterSeq: number,
    untilSeq?: number,
    limit?: number,
  ): StoredEvent[] {
    const c = this.live.get(sessionId);
    c?.flush();
    return this.store.eventsAfter(sessionId, afterSeq, untilSeq, limit);
  }

  eventById(sessionId: string, eventId: string): StoredEvent | undefined {
    this.live.get(sessionId)?.flush();
    return this.store.eventById(sessionId, eventId);
  }

  rawFingerprint(sessionId: string, eventId: string, path: string, line: number) {
    return this.store.rawFingerprint(sessionId, eventId, path, line);
  }

  changesRange(sessionId: string, afterSeq: number, untilSeq: number): SemanticChange[] {
    this.live.get(sessionId)?.flush();
    return this.store.changesRange(sessionId, afterSeq, untilSeq);
  }

  subscribe(sessionId: string, sub: EventSubscriber): () => void {
    let set = this.eventSubscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.eventSubscribers.set(sessionId, set);
    }
    set.add(sub);
    return () => {
      set?.delete(sub);
      if (set && set.size === 0) this.eventSubscribers.delete(sessionId);
    };
  }

  /** Receives accepted events for every session (used by enrichers). */
  subscribeAll(sub: (sessionId: string, events: StoredEvent[]) => void): () => void {
    this.allSubscribers.add(sub);
    return () => this.allSubscribers.delete(sub);
  }

  subscribeSummaries(sub: SummarySubscriber): () => void {
    this.summarySubscribers.add(sub);
    return () => this.summarySubscribers.delete(sub);
  }

  subscribeRemovals(sub: RemovalSubscriber): () => void {
    this.removalSubscribers.add(sub);
    return () => this.removalSubscribers.delete(sub);
  }

  private notifyRemoved(sessionId: string): void {
    for (const subscriber of this.removalSubscribers) {
      try {
        subscriber(sessionId);
      } catch {
        /* subscriber errors never affect deletion */
      }
    }
  }

  forget(sessionId: string): void {
    const c = this.live.get(sessionId);
    if (c) {
      c.close();
      this.live.delete(sessionId);
    }
    this.lastTouched.delete(sessionId);
    if (this.store.forgetSession(sessionId)) this.notifyRemoved(sessionId);
  }

  /** Applies the configured policy while treating every loaded coordinator as active. */
  applyRetention(now = new Date(), batchSize = 50): RetentionPreview {
    this.flushAll();
    const removed = this.store.applyRetention(this.store.retentionPolicy(), now, batchSize, [
      ...this.live.keys(),
    ]);
    for (const row of removed.sessions) this.notifyRemoved(row.id);
    return removed;
  }

  flushAll(): void {
    for (const c of this.live.values()) c.flush();
  }

  private evictIdle(maxIdleMs = 30 * 60_000): void {
    const now = Date.now();
    for (const [id, c] of this.live) {
      const touched = this.lastTouched.get(id) ?? 0;
      const hasSubscribers = (this.eventSubscribers.get(id)?.size ?? 0) > 0;
      if (!hasSubscribers && now - touched > maxIdleMs && c.state.status !== 'working') {
        c.close();
        this.live.delete(id);
        this.lastTouched.delete(id);
      }
    }
  }

  close(): void {
    if (this.evictTimer) clearInterval(this.evictTimer);
    for (const c of this.live.values()) c.close();
    this.live.clear();
  }
}
