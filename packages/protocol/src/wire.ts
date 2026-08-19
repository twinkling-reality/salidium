import { z } from 'zod';
import { SemanticChangeSchema } from './changes.ts';
import { CanonicalEventSchema, StoredEventSchema } from './events.ts';
import { EpistemicSchema, ProviderIdSchema } from './provenance.ts';
import { CanonicalTimestampSchema } from './timestamps.ts';

/**
 * Daemon ↔ client wire protocol. The client runs the same reducer as the daemon, so the wire
 * carries events (not view models): a snapshot to start from, then a stream of stored events.
 */

export const SessionStatusSchema = z.enum(['working', 'idle', 'waiting', 'ended', 'unknown']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ExplanationStatusSchema = z.enum([
  'generating',
  'generated',
  'disabled',
  'unavailable',
  'failed',
]);
export type ExplanationStatus = z.infer<typeof ExplanationStatusSchema>;

/** Compact row for the session list; derived by the reducer, cached by the daemon. */
export const SessionSummarySchema = z.object({
  id: z.string(),
  provider: ProviderIdSchema,
  providerSessionId: z.string(),
  cwd: z.string(),
  repoRoot: z.string().optional(),
  title: z.string().optional(),
  model: z.string().optional(),
  entrypoint: z.string().optional(),
  /** Salidium's own enrichment session; hidden from the list. */
  internal: z.boolean().optional(),
  /**
   * Runtime outcome of optional explanation enrichment. This lives on the summary rather than in
   * `RunState`: a checkpointed "generating" would come back true after a restart with nothing
   * behind it. Disabled and unavailable are deliberately distinct from a failed agent call.
   */
  explanationStatus: ExplanationStatusSchema.optional(),
  status: SessionStatusSchema,
  startedAt: CanonicalTimestampSchema.optional(),
  lastEventAt: CanonicalTimestampSchema.optional(),
  endedAt: CanonicalTimestampSchema.optional(),
  latestSeq: z.number().int().nonnegative(),
  counts: z.object({
    turns: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    filesChanged: z.number().int().nonnegative(),
    linesAdded: z.number().int().nonnegative(),
    linesRemoved: z.number().int().nonnegative(),
    reviewOpen: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }),
  lastVerification: z
    .object({
      outcome: z.enum(['pass', 'fail', 'partial', 'unknown']),
      at: CanonicalTimestampSchema,
      /** observed = exit code seen; inferred = parsed summary / inferred exit. */
      epistemic: EpistemicSchema,
    })
    .optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/**
 * GET /api/sessions/search?q=&limit= — a window over the session list, and what it is a window of.
 *
 * The list is capped: nobody wants 740 rows in the DOM, and a query has to reach the whole store
 * anyway, so matching happens in the daemon. That makes the cap something the panel has to be able
 * to *say*, which is what the two counts are for. Both are counted over the store, neither is
 * derived from the other, and they answer different questions: `matched` is how many rows the query
 * found, `total` is how many were searched. "500 of 740" and "nothing matches, 740 searched" each
 * need one of them, and neither number may be inferred from the other.
 */
export const SessionListSchema = z.object({
  /** The newest matching sessions, capped; `matched` says how many were left behind. */
  sessions: z.array(SessionSummarySchema),
  matched: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** Echoed back, so a response that arrives late is discarded rather than shown against newer typing. */
  query: z.string(),
});
export type SessionList = z.infer<typeof SessionListSchema>;

export const StoredEventWireSchema = z.intersection(CanonicalEventSchema, StoredEventSchema);

/** GET /api/sessions/:id/snapshot */
export const SessionSnapshotSchema = z.object({
  summary: SessionSummarySchema,
  /** Opaque reducer state (typed in @salidium/core); the client trusts the reducer version. */
  state: z.unknown(),
  reducerVersion: z.string(),
  /** Sequence number the state reflects; stream from here. */
  seq: z.number().int().nonnegative(),
  /** Recent semantic changes for the history rail (full log via /changes). */
  changes: z.array(SemanticChangeSchema),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

/** Server-sent stream messages. */
export const StreamMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: StoredEventWireSchema }),
  z.object({ type: z.literal('changes'), changes: z.array(SemanticChangeSchema) }),
  z.object({ type: z.literal('session'), summary: SessionSummarySchema }),
  z.object({ type: z.literal('sessionRemoved'), id: z.string() }),
  z.object({ type: z.literal('heartbeat'), at: CanonicalTimestampSchema }),
]);
export type StreamMessage = z.infer<typeof StreamMessageSchema>;

/**
 * A session stream refuses to go live when its persisted replay cannot bridge the requested
 * cursor. This JSON response is sent before SSE headers, so a client can replace all local state
 * with a fresh snapshot instead of remaining connected to a permanently stale view.
 */
export const StreamResnapshotRequiredSchema = z.object({
  error: z.literal('resnapshot-required'),
  reason: z.enum(['backlog-exceeded', 'history-gap', 'cursor-ahead']),
  sessionId: z.string(),
  after: z.number().int().min(-1),
  latestSeq: z.number().int().min(-1),
});
export type StreamResnapshotRequired = z.infer<typeof StreamResnapshotRequiredSchema>;

export const DaemonInfoSchema = z.object({
  name: z.literal('salidium'),
  version: z.string(),
  pid: z.number().int(),
  startedAt: CanonicalTimestampSchema,
  home: z.string(),
  providers: z.array(
    z.object({
      id: ProviderIdSchema,
      /** Descriptor-owned label. Optional so an older embedded daemon remains readable. */
      displayName: z.string().min(1).optional(),
      hooksInstalled: z.boolean(),
      sourcesWatched: z.number().int().nonnegative(),
    }),
  ),
});
export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;

/**
 * When Salidium asks a model to explain a session.
 *
 * Three stops rather than a switch, because frequency is the meaningful control: `turn` can run
 * many times within one session while `session` runs once at its end.
 *
 * `session` is not "the provider's session-end record" because providers do not emit one
 * consistently. It means the session has stopped: the end record, or thirty minutes of silence
 * after a turn ended, whichever comes first.
 */
export const ExplainerCadenceSchema = z.enum(['off', 'session', 'turn']);
export type ExplainerCadence = z.infer<typeof ExplainerCadenceSchema>;

/**
 * What Salidium observed its own explainer consume, in tokens.
 *
 * Tokens only, and deliberately: a currency figure is arithmetic over a price table rather than
 * something anyone observed, and on a subscription no dollar is charged at all. Anywhere money is
 * printed it has to be able to say both of those things, and a settings popover cannot.
 *
 * `messages` counts distinct API responses, not transcript records — one response is stamped onto
 * every record it was split across, so counting records can materially overstate the work.
 */
export const ExplainerUsageSchema = z.object({
  messages: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
});
export type ExplainerUsage = z.infer<typeof ExplainerUsageSchema>;

/**
 * GET /api/settings/explainer, and the answer to PUT of the same path.
 *
 * `cadence` is the stored choice, never the effective one. The daemon's environment can hold the
 * explainer off (`SALIDIUM_EXPLAINER=off`, `SALIDIUM_EXPLAIN=0`) and that outranks the stored
 * choice, but overwriting the choice with `off` would lose it — the reader would come back after
 * unsetting the variable to find the stop they picked gone. So the choice travels as itself and
 * `envOff` travels beside it, and the surface says which one is in force.
 *
 * `usage` is absent, never zeroed, when Salidium has observed nothing: an empty section is omitted.
 */
export const ExplainerSettingsSchema = z.object({
  cadence: ExplainerCadenceSchema,
  envOff: z.boolean(),
  usage: ExplainerUsageSchema.optional(),
});
export type ExplainerSettings = z.infer<typeof ExplainerSettingsSchema>;

/** PUT /api/settings/explainer */
export const ExplainerCadenceRequestSchema = z.object({ cadence: ExplainerCadenceSchema });
export type ExplainerCadenceRequest = z.infer<typeof ExplainerCadenceRequestSchema>;
