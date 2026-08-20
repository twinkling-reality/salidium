import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import {
  applyEvent,
  createInitialState,
  createRedactor,
  REDUCER_VERSION,
  type RunState,
  redactEvent,
  summarizeSession,
} from '@salidium/core';
import {
  type CanonicalEvent,
  CanonicalEventSchema,
  CanonicalTimestampSchema,
  EventSourceSchema,
  type ExplainerCadence,
  type ExplanationStatus,
  type ProviderId,
  type SemanticChange,
  type SessionSummary,
  type StoredEvent,
  type ToolInput,
} from '@salidium/protocol';
import { type ExplanationAttempt, explainWithStatus } from '../enrich/explainer.ts';
import { configuredExplainerMode } from '../enrich/explainerBackends.ts';
import type { SalidiumStore } from '../storage/salidiumStore.ts';

export interface CoordinatorListener {
  onEvents(sessionId: string, events: StoredEvent[], changes: SemanticChange[]): void;
  onSummary(summary: SessionSummary): void;
}

export interface CoordinatorOptions {
  /** Flush pending rows to SQLite after this many ms (write-behind). */
  flushDelayMs?: number;
  /** Flush immediately once this many events are pending. */
  flushThreshold?: number;
  /** Checkpoint every N events (in addition to turn ends). */
  checkpointEvery?: number;
  /**
   * Whether the agent may be asked to explain at all. Superseded by `cadence`, which says *when*;
   * kept because `false` has always meant "never" and callers still say it that way.
   */
  explain?: boolean;
  /** When to ask. `off` never, `session` once the session stops, `turn` at every turn end. */
  cadence?: ExplainerCadence;
  /** How long a `session`-stop session must be silent before it counts as over. */
  idleEndMs?: number;
  /** Injected only by tests or a future backend registry. */
  explainSession?: (state: RunState) => Promise<ExplanationAttempt>;
  /**
   * What time it is, for the one derivation that asks: `effectiveStatus` calls a session that has
   * been silent for fifteen minutes idle however open its last turn is. `summarizeSession` already
   * takes `now` as an argument for exactly this reason and every other caller passes one in; this
   * was the last place reading the wall clock directly, which left a seeded fixture unable to say
   * when it is. The screenshot fixture in `scripts/demo-daemon.mjs` pins it so the same seed
   * produces the same pictures; nothing in production passes it.
   */
  now?: () => number;
}

/**
 * How long after a turn ends a session with no end record counts as over.
 *
 * Thirty minutes is long enough to avoid splitting ordinary pauses inside one work block while
 * still allowing a session with no end record to settle. It is also the registry's own
 * idle-eviction window, which sweeps
 * every 60 s, so this timer always fires before the coordinator it belongs to is put away.
 */
export const IDLE_END_MS = 30 * 60_000;

/**
 * The stop actually in force, given the daemon's environment.
 *
 * The environment wins, and only ever downwards. `SALIDIUM_EXPLAINER=off` is the operator's kill
 * switch — set in a launch agent, a test harness, a CI job — and a page in a browser must not be
 * able to switch on something the shell that started the daemon turned off, token or no token.
 * The other way round it says nothing: `auto`, `claude` and `codex` name *which* backend, not how
 * often, so they leave the stored stop alone rather than forcing the explainer on.
 */
export function effectiveCadence(
  stored: ExplainerCadence,
  environment: NodeJS.ProcessEnv = process.env,
): ExplainerCadence {
  return configuredExplainerMode(environment) === 'off' ? 'off' : stored;
}

/**
 * Owns one session's live state. Ingest is: dedupe by event id → assign seq → redact → reduce →
 * notify subscribers immediately → queue for batched persistence → checkpoint periodically.
 * The live path never waits on disk; persistence is a write-behind batch in the same process
 * (node:sqlite is synchronous, but a batched transaction of hundreds of small rows is ~1 ms).
 */
/**
 * Whether the newest explanation still covers everything observed.
 *
 * The explanation is itself an event, so ingesting it moves `latestSeq` one past the sequence it
 * was written from. Comparing the two for equality made every explanation look stale the instant
 * it landed, so every open regenerated one — a `claude -p` call, at the user's expense, each time
 * a session was looked at, and a different explanation on screen each time. The allowance is
 * exactly the explanation's own event; anything the agent did while the call was running leaves a
 * wider gap and correctly counts as new work to explain.
 */
export function explanationIsCurrent(latestSeq: number, basedOnSeq: number | undefined): boolean {
  return basedOnSeq !== undefined && latestSeq - basedOnSeq <= 1;
}

function malformedEventId(sessionId: string, raw: unknown): string {
  // `inspect` is deterministic with sorted keys and handles values JSON cannot (cycles, bigint,
  // undefined). The digest makes a malformed record dedupe across restart/re-ingest without
  // storing its potentially large or sensitive representation in the event id.
  const rendered = inspect(raw, {
    breakLength: Number.POSITIVE_INFINITY,
    compact: true,
    customInspect: false,
    depth: null,
    maxArrayLength: null,
    maxStringLength: null,
    sorted: true,
  });
  const digest = createHash('sha256').update(rendered).digest('hex').slice(0, 32);
  return `${sessionId}#ingest:warning:runtime:${digest}`;
}

export class SessionCoordinator {
  readonly sessionId: string;
  readonly state: RunState;
  private readonly store: SalidiumStore;
  private readonly listener: CoordinatorListener;
  private readonly redactor = createRedactor();
  private readonly seen: Set<string>;
  private readonly commands = new Map<string, string>();
  private nextSeq: number;
  private pendingEvents: StoredEvent[] = [];
  private pendingChanges: SemanticChange[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private summaryTimer: NodeJS.Timeout | undefined;
  private eventsSinceCheckpoint = 0;
  private lastCheckpointSeq: number;
  private readonly opts: Required<CoordinatorOptions>;
  private closed = false;
  private flushFailures = 0;
  private explanationStatus: ExplanationStatus | undefined;
  /** The stop in force for this session; the registry pushes a change to every live coordinator. */
  private cadence: ExplainerCadence;
  private idleEndTimer: NodeJS.Timeout | undefined;
  /** Reports persistence errors (the coordinator itself never throws on the live path). */
  onError: ((err: unknown) => void) | undefined;

  private constructor(
    sessionId: string,
    state: RunState,
    store: SalidiumStore,
    listener: CoordinatorListener,
    seen: Set<string>,
    opts: Required<CoordinatorOptions>,
  ) {
    this.sessionId = sessionId;
    this.state = state;
    this.store = store;
    this.listener = listener;
    this.seen = seen;
    this.opts = opts;
    this.nextSeq = state.latestSeq + 1;
    this.lastCheckpointSeq = state.latestSeq;
    this.eventsSinceCheckpoint = 0;
    // `explain: false` predates the three stops and still means never, so it wins over `cadence`.
    this.cadence = opts.explain === false ? 'off' : opts.cadence;
    if (this.cadence === 'off') this.explanationStatus = 'disabled';
    for (const a of Object.values(state.activities))
      if (a.input.kind === 'command') this.commands.set(a.callId, a.input.command);
  }

  /** Loads a session from the store (checkpoint + tail replay) or creates a fresh one. */
  static load(args: {
    sessionId: string;
    provider: ProviderId;
    providerSessionId: string;
    cwd?: string;
    store: SalidiumStore;
    listener: CoordinatorListener;
    options?: CoordinatorOptions;
  }): SessionCoordinator {
    const { sessionId, provider, providerSessionId, store, listener } = args;
    const envAllows = configuredExplainerMode(process.env) !== 'off';
    const opts: Required<CoordinatorOptions> = {
      flushDelayMs: 40,
      flushThreshold: 250,
      checkpointEvery: 500,
      explain: envAllows,
      // The registry passes the stored stop; a coordinator loaded without one keeps the behaviour
      // that shipped, which is a fresh explanation at every turn end.
      cadence: envAllows ? 'turn' : 'off',
      idleEndMs: IDLE_END_MS,
      explainSession: explainWithStatus,
      now: Date.now,
      ...args.options,
    };
    const cp = store.latestCheckpoint(sessionId, REDUCER_VERSION);
    let state: RunState;
    if (cp) {
      state = cp.state;
      state.revision = 0;
    } else {
      state = createInitialState({ sessionId, provider, providerSessionId, cwd: args.cwd });
    }
    const after = cp?.seq ?? -1;
    const latest = store.latestSeq(sessionId);
    /*
     * The change log is derived, so a change in derivation invalidates it exactly as it invalidates
     * a checkpoint. Bumping REDUCER_VERSION used to re-derive the state and leave the log alone,
     * which meant a rule fixed today reached only sessions recorded after today: every session
     * already in the store kept rendering the entries the old rules produced, in the History rail,
     * at every depth. It is rewritten from the event log on the first load after a bump — which is
     * the same replay that is happening anyway, since no checkpoint at this version can exist.
     */
    const rewriting = cp === undefined && store.changeLogIsStale(sessionId, REDUCER_VERSION);
    const rederived: SemanticChange[] = [];
    if (latest > after) {
      const PAGE = 5000;
      let cursor = after;
      while (cursor < latest) {
        const page = store.eventsAfter(sessionId, cursor, latest, PAGE);
        if (page.length === 0) break;
        for (const e of page) {
          const c = applyEvent(state, e);
          if (rewriting && c.length) rederived.push(...c);
        }
        cursor = page[page.length - 1]?.seq ?? latest;
      }
    }
    if (rewriting) store.replaceChanges(sessionId, rederived, REDUCER_VERSION);
    const seen = new Set(store.eventIds(sessionId));
    const coord = new SessionCoordinator(sessionId, state, store, listener, seen, opts);
    // The constructor cannot infer whether `state` came from a durable checkpoint or a replay.
    // After a migration invalidates caches, a replayed state is current but still needs a new
    // checkpoint; treating its latest event as already checkpointed would force every cold load to
    // replay the entire session until some future event happened to arrive.
    coord.lastCheckpointSeq = cp?.seq ?? -1;
    if (cp === undefined && latest >= 0) coord.checkpoint();
    return coord;
  }

  get summary(): SessionSummary {
    const s = summarizeSession(this.state, this.opts.now());
    s.explanationStatus = this.explanationIsCurrent() ? 'generated' : this.explanationStatus;
    return s;
  }

  /** Ingests events; returns the number accepted (not duplicates). Synchronous and fast. */
  private explainedSeq = -1;

  ingest(events: CanonicalEvent[], fingerprintOrigin: 'ingest' | 'backfill' = 'ingest'): number {
    if (this.closed) return 0;
    const accepted: StoredEvent[] = [];
    const changes: SemanticChange[] = [];
    // Two boundaries, not one. `turnEnded` is the checkpoint boundary and covers both records;
    // `sessionEnded` is the only one the `session` stop fires on directly.
    let turnEnded = false;
    let sessionEnded = false;
    for (const candidate of events as unknown[]) {
      const envelope =
        candidate !== null && typeof candidate === 'object'
          ? (candidate as Record<string, unknown>)
          : undefined;
      // A valid foreign session id is a routing error, not a malformed record for this session.
      if (typeof envelope?.sessionId === 'string' && envelope.sessionId !== this.sessionId)
        continue;
      const parsed = CanonicalEventSchema.safeParse(candidate);
      const eventId = parsed.success ? parsed.data.id : malformedEventId(this.sessionId, candidate);
      const red = parsed.success
        ? redactEvent(parsed.data, this.redactor, {
            commandForCall: (id) => this.commandForCall(id),
            inputForCall: (id) => this.inputForCall(id),
          })
        : undefined;
      // Re-ingestion must be able to strengthen old provenance even when the canonical event id
      // dedupes. Compare the same redacted shape that was stored; a changed raw record must never
      // authenticate older immutable event payload under a newly observed hash.
      if (red) this.store.recordRawFingerprint(red.event, fingerprintOrigin);
      if (this.seen.has(eventId)) continue;
      let stored: StoredEvent;
      let c: SemanticChange[];
      if (!parsed.success) {
        const parsedSource = EventSourceSchema.safeParse(envelope?.source);
        // Validate before calling the mutating reducer. Catching a reducer exception after it had
        // advanced latestSeq left the live/checkpointed state different from replaying the warning
        // event that was actually stored. The warning has its own digest id: reserving the
        // malformed record's declared id would make a later corrected record look like a duplicate.
        stored = {
          id: eventId,
          sessionId: this.sessionId,
          ts:
            typeof envelope?.ts === 'string' &&
            CanonicalTimestampSchema.safeParse(envelope.ts).success
              ? envelope.ts
              : new Date().toISOString(),
          tsSource: 'ingest',
          source: parsedSource.success
            ? parsedSource.data
            : { provider: this.state.provider, channel: 'salidium' },
          kind: 'ingest.warning',
          code: 'malformed-record',
          detail: `invalid ${typeof envelope?.kind === 'string' ? envelope.kind : 'event'}: ${parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || 'event'} ${issue.message}`)
            .join('; ')}`,
          seq: this.nextSeq,
        } as StoredEvent;
        c = applyEvent(this.state, stored);
      } else {
        stored = {
          ...red?.event,
          seq: this.nextSeq,
          ...(red && red.findings > 0 ? { redactions: red.findings } : {}),
        } as StoredEvent;
        c = applyEvent(this.state, stored);
      }
      this.seen.add(stored.id);
      this.nextSeq += 1;
      if (stored.kind === 'tool.called' && stored.input.kind === 'command')
        this.commands.set(stored.callId, stored.input.command);
      accepted.push(stored);
      if (c.length) changes.push(...c);
      if (stored.kind === 'turn.ended' || stored.kind === 'session.ended') turnEnded = true;
      if (stored.kind === 'session.ended') sessionEnded = true;
      if (stored.kind === 'tool.completed' || stored.kind === 'tool.failed')
        this.commands.delete(stored.callId);
    }
    if (accepted.length === 0) return 0;
    this.listener.onEvents(this.sessionId, accepted, changes);
    this.pendingEvents.push(...accepted);
    this.pendingChanges.push(...changes);
    this.eventsSinceCheckpoint += accepted.length;
    if (this.pendingEvents.length >= this.opts.flushThreshold) this.flush();
    else this.scheduleFlush();
    if (turnEnded || this.eventsSinceCheckpoint >= this.opts.checkpointEvery)
      this.scheduleCheckpoint();
    this.scheduleSummary();
    if (turnEnded) this.explainAtBoundary(sessionEnded);
    return accepted.length;
  }

  /**
   * The command a call ran, for the redactor's structural suppression of credential dumps.
   *
   * The map alone was not enough, because a call can complete twice. The map is cleared on the
   * first completion, and a second one arrives routinely: the hook channel and the provider's own
   * record use distinct ids so the store keeps both (`…:result:hook` beside `…:result`), and a
   * Codex command that outlived its call gets a late `…:result:final` when the polls come back.
   * Whichever of them landed second was redacted with no command in hand, so
   * `isCredentialDumpCommand` was asked about nothing, and a `printenv` or `cat .env` was stored
   * whole — then written over the suppressed marker in the reduced state by the upgrade path, and
   * served to the UI. Regex redaction is the backstop and the app already says why it is not
   * enough on its own.
   *
   * The reduced state is the durable answer: the `tool.called` is applied before any result, it
   * keeps its input, and it costs no memory that is not already held.
   */
  private commandForCall(callId: string): string | undefined {
    const remembered = this.commands.get(callId);
    if (remembered !== undefined) return remembered;
    const input = this.state.activities[callId]?.input;
    return input?.kind === 'command' ? input.command : undefined;
  }

  private inputForCall(callId: string): ToolInput | undefined {
    return this.state.activities[callId]?.input;
  }

  /**
   * Explain this session now, whatever the stop says.
   *
   * Nothing on the read path calls this any more. `snapshot()` used to, which made a GET generate
   * an explanation and allowed repeated reads to create work without new session evidence. A read
   * cannot implement a scheduling policy either: with the `session` stop chosen, opening the page would
   * have gone straight past it. This stays as the explicit request path, which is what it always
   * described itself as.
   */
  requestExplanation(): void {
    if (this.explanationIsCurrent()) return;
    this.scheduleExplanation();
  }

  /** Adopts a stop chosen while this session was already live. */
  setCadence(cadence: ExplainerCadence): void {
    if (cadence === this.cadence) return;
    const wasOff = this.cadence === 'off';
    this.cadence = cadence;
    if (cadence === 'off') {
      this.clearIdleEnd();
      this.explanationStatus = 'disabled';
    } else if (wasOff) {
      // `disabled` was this coordinator's answer to the old stop, not an outcome it observed.
      this.explanationStatus = undefined;
    }
    this.scheduleSummary();
  }

  /**
   * A turn, or the session, just ended — the two moments a stop can fire on.
   *
   * `turn` fires at both, which is the behaviour that shipped. `session` fires only when the
   * session is over, and a session is over when its end record arrives or when it has been silent
   * for `idleEndMs`: providers do not consistently emit an end record, so waiting for one alone
   * would leave many sessions unexplained.
   */
  private explainAtBoundary(sessionEnded: boolean): void {
    if (this.cadence === 'off') return;
    if (sessionEnded || this.cadence === 'turn') {
      this.clearIdleEnd();
      this.scheduleExplanation();
      return;
    }
    this.armIdleEnd();
  }

  private armIdleEnd(): void {
    this.clearIdleEnd();
    this.idleEndTimer = setTimeout(() => {
      this.idleEndTimer = undefined;
      if (!this.closed) this.scheduleExplanation();
    }, this.opts.idleEndMs);
    // Unref'd like every other timer here: a session waiting to be declared over must never be the
    // reason the process stays up.
    this.idleEndTimer.unref?.();
  }

  private clearIdleEnd(): void {
    if (!this.idleEndTimer) return;
    clearTimeout(this.idleEndTimer);
    this.idleEndTimer = undefined;
  }

  private explanationIsCurrent(): boolean {
    return explanationIsCurrent(this.state.latestSeq, this.state.explained?.basedOnSeq);
  }

  /**
   * Asks the agent to explain the session. When it is asked is the stop's business; this is what
   * happens once it is. Guarded four ways: never at the `off` stop, never for the explainer's own
   * sessions, never twice for the same sequence, and never concurrently — a slow or failed call is
   * simply skipped, since every observed fact is already on screen without it.
   *
   * Both edges push a summary. The success path would announce itself anyway by ingesting the
   * explanation event, but the failure path ingests nothing, and without a push the client would
   * sit on "generating" for a call that finished minutes ago.
   */
  private scheduleExplanation(): void {
    if (this.cadence === 'off') {
      this.explanationStatus = 'disabled';
      return;
    }
    if (this.state.internal) return;
    if (this.explanationStatus === 'generating') return;
    if (this.explainedSeq === this.state.latestSeq) return;
    if (this.explanationIsCurrent()) return;
    if (this.state.turns.length === 0) return;
    this.explanationStatus = 'generating';
    this.scheduleSummary();
    const seq = this.state.latestSeq;
    void this.opts
      .explainSession(this.state)
      .then((result) => {
        // Marked done either way: a session whose evidence the agent cannot turn into an
        // explanation would otherwise be retried, and paid for, on every open.
        if (result.status === 'generated') this.ingest([result.event]);
        this.explanationStatus = result.status;
        // Read after ingesting, so the explanation's own event counts as covered. Taking the
        // sequence from before the call would leave this guard permanently one behind.
        this.explainedSeq = result.status === 'generated' ? this.state.latestSeq : seq;
      })
      .catch(() => {
        this.explanationStatus = 'failed';
      })
      .finally(() => {
        this.scheduleSummary();
      });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.opts.flushDelayMs);
    this.flushTimer.unref?.();
  }

  private scheduleSummary(): void {
    if (this.summaryTimer) return;
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = undefined;
      this.listener.onSummary(this.summary);
    }, 100);
    this.summaryTimer.unref?.();
  }

  private checkpointPending = false;
  private scheduleCheckpoint(): void {
    if (this.checkpointPending) return;
    this.checkpointPending = true;
    setTimeout(() => {
      this.checkpointPending = false;
      this.checkpoint();
    }, 250).unref?.();
  }

  /**
   * Persists pending events/changes and the session summary in one transaction. On failure the
   * batch is put back and retried later, so a transient store error never loses accepted events.
   */
  flush(): boolean {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.pendingEvents.length === 0 && this.pendingChanges.length === 0) return true;
    const events = this.pendingEvents;
    const changes = this.pendingChanges;
    this.pendingEvents = [];
    this.pendingChanges = [];
    try {
      this.store.transaction(() => {
        this.store.insertEvents(events);
        this.store.insertChanges(changes, REDUCER_VERSION);
        this.store.upsertSession(this.summary);
      });
      this.flushFailures = 0;
      return true;
    } catch (err) {
      this.pendingEvents = [...events, ...this.pendingEvents];
      this.pendingChanges = [...changes, ...this.pendingChanges];
      this.flushFailures += 1;
      this.onError?.(err);
      const backoff = Math.min(
        30_000,
        this.opts.flushDelayMs * 2 ** Math.min(this.flushFailures, 8),
      );
      this.flushTimer = setTimeout(() => this.flush(), backoff);
      this.flushTimer.unref?.();
      return false;
    }
  }

  checkpoint(): void {
    // A checkpoint may never get ahead of the event log it summarizes. If the flush failed, its
    // retry owns persistence and a later scheduled/close checkpoint can capture the state.
    if (!this.flush()) return;
    if (this.state.latestSeq <= this.lastCheckpointSeq) return;
    this.store.saveCheckpoint(this.sessionId, this.state.latestSeq, REDUCER_VERSION, this.state);
    this.lastCheckpointSeq = this.state.latestSeq;
    this.eventsSinceCheckpoint = 0;
  }

  close(): void {
    this.closed = true;
    this.clearIdleEnd();
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    this.checkpoint();
    this.listener.onSummary(this.summary);
  }
}
