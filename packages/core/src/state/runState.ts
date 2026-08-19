import type {
  Epistemic,
  ExitStatus,
  FileChangeKind,
  GitOperation,
  Hunk,
  PlanItem,
  ProviderId,
  SessionStatus,
  ToolFailureCause,
  ToolInput,
  ToolKind,
  ToolResult,
} from '@salidium/protocol';

/**
 * Derived semantic state of one agent session. Produced by folding canonical events with the
 * reducer; never persisted as the source of truth (events are), but checkpointed for fast loads.
 *
 * The state is mutated in place by the reducer for speed; consumers treat it as read-only and
 * key re-renders on `revision`.
 */
/** Generated explanation of the session. Never feeds Verified, Left or Review. */
export interface Explanation {
  basedOnSeq: number;
  model: string;
  at: string;
  what: { summary: string; currently: string | null };
  why: { summary: string; lanes: Array<{ title: string; steps: string[] }>; chain: string[] };
  how: { summary: string; root: string | null; steps: string[] };
  approachChange: {
    from: string;
    fromSteps: string[];
    why: string;
    to: string;
    toSteps: string[];
  } | null;
}

export interface RunState {
  reducerVersion: string;
  revision: number;
  latestSeq: number;

  sessionId: string;
  provider: ProviderId;
  /** Newest generated explanation, superseded by each later one. */
  explained?: Explanation;
  /** Salidium's own enrichment call, which must never be shown or explained. */
  internal?: boolean;
  providerSessionId: string;
  cwd: string;
  repoRoot?: string;
  title?: string;
  model?: string;
  entrypoint?: string;
  gitBranch?: string;
  transcriptPath?: string;

  startedAt?: string;
  endedAt?: string;
  lastEventAt?: string;
  status: SessionStatus;
  statusSince?: string;

  turns: Turn[];
  /** Activities by callId; `activityOrder` preserves ingestion order. */
  activities: Record<string, Activity>;
  activityOrder: string[];
  files: Record<string, FileState>;
  verifications: Verification[];
  plan: PlanState;
  claims: Claim[];
  review: ReviewItem[];
  issues: Issue[];
  subagents: Record<string, SubagentState>;
  git: GitState;
  counters: Counters;
  usage: UsageState;
  /** Ids of tool calls started but not completed (per agent lane). */
  running: string[];
  waiting?: WaitingState;
  startLogged?: boolean;
  lastCompactionAt?: string;
}

export interface Turn {
  id: string;
  index: number;
  prompt: string;
  startedAt: string;
  endedAt?: string;
  outcome?: 'completed' | 'interrupted' | 'failed';
  lastMessage?: string;
  /** First non-empty line of the first agent message in this turn (agent-reported). */
  headline?: string;
  activityIds: string[];
  filesTouched: string[];
  verificationIds: string[];
  startSeq: number;
  endSeq?: number;
  error?: string;
  /** True when the end was inferred from the next turn starting rather than an explicit end event. */
  endInferred?: boolean;
}

export type ActivityStatus = 'running' | 'completed' | 'failed' | 'unknown';

export interface Activity {
  callId: string;
  turnId?: string;
  agentId?: string;
  toolName: string;
  kind: ToolKind;
  title: string;
  input: ToolInput;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: ActivityStatus;
  /** Conflicting terminal records were observed for this call; no later duplicate may pick one. */
  sourceConflict?: boolean;
  result?: ToolResult;
  isError: boolean;
  errorExcerpt?: string;
  /** Preserved so a failure that arrived before its call can be interpreted once input arrives. */
  failureCause?: ToolFailureCause;
  exit?: ExitStatus;
  seqCalled: number;
  seqCompleted?: number;
  /** Deterministic rank of the call observation currently projected into this activity. */
  callFidelity?: number;
  /** Deterministic rank of the result/failure observation currently projected here. */
  resultFidelity?: number;
  /** Whether the winning result supplied a duration instead of deriving it from timestamps. */
  resultDurationExplicit?: boolean;
  /** Event ids for drill-through to raw records. */
  eventIds: string[];
}

export interface FileState {
  path: string;
  changeCount: number;
  linesAdded: number;
  linesRemoved: number;
  kinds: FileChangeKind[];
  firstChangedAt: string;
  lastChangedAt: string;
  lastChangeSeq: number;
  lastCallId: string;
  /** Sub-agent that made the last change, if any. */
  lastAgentId?: string;
  /** Turn ids in which the file changed, in order. */
  turnIds: string[];
  /** Latest hunks (bounded) for the raw drill-through; older hunks live in the event log. */
  lastHunks?: Hunk[];
  userModifiedBefore?: boolean;
}

export type VerificationMethod = 'test' | 'typecheck' | 'lint' | 'build' | 'other';
export type VerificationOutcome = 'pass' | 'fail' | 'partial' | 'unknown';

export interface VerificationCounts {
  passed?: number;
  failed?: number;
  skipped?: number;
  total?: number;
}

export interface Verification {
  id: string;
  callId: string;
  turnId?: string;
  at: string;
  seq: number;
  command: string;
  runner?: string;
  method: VerificationMethod;
  outcome: VerificationOutcome;
  counts?: VerificationCounts;
  scope: 'full' | 'partial' | 'unknown';
  exit: ExitStatus;
  /** How the outcome was established: exit code observed, summary parsed, or both. */
  outcomeEpistemic: Epistemic;
  caveats: string[];
  failureExcerpt?: string;
  /** Files changed after this verification ran (so it no longer covers current state). */
  stale: boolean;
}

export interface PlanState {
  items: PlanItem[];
  updatedAt?: string;
  updatedSeq?: number;
  explanation?: string;
}

export type ClaimKind =
  | 'status'
  | 'discovery'
  | 'approach'
  | 'verification'
  | 'remaining'
  | 'question'
  | 'summary'
  | 'other';

export interface Claim {
  /** Event this claim was extracted from; several claims may share one. */
  eventId?: string;
  id: string;
  seq: number;
  ts: string;
  turnId?: string;
  agentId?: string;
  kind: ClaimKind;
  /** Bounded, single line, with the agent's markdown flattened to the text it renders as. */
  text: string;
  /**
   * How sure the classifier is that this is a claim of that kind, 0..1. Below `CLAIM_THRESHOLD`
   * the kind is `other` and nothing may state it under a heading — see `classifyAgentMessage.ts`.
   */
  confidence: number;
  /** Which signal decided the kind. Carried so the drill-through can say why, and tests can too. */
  rule: string;
  phase: 'commentary' | 'final';
  epistemic: 'reported';
}

export type ReviewSeverity = 'info' | 'low' | 'medium' | 'high';

export interface ReviewItem {
  id: string;
  rule: string;
  severity: ReviewSeverity;
  /**
   * What kind of thing this is, with nothing instance-specific in it — "Recursive force delete",
   * "Waiting for your permission". Twenty occurrences of a rule share one label, which is what
   * lets a reader be told the kind once and the count once instead of the kind twenty times.
   */
  label: string;
  /** What distinguishes this occurrence from the others under the same label, when anything does. */
  instance?: string;
  /** `label`, plus `instance` when there is one. The one-line form, for the log and the terminal. */
  summary: string;
  detail?: string;
  refs: string[];
  createdSeq: number;
  createdAt: string;
  resolvedSeq?: number;
  epistemic: Epistemic;
}

export interface Issue {
  id: string;
  kind: 'commandFailed' | 'toolError' | 'patchFailed' | 'turnFailed' | 'interrupted';
  summary: string;
  seq: number;
  ts: string;
  callId?: string;
  resolvedSeq?: number;
}

export interface SubagentState {
  id: string;
  agentType?: string;
  description?: string;
  startedAt: string;
  endedAt?: string;
  lastMessage?: string;
  toolCalls: number;
  /**
   * The record this lane's row is reading from: the report it wrote back, or the record that
   * started it when it never wrote one. Every other statement on the page can be opened; this
   * one could not, which made the section that quotes a subagent verbatim the only place in the
   * app a reader had to take its word for it.
   */
  eventId: string;
}

export interface GitState {
  head?: string;
  branch?: string;
  dirtyCount?: number;
  snapshotAt?: string;
  commits: Array<{ sha: string; at: string; callId?: string; kind?: string }>;
  /** HEAD changes observed without a corresponding commit (checkout, reset, pull). */
  headMoves: Array<{ from?: string; to: string; at: string }>;
  pushes: Array<{ branch?: string; at: string; callId?: string }>;
  operations: Array<{ op: GitOperation; at: string; callId?: string }>;
}

export interface Counters {
  turns: number;
  toolCalls: number;
  toolFailures: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commands: number;
  compactions: number;
  ingestWarnings: number;
  redactions: number;
}

/**
 * What the agent consumed, summed from `agent.usage`. Observed tokens only: a cost in currency is
 * arithmetic over a price table, belongs wherever that table can be named, and is never state.
 *
 * Not folded into `Counters`, which is a flat bag of event tallies that only ever increments.
 * These four have to be revised downwards, because one API response's usage arrives several times
 * — see `agent.usage` — so the running per-lane total it last contributed has to sit beside them.
 */
export interface UsageState {
  /** Distinct API responses seen, not records: the denominator for a per-call figure. */
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * The newest figures each lane contributed, so a repeat replaces them instead of adding.
   * Keyed by lane rather than held as one value because subagent transcripts are separate tailed
   * sources feeding one session, so two lanes' records interleave in sequence order and a single
   * cursor would see the message id flip away and back, and stop replacing. Bounded by lane count.
   *
   * One slot per lane, rather than one per response, is enough only because a response never comes
   * back to a lane it has left: a lane is fed by one transcript file, a response id lives in one
   * file, and within a file a response's records are consecutive. Break any of those and a message id flips
   * away and back within one lane, and the second arrival adds instead of replacing.
   */
  lastByLane: Record<
    string,
    {
      messageId: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  >;
}

export interface WaitingState {
  kind: 'permission' | 'question' | 'input';
  since: string;
  summary: string;
  seq: number;
}
