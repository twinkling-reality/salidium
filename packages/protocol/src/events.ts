import { z } from 'zod';
import { EventSourceSchema, ExitStatusSchema } from './provenance.ts';
import { CanonicalTimestampSchema } from './timestamps.ts';

/**
 * Canonical event vocabulary. Every provider adapter normalizes its records into these events;
 * the core reducer folds them into semantic state. Events are append-only and idempotent: an
 * event's `id` is deterministic per provider record, so re-ingesting a transcript, receiving a
 * hook payload twice, or seeing the same tool call via both hook and transcript is harmless.
 *
 * Design rules:
 * - Payloads carry small extracted fields, not raw provider records. Large text is excerpted and
 *   flagged `truncated`; the raw record stays in the provider's file, reachable via `source.ref`.
 * - Nothing here is a judgement. Judgements (verified, needs review, remaining) are derived.
 */

// ---------------------------------------------------------------------------------------------
// Tool kinds and inputs

/** ACP-shaped superset of tool kinds; provider tool names map onto these. */
export const ToolKindSchema = z.enum([
  'command',
  'fileEdit',
  'fileWrite',
  'fileRead',
  'search',
  'webFetch',
  'webSearch',
  'subagent',
  'plan',
  'question',
  'mcp',
  'other',
]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const CommandInputSchema = z.object({
  kind: z.literal('command'),
  command: z.string(),
  description: z.string().optional(),
  cwd: z.string().optional(),
  background: z.boolean().optional(),
});

export const FileInputSchema = z.object({
  kind: z.enum(['fileEdit', 'fileWrite', 'fileRead']),
  path: z.string(),
});

export const SearchInputSchema = z.object({
  kind: z.literal('search'),
  query: z.string(),
  path: z.string().optional(),
});

export const WebInputSchema = z.object({
  kind: z.enum(['webFetch', 'webSearch']),
  target: z.string(),
});

export const SubagentInputSchema = z.object({
  kind: z.literal('subagent'),
  description: z.string().optional(),
  agentType: z.string().optional(),
  background: z.boolean().optional(),
});

export const PlanInputSchema = z.object({ kind: z.literal('plan') });

export const QuestionInputSchema = z.object({
  kind: z.literal('question'),
  questions: z.array(z.string()),
});

export const McpInputSchema = z.object({
  kind: z.literal('mcp'),
  server: z.string(),
  tool: z.string(),
  /** Bounded path-bearing arguments captured before argsExcerpt is truncated. */
  pathArgs: z.array(z.string().max(1000)).max(32).optional(),
  /** More path arguments existed than the bounded metadata could retain. */
  pathArgsTruncated: z.boolean().optional(),
  argsExcerpt: z.string().optional(),
});

export const OtherInputSchema = z.object({
  kind: z.literal('other'),
  summary: z.string().optional(),
});

export const ToolInputSchema = z.discriminatedUnion('kind', [
  CommandInputSchema,
  FileInputSchema,
  SearchInputSchema,
  WebInputSchema,
  SubagentInputSchema,
  PlanInputSchema,
  QuestionInputSchema,
  McpInputSchema,
  OtherInputSchema,
]);
export type ToolInput = z.infer<typeof ToolInputSchema>;

// ---------------------------------------------------------------------------------------------
// Tool results (evidence)

/** A unified-diff hunk, in the shape both jsdiff (Claude Code) and git produce. */
export const HunkSchema = z.object({
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  /** Lines prefixed with ' ', '+', '-' (jsdiff structuredPatch style). */
  lines: z.array(z.string()),
});
export type Hunk = z.infer<typeof HunkSchema>;

export const FileChangeKindSchema = z.enum(['add', 'update', 'delete', 'move']);
export type FileChangeKind = z.infer<typeof FileChangeKindSchema>;

export const FileChangeSchema = z.object({
  path: z.string(),
  change: FileChangeKindSchema,
  movedFrom: z.string().optional(),
  hunks: z.array(HunkSchema).optional(),
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
  /** False when the provider reports the patch was not applied (declined/failed). */
  applied: z.boolean(),
  /** The user edited the file between the agent's read and its write (Claude Code `userModified`). */
  userModifiedBefore: z.boolean().optional(),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

/** Structured git activity reported by the runtime alongside a command (Claude Code `gitOperation`). */
export const GitOperationSchema = z.object({
  commit: z.object({ sha: z.string(), kind: z.string().optional() }).optional(),
  push: z.object({ branch: z.string().optional() }).optional(),
  branch: z.object({ ref: z.string().optional(), action: z.string().optional() }).optional(),
  pr: z
    .object({
      number: z.number().int().optional(),
      url: z.string().optional(),
      action: z.string().optional(),
    })
    .optional(),
});
export type GitOperation = z.infer<typeof GitOperationSchema>;

export const CommandResultSchema = z.object({
  kind: z.literal('command'),
  exit: ExitStatusSchema,
  /** Head/tail excerpt of merged output, already redacted. */
  outputExcerpt: z.string(),
  outputChars: z.number().int().nonnegative(),
  truncated: z.boolean(),
  interrupted: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  gitOperation: GitOperationSchema.optional(),
});

export const FileChangesResultSchema = z.object({
  kind: z.literal('fileChanges'),
  changes: z.array(FileChangeSchema),
});

export const FileReadResultSchema = z.object({
  kind: z.literal('fileRead'),
  path: z.string(),
  /** Suppressed when the path is a known sensitive file (.env, keys, credentials). */
  suppressed: z.boolean().optional(),
});

export const SubagentResultSchema = z.object({
  kind: z.literal('subagent'),
  agentId: z.string().optional(),
  status: z.enum(['completed', 'launched', 'failed', 'unknown']),
  summaryExcerpt: z.string().optional(),
  toolCalls: z.number().int().optional(),
  durationMs: z.number().int().optional(),
});

export const GenericResultSchema = z.object({
  kind: z.literal('generic'),
  excerpt: z.string().optional(),
});

export const ToolResultSchema = z.discriminatedUnion('kind', [
  CommandResultSchema,
  FileChangesResultSchema,
  FileReadResultSchema,
  SubagentResultSchema,
  GenericResultSchema,
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

// ---------------------------------------------------------------------------------------------
// Plans / tasks

export const PlanItemStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
export type PlanItemStatus = z.infer<typeof PlanItemStatusSchema>;

export const PlanItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: PlanItemStatusSchema,
  activeForm: z.string().optional(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

// ---------------------------------------------------------------------------------------------
// Event envelope and payloads

const Base = z.object({
  /** Deterministic, unique within the session. */
  id: z.string(),
  sessionId: z.string(),
  ts: CanonicalTimestampSchema,
  tsSource: z.enum(['provider', 'ingest']),
  /** Sub-agent lane; absent for the main agent. */
  agentId: z.string().optional(),
  /** Provider turn identifier (Claude Code prompt_id, Codex turn_id) when known. */
  turnId: z.string().optional(),
  source: EventSourceSchema,
  /** Number of credential-shaped spans redacted from this event at ingest (stamped by the daemon). */
  redactions: z.number().int().nonnegative().optional(),
});

export const SessionStartedEventSchema = Base.extend({
  kind: z.literal('session.started'),
  cwd: z.string(),
  model: z.string().optional(),
  entrypoint: z.string().optional(),
  gitBranch: z.string().optional(),
  /** startup | resume | clear | compact | fork (provider vocabulary, passed through). */
  reason: z.string().optional(),
  title: z.string().optional(),
  transcriptPath: z.string().optional(),
});

/** Partial metadata update learned after the session started (model seen, title set, branch changed). */
export const SessionUpdatedEventSchema = Base.extend({
  kind: z.literal('session.updated'),
  model: z.string().optional(),
  title: z.string().optional(),
  gitBranch: z.string().optional(),
  cwd: z.string().optional(),
});

export const SessionEndedEventSchema = Base.extend({
  kind: z.literal('session.ended'),
  reason: z.string().optional(),
});

export const TurnStartedEventSchema = Base.extend({
  kind: z.literal('turn.started'),
  prompt: z.string(),
  promptTruncated: z.boolean().optional(),
});

export const TurnEndedEventSchema = Base.extend({
  kind: z.literal('turn.ended'),
  lastMessage: z.string().optional(),
  outcome: z.enum(['completed', 'interrupted', 'failed']),
  error: z.string().optional(),
});

export const AgentMessageEventSchema = Base.extend({
  kind: z.literal('agent.message'),
  text: z.string(),
  truncated: z.boolean().optional(),
  /** Codex distinguishes commentary from the final answer; Claude Code text blocks are 'commentary'
   *  until the turn ends, when the last message is also delivered via turn.ended. */
  phase: z.enum(['commentary', 'final']).optional(),
  messageId: z.string().optional(),
});

export const AgentThinkingEventSchema = Base.extend({
  kind: z.literal('agent.thinking'),
  /** Length only. Thinking text is internal reasoning; Salidium neither stores nor shows it. */
  chars: z.number().int().nonnegative(),
});

/**
 * What one API response consumed. Tokens are observed and may be printed as fact; money is not.
 * A currency figure is Salidium's own arithmetic over a price table, and on a subscription no
 * dollar is charged, so no rate and no total belongs on this event.
 *
 * `messageId` is the unit of accounting, and the reason this is an event rather than a field on
 * the envelope. Claude Code writes one transcript record per content block and stamps the whole
 * response's usage onto every one of them. A consumer must therefore replace the running total for
 * a message id rather than add to it; within a response the figures grow and the last record is the
 * complete snapshot.
 *
 * The envelope is wrong for a second, independent reason: some assistant records produce no other
 * canonical event while others produce more than one, so usage riding on another event would be
 * lost or duplicated.
 */
export const AgentUsageEventSchema = Base.extend({
  kind: z.literal('agent.usage'),
  /** The provider's id for the API response this usage describes. Repeats across its records. */
  messageId: z.string(),
  model: z.string().max(120).optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
});

export const ToolCalledEventSchema = Base.extend({
  kind: z.literal('tool.called'),
  callId: z.string(),
  toolName: z.string(),
  input: ToolInputSchema,
  /** Human-readable one-liner derived deterministically from input (e.g. "Edit src/auth.ts"). */
  title: z.string(),
});

export const ToolCompletedEventSchema = Base.extend({
  kind: z.literal('tool.completed'),
  callId: z.string(),
  toolName: z.string(),
  result: ToolResultSchema,
  isError: z.boolean(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const ToolFailureCauseSchema = z.enum([
  'error',
  'rejected',
  'denied',
  'interrupted',
  'timeout',
]);
export type ToolFailureCause = z.infer<typeof ToolFailureCauseSchema>;

export const ToolFailedEventSchema = Base.extend({
  kind: z.literal('tool.failed'),
  callId: z.string(),
  toolName: z.string(),
  errorExcerpt: z.string(),
  /** error = the tool itself failed; rejected/denied = a human or policy stopped it (not an agent failure). */
  cause: ToolFailureCauseSchema,
  exit: ExitStatusSchema.optional(),
  interrupted: z.boolean().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const SubagentStartedEventSchema = Base.extend({
  kind: z.literal('subagent.started'),
  subagentId: z.string(),
  agentType: z.string().optional(),
  description: z.string().optional(),
  transcriptPath: z.string().optional(),
  parentCallId: z.string().optional(),
});

export const SubagentEndedEventSchema = Base.extend({
  kind: z.literal('subagent.ended'),
  subagentId: z.string(),
  lastMessage: z.string().optional(),
});

export const PlanUpdatedEventSchema = Base.extend({
  kind: z.literal('plan.updated'),
  /** replace: the list is the full plan (TodoWrite, Codex update_plan). merge: upsert by id (TaskCreate/TaskUpdate). */
  mode: z.enum(['replace', 'merge']),
  items: z.array(PlanItemSchema),
  /** Agent-provided rationale for the plan change (Codex `explanation`). */
  explanation: z.string().optional(),
});

export const CompactionEventSchema = Base.extend({
  kind: z.literal('compaction'),
  trigger: z.string().optional(),
  summaryExcerpt: z.string().optional(),
});

export const PermissionRequestedEventSchema = Base.extend({
  kind: z.literal('permission.requested'),
  toolName: z.string(),
  summary: z.string(),
});

export const NotificationEventSchema = Base.extend({
  kind: z.literal('notification'),
  notificationType: z.string().optional(),
  message: z.string(),
});

/** Salidium's own read-only observation of the repository (enricher output). */
export const GitSnapshotEventSchema = Base.extend({
  kind: z.literal('git.snapshot'),
  repoRoot: z.string(),
  head: z.string().optional(),
  branch: z.string().optional(),
  /** Porcelain v2 status codes for dirty paths (bounded list). */
  dirty: z.array(z.object({ path: z.string(), status: z.string() })),
  dirtyTruncated: z.boolean().optional(),
});

/** Ingest problems are events too, so the UI can say "3 records could not be parsed" honestly. */
export const IngestWarningEventSchema = Base.extend({
  kind: z.literal('ingest.warning'),
  code: z.enum(['malformed-record', 'unsupported-record', 'truncated-record', 'source-gap']),
  detail: z.string().optional(),
});

/**
 * A model-written explanation of the session, produced by asking the user's own agent to read the
 * evidence Salidium already holds. This is the only content in the system with `explained`
 * provenance: it is generated, not observed, so it may never contribute to Verified, Left or
 * Review, and the UI must mark it as generated wherever it appears.
 *
 * It is an event so it stays in the append-only log: replayable, scrubbable, and superseded by
 * the next one rather than mutated in place.
 *
 * Every `max()` on a step list is a layout budget, not a taste. `FlowDiagram` gives each step one
 * column of the page, so at --page-w 1000px and --space-6 gaps a node is 181px wide at five and
 * 147px at six; app.css already records that a five-node run in a ~650px column was five columns
 * of one word each, which is what the 860px container breakpoint exists to catch.
 *
 * The model is asked for five steps. The schema leaves one item of tolerance because prompts guide
 * output better than `maxItems`, while rejecting a small overshoot would cost a full retry.
 *
 * `approachChange` allows four steps because `BeforeAfter` can lay out two runs of four without
 * losing legibility. Every `min()` stays: an empty `chain` or `steps` makes the UI omit that whole
 * section, so `.min(1)` turns a silent disappearance into a retry.
 * `.min(2)` on the two approach paths is what makes them paths rather than a pair of boxes.
 */
export const ExplanationEventSchema = Base.extend({
  kind: z.literal('salidium.explanation'),
  /** Sequence of the newest event the explanation was written from. */
  basedOnSeq: z.number().int().nonnegative(),
  model: z.string().max(120),
  what: z.object({
    summary: z.string().max(600),
    currently: z.string().max(600).nullable(),
  }),
  /**
   * `lanes` carry shape, not just sequence: concurrent actors whose paths converge into `chain`.
   * Empty lanes mean the cause is linear and `chain` is the whole of it. This is what lets a race
   * condition be drawn as a race rather than described as a list.
   */
  why: z.object({
    summary: z.string().max(600),
    lanes: z
      .array(
        z.object({
          title: z.string().max(100),
          steps: z.array(z.string().max(200)).min(1).max(4),
        }),
      )
      .max(3)
      .default([]),
    chain: z.array(z.string().max(200)).min(1).max(6),
  }),
  how: z.object({
    summary: z.string().max(600),
    /** The component the change centres on; steps hang beneath it. */
    root: z.string().max(200).nullable().default(null),
    steps: z.array(z.string().max(200)).min(1).max(6),
  }),
  approachChange: z
    .object({
      from: z.string().max(200),
      fromSteps: z.array(z.string().max(200)).min(2).max(4),
      why: z.string().max(600),
      to: z.string().max(200),
      toSteps: z.array(z.string().max(200)).min(2).max(4),
    })
    .nullable(),
});

export const CanonicalEventSchema = z.discriminatedUnion('kind', [
  SessionStartedEventSchema,
  SessionUpdatedEventSchema,
  SessionEndedEventSchema,
  TurnStartedEventSchema,
  TurnEndedEventSchema,
  AgentMessageEventSchema,
  AgentThinkingEventSchema,
  AgentUsageEventSchema,
  ToolCalledEventSchema,
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
  SubagentStartedEventSchema,
  SubagentEndedEventSchema,
  PlanUpdatedEventSchema,
  CompactionEventSchema,
  PermissionRequestedEventSchema,
  NotificationEventSchema,
  GitSnapshotEventSchema,
  IngestWarningEventSchema,
  ExplanationEventSchema,
]);
export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>;
export type CanonicalEventKind = CanonicalEvent['kind'];
export type CanonicalEventOf<K extends CanonicalEventKind> = Extract<CanonicalEvent, { kind: K }>;

/** An event once accepted by the store: it has a monotonic sequence number within its session. */
export const StoredEventSchema = z.object({ seq: z.number().int().nonnegative() });
type WithSeq<E> = E & { seq: number };
/** Distributed over the union so `Extract<StoredEvent, { kind: K }>` keeps working. */
export type StoredEvent = {
  [K in CanonicalEventKind]: WithSeq<CanonicalEventOf<K>>;
}[CanonicalEventKind];
export type StoredEventOf<K extends CanonicalEventKind> = Extract<StoredEvent, { kind: K }>;
