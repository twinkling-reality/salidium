import type {
  FileChange,
  PlanItem,
  SemanticChange,
  StoredEvent,
  StoredEventOf,
} from '@salidium/protocol';
import { extractClaims, headlineOf } from '../claims/classifyAgentMessage.ts';
import { plainText } from '../claims/markdown.ts';
import { detectGitCommand } from '../verification/classifyCommand.ts';
import { deriveVerification } from '../verification/deriveVerification.ts';
import { basename, ChangeLog, clip, shortSha } from './changeLog.ts';
import { deriveStatus } from './deriveStatus.ts';
import { applyReviewRulesAfterEvent } from './reviewRules.ts';
import type { Activity, Claim, FileState, RunState, Turn, Verification } from './runState.ts';

/**
 * Folds one stored event into the run state, mutating it in place, and returns the semantic
 * changes the event caused. Deterministic: same events in the same order → same state and
 * same changes. No wall clock, no I/O.
 */
export function applyEvent(state: RunState, event: StoredEvent): SemanticChange[] {
  if (event.seq <= state.latestSeq) return []; // already applied (idempotent replay)
  const log = new ChangeLog(state.sessionId, event);
  state.latestSeq = event.seq;
  state.revision += 1;
  state.lastEventAt = maxTs(state.lastEventAt, event.ts);
  if (event.redactions) state.counters.redactions += event.redactions;

  switch (event.kind) {
    case 'session.started':
      onSessionStarted(state, event, log);
      break;
    case 'session.updated':
      if (event.model) state.model = event.model;
      if (event.title) state.title = event.title;
      if (event.gitBranch) state.gitBranch = event.gitBranch;
      if (event.cwd) state.cwd = event.cwd;
      break;
    case 'session.ended':
      state.endedAt = event.ts;
      log.add('status', 'Session ended', 'observed');
      break;
    case 'turn.started':
      onTurnStarted(state, event, log);
      break;
    case 'turn.ended':
      onTurnEnded(state, event, log);
      break;
    case 'agent.message':
      onAgentMessage(state, event, log);
      break;
    case 'agent.thinking':
      break;
    case 'agent.usage':
      onAgentUsage(state, event);
      break;
    case 'tool.called':
      onToolCalled(state, event, log);
      break;
    case 'tool.completed':
      onToolCompleted(state, event, log);
      break;
    case 'tool.failed':
      onToolFailed(state, event, log);
      break;
    case 'subagent.started':
      state.subagents[event.subagentId] = {
        id: event.subagentId,
        agentType: event.agentType,
        description: event.description,
        startedAt: event.ts,
        toolCalls: 0,
        eventId: event.id,
      };
      log.add(
        'how',
        `Delegated to ${event.agentType ?? 'subagent'}: ${event.description ?? event.subagentId}`,
        'observed',
      );
      break;
    case 'subagent.ended': {
      const s = state.subagents[event.subagentId];
      if (s) {
        s.endedAt = event.ts;
        // Flattened for the same reason a claim is: a subagent writes markdown, and the section
        // that shows what it came back with is the one place a reader meets that text. The exact
        // words, markers and all, stay one `record` away.
        s.lastMessage = event.lastMessage ? clip(plainText(event.lastMessage), 600) : undefined;
        // The row now reads from this record, so this is the one `record` should open.
        if (s.lastMessage) s.eventId = event.id;
      }
      log.add('how', `Subagent finished: ${s?.description ?? event.subagentId}`, 'observed');
      break;
    }
    case 'plan.updated':
      onPlanUpdated(state, event, log);
      break;
    case 'compaction': {
      const last = state.lastCompactionAt ? Date.parse(state.lastCompactionAt) : Number.NaN;
      const now = Date.parse(event.ts);
      // Hook and transcript both report compaction; treat reports within 60s as one.
      if (!Number.isNaN(last) && !Number.isNaN(now) && Math.abs(now - last) < 60_000) break;
      state.lastCompactionAt = event.ts;
      state.counters.compactions += 1;
      log.add('status', 'Context compacted', 'observed');
      break;
    }
    case 'permission.requested':
      state.waiting = {
        kind: 'permission',
        since: event.ts,
        summary: event.summary,
        seq: event.seq,
      };
      // The review rules emit the review-facet history entry once.
      break;
    case 'notification':
      if (
        event.notificationType === 'idle_prompt' ||
        event.notificationType === 'agent_needs_input'
      ) {
        state.waiting = { kind: 'input', since: event.ts, summary: event.message, seq: event.seq };
      }
      break;
    case 'git.snapshot':
      onGitSnapshot(state, event, log);
      break;
    case 'ingest.warning':
      state.counters.ingestWarnings += 1;
      break;
    case 'salidium.explanation':
      // Generated content supersedes the previous generation and nothing else; it is filed under
      // its own facet so it can never be mistaken for an observation.
      state.explained = {
        basedOnSeq: event.basedOnSeq,
        model: event.model,
        at: event.ts,
        what: event.what,
        why: { ...event.why, lanes: event.why.lanes ?? [] },
        how: { ...event.how, root: event.how.root ?? null },
        approachChange: event.approachChange
          ? {
              ...event.approachChange,
              fromSteps: event.approachChange.fromSteps ?? [],
              toSteps: event.approachChange.toSteps ?? [],
            }
          : null,
      };
      log.add('what', event.what.summary, 'explained', { model: event.model });
      break;
  }

  applyReviewRulesAfterEvent(state, event, log);
  const prevStatus = state.status;
  state.status = deriveStatus(state);
  if (state.status !== prevStatus) state.statusSince = event.ts;
  return log.changes;
}

// ---------------------------------------------------------------------------------------------

/**
 * Salidium's enrichment call is a real agent session and lands in the transcript like any other.
 * It runs in its own directory precisely so it can be recognised here, on the first event, before
 * any summary reaches a client.
 */
const EXPLAINER_CWD = /\.salidium[/\\]explainer$/;

function onSessionStarted(state: RunState, e: StoredEventOf<'session.started'>, log: ChangeLog) {
  if (EXPLAINER_CWD.test(e.cwd)) state.internal = true;
  const resumed = e.reason === 'resume';
  if (!state.startedAt || !resumed) state.startedAt = state.startedAt ?? e.ts;
  if (e.cwd) state.cwd = e.cwd;
  if (e.model) state.model = e.model;
  if (e.entrypoint) state.entrypoint = e.entrypoint;
  if (e.gitBranch) state.gitBranch = e.gitBranch;
  if (e.title) state.title = e.title;
  if (e.transcriptPath) state.transcriptPath = e.transcriptPath;
  if (e.reason === 'compact' || e.reason === 'clear') return;
  const where = basename(state.cwd || '') || state.cwd;
  if (resumed) {
    log.add('status', `Session resumed in ${where}`, 'observed', {
      model: state.model,
      reason: e.reason,
    });
  } else if (!state.startLogged) {
    state.startLogged = true;
    log.add('status', `Session started in ${where}`, 'observed', {
      model: state.model,
      reason: e.reason,
    });
  }
}

function currentTurn(state: RunState): Turn | undefined {
  const t = state.turns[state.turns.length - 1];
  return t && !t.endedAt ? t : undefined;
}

function turnFor(state: RunState, event: StoredEvent): Turn | undefined {
  if (event.turnId) {
    const found = state.turns.find((t) => t.id === event.turnId);
    if (found) return found;
    // Event references a turn we have not seen a start for yet (channel ordering); create it.
    return openTurn(state, event.turnId, '', event.ts, event.seq);
  }
  // No turn id (e.g. subagent transcripts, which may be ingested after the main one): attribute
  // by time, so ingest order across sources cannot misfile work into the wrong turn.
  const byTime = state.turns.find(
    (t) => t.startedAt <= event.ts && (!t.endedAt || event.ts <= t.endedAt),
  );
  return byTime ?? currentTurn(state) ?? state.turns[state.turns.length - 1];
}

function openTurn(state: RunState, id: string, prompt: string, ts: string, seq: number): Turn {
  const open = currentTurn(state);
  if (open && open.id !== id && open.activityIds.length === 0 && open.prompt === '') {
    // Placeholder from an out-of-order event; adopt it.
    open.id = id;
    open.prompt = prompt;
    return open;
  }
  if (open && open.id !== id) closeTurn(open, ts, seq, 'interrupted', true);
  const turn: Turn = {
    id,
    index: state.turns.length,
    prompt,
    startedAt: ts,
    activityIds: [],
    filesTouched: [],
    verificationIds: [],
    startSeq: seq,
  };
  state.turns.push(turn);
  state.counters.turns = state.turns.length;
  return turn;
}

function closeTurn(
  turn: Turn,
  ts: string,
  seq: number,
  outcome: Turn['outcome'],
  inferred = false,
) {
  if (turn.endedAt) return;
  turn.endedAt = ts;
  turn.endSeq = seq;
  turn.outcome = outcome;
  turn.endInferred = inferred;
}

function onTurnStarted(state: RunState, e: StoredEventOf<'turn.started'>, log: ChangeLog) {
  // Backstop for explainer transcripts written before it moved to its own directory.
  if (e.prompt?.includes('[salidium-explainer]')) state.internal = true;
  const id = e.turnId ?? `turn-${state.turns.length + 1}`;
  const existing = state.turns.find((t) => t.id === id);
  if (existing) {
    if (existing.prompt) return;
    // An end/tool event can be ingested before the transcript record that starts its turn. Fill
    // that placeholder without reopening a turn which has already ended, and emit the same ask
    // history a normally ordered start would have produced.
    existing.prompt = e.prompt;
    existing.startedAt = e.ts;
    existing.startSeq = e.seq;
    state.waiting = undefined;
    const head = headlineOf(e.prompt, 140);
    log.add('why', head ? `Asked: ${head}` : 'New request', 'reported', {
      author: 'user',
      turn: existing.index,
    });
    return;
  }
  const turn = openTurn(state, id, e.prompt, e.ts, e.seq);
  state.waiting = undefined;
  const head = headlineOf(e.prompt, 140);
  log.add('why', head ? `Asked: ${head}` : 'New request', 'reported', {
    author: 'user',
    turn: turn.index,
  });
}

function onTurnEnded(state: RunState, e: StoredEventOf<'turn.ended'>, log: ChangeLog) {
  let turn = e.turnId ? state.turns.find((t) => t.id === e.turnId) : currentTurn(state);
  if (!turn && e.turnId) {
    // Keep an explicit end as a closed placeholder until its earlier start record arrives. Dropping
    // it made spool-before-backfill ordering leave completed sessions "working" forever.
    turn = openTurn(state, e.turnId, '', e.ts, e.seq);
  }
  if (!turn) return;
  if (turn.endedAt && !turn.endInferred) {
    // Already ended (e.g. hook Stop or an earlier end_turn record); merge the final text if new.
    if (e.lastMessage && !turn.lastMessage) {
      turn.lastMessage = e.lastMessage;
      recordClaim(state, e, e.lastMessage, 'final', log, turn);
    }
    return;
  }
  turn.endInferred = false;
  turn.endedAt = e.ts;
  turn.endSeq = e.seq;
  turn.outcome = e.outcome;
  turn.lastMessage = e.lastMessage;
  turn.error = e.error;
  state.waiting = undefined;
  // Tools still marked running at turn end are unknown (interrupted or lost result).
  for (const id of state.running) {
    const a = state.activities[id];
    if (a && a.turnId === turn.id) {
      a.status = 'unknown';
      a.endedAt = e.ts;
    }
  }
  state.running = state.running.filter((id) => state.activities[id]?.turnId !== turn.id);

  if (e.outcome === 'failed') {
    state.issues.push({
      id: `turn-failed:${turn.id}`,
      kind: 'turnFailed',
      summary: e.error ?? 'Turn failed',
      seq: e.seq,
      ts: e.ts,
    });
    log.add('status', `Turn failed: ${clip(e.error ?? 'error', 120)}`, 'observed');
    return;
  }
  if (e.outcome === 'interrupted') {
    state.issues.push({
      id: `interrupted:${turn.id}`,
      kind: 'interrupted',
      summary: 'Turn interrupted',
      seq: e.seq,
      ts: e.ts,
    });
    log.add('status', 'Turn interrupted', 'observed');
    return;
  }
  const head = e.lastMessage ? headlineOf(e.lastMessage, 140) : '';
  log.add(
    'status',
    head ? `Turn complete: ${head}` : 'Turn complete',
    head ? 'reported' : 'observed',
    { turn: turn.index },
  );
  if (e.lastMessage) recordClaim(state, e, e.lastMessage, 'final', log, turn);
}

function onAgentMessage(state: RunState, e: StoredEventOf<'agent.message'>, log: ChangeLog) {
  const text = e.text.trim();
  if (!text) return;
  const turn = turnFor(state, e);
  const phase = e.phase ?? 'commentary';
  if (turn && !turn.headline && !e.agentId) turn.headline = headlineOf(text, 140);
  recordClaim(state, e, text, phase, log, turn);
}

function recordClaim(
  state: RunState,
  e: StoredEvent,
  text: string,
  phase: 'commentary' | 'final',
  log: ChangeLog,
  turn: Turn | undefined,
) {
  const extracted = extractClaims(text, phase);
  const isFirstOfTurn =
    turn !== undefined &&
    state.claims.filter((c) => c.turnId === turn.id && !c.agentId).length === 0;
  for (const [i, part] of extracted.entries()) {
    const claim: Claim = {
      id: i === 0 ? e.id : `${e.id}::${i}`,
      eventId: e.id,
      seq: e.seq,
      ts: e.ts,
      turnId: turn?.id,
      agentId: e.agentId,
      kind: part.kind,
      text: part.text,
      confidence: part.confidence,
      rule: part.rule,
      phase,
      epistemic: 'reported',
    };
    if (state.claims.some((c) => c.text === claim.text && c.turnId === claim.turnId)) continue;
    state.claims.push(claim);
    if (e.agentId) continue; // subagent narration stays out of the headline history

    /*
     * The change log is where a claim becomes a statement the app makes in its own voice, filed
     * under a facet, so it is gated on the same threshold as every other surface. Below it the
     * claim is `other` and falls to the default branch: the agent said something at the top of the
     * turn, which is true and is all that is asserted. It used to be 4,097 `how` and 3,069 `why`
     * entries across the store, the majority of them decided by a trailing colon or a stray
     * negation, and the rail is a first-class surface at every depth.
     */
    switch (claim.kind) {
      case 'discovery':
        log.add('why', claim.text, 'reported', { claim: claim.kind, rule: claim.rule });
        break;
      case 'approach':
        log.add('how', claim.text, 'reported', { claim: claim.kind, rule: claim.rule });
        break;
      case 'verification':
        log.add('verified', `Agent says: ${claim.text}`, 'reported', {
          claim: claim.kind,
          rule: claim.rule,
        });
        break;
      case 'remaining':
        log.add('left', claim.text, 'reported', { claim: claim.kind, rule: claim.rule });
        break;
      case 'question':
        if (phase === 'final') {
          state.waiting = { kind: 'question', since: e.ts, summary: claim.text, seq: e.seq };
          log.add('review', `Agent asks: ${claim.text}`, 'reported', {
            claim: claim.kind,
            rule: claim.rule,
          });
        }
        break;
      case 'summary':
        if (phase === 'final') log.add('what', claim.text, 'reported', { claim: claim.kind });
        break;
      default:
        if (isFirstOfTurn && i === 0)
          log.add('status', claim.text, 'reported', { claim: claim.kind, rule: claim.rule });
    }
  }
}

/**
 * Sums what the agent consumed. The event arrives more than once per API response — the provider
 * stamps one response's usage onto every transcript record it split that response across — so a
 * repeat of a message id REPLACES what that lane last contributed instead of adding to it.
 *
 * Adding would count one response once per content block. Replacing is exact because the figures
 * within one response do not fall and the last record carries the complete snapshot.
 *
 * No `log.add`: consumption is not one of the history facets, and a row per API response would
 * overwhelm a log meant to be read.
 */
function onAgentUsage(state: RunState, e: StoredEventOf<'agent.usage'>) {
  const u = state.usage;
  const lane = e.agentId ?? 'main';
  const prev = u.lastByLane[lane];
  if (prev?.messageId === e.messageId) {
    u.inputTokens -= prev.inputTokens;
    u.outputTokens -= prev.outputTokens;
    u.cacheReadTokens -= prev.cacheReadTokens;
    u.cacheWriteTokens -= prev.cacheWriteTokens;
  } else {
    u.messages += 1;
  }
  u.inputTokens += e.inputTokens;
  u.outputTokens += e.outputTokens;
  u.cacheReadTokens += e.cacheReadTokens;
  u.cacheWriteTokens += e.cacheWriteTokens;
  u.lastByLane[lane] = {
    messageId: e.messageId,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheReadTokens: e.cacheReadTokens,
    cacheWriteTokens: e.cacheWriteTokens,
  };
}

function sourceFidelity(e: StoredEvent): number {
  switch (e.source.channel) {
    case 'transcript':
    case 'rollout':
      return 3;
    case 'app-server':
      return 2;
    case 'hook':
      return 1;
    case 'salidium':
      return 0;
  }
}

function callFidelity(e: StoredEventOf<'tool.called'>): number {
  return (e.input.kind === 'other' ? 0 : 100) + sourceFidelity(e);
}

function completionFidelity(e: StoredEventOf<'tool.completed'>): number {
  let information = 100;
  switch (e.result.kind) {
    case 'command':
      information =
        e.result.exit.observation === 'explicit'
          ? 500
          : e.result.exit.observation === 'unknown'
            ? 300
            : 400;
      break;
    case 'fileChanges': {
      const applied = e.result.changes.filter((change) => change.applied);
      information =
        300 +
        (applied.some((change) => change.linesAdded + change.linesRemoved > 0) ? 100 : 0) +
        (applied.some((change) => Boolean(change.hunks?.length)) ? 50 : 0);
      break;
    }
    case 'fileRead':
      information = 300;
      break;
    case 'subagent':
      information = e.result.status === 'completed' ? 400 : 300;
      break;
    case 'generic':
      information = e.result.excerpt ? 200 : 100;
      break;
  }
  return information * 10 + sourceFidelity(e);
}

function failureFidelity(e: StoredEventOf<'tool.failed'>): number {
  const information =
    e.exit?.observation === 'explicit'
      ? 500
      : e.exit?.observation === 'unknown'
        ? 300
        : e.exit
          ? 400
          : 200;
  return information * 10 + sourceFidelity(e);
}

function rememberEventId(a: Activity, id: string): void {
  if (!a.eventIds.includes(id)) a.eventIds.push(id);
  // Channel-specific ids make equivalent observations coexist. A lexical order is stable across
  // arrival order and puts the unsuffixed durable transcript id before its `:hook` counterpart.
  a.eventIds.sort((left, right) => left.localeCompare(right));
}

function onToolCalled(state: RunState, e: StoredEventOf<'tool.called'>, log: ChangeLog) {
  const existing = state.activities[e.callId];
  if (existing) {
    upgradeLateToolCall(state, existing, e, log);
    return;
  }
  const turn = turnFor(state, e);
  const activity: Activity = {
    callId: e.callId,
    turnId: turn?.id,
    agentId: e.agentId,
    toolName: e.toolName,
    kind: e.input.kind,
    title: clip(e.title, 200),
    input:
      e.input.kind === 'command' && e.input.command.length > 1200
        ? { ...e.input, command: `${e.input.command.slice(0, 1200)}…` }
        : e.input,
    startedAt: e.ts,
    status: 'running',
    isError: false,
    seqCalled: e.seq,
    callFidelity: callFidelity(e),
    eventIds: [e.id],
  };
  state.activities[e.callId] = activity;
  state.activityOrder.push(e.callId);
  state.running.push(e.callId);
  state.counters.toolCalls += 1;
  if (e.input.kind === 'command') state.counters.commands += 1;
  turn?.activityIds.push(e.callId);
  const lane = e.agentId ? state.subagents[e.agentId] : undefined;
  if (lane) lane.toolCalls += 1;

  if (e.input.kind === 'question') {
    // The review rules emit the history entry and open the review item.
    const q = e.input.questions[0] ?? 'question';
    state.waiting = { kind: 'question', since: e.ts, summary: q, seq: e.seq };
  }
}

/** Fills a result/failure-only placeholder when its earlier call record arrives later. */
function upgradeLateToolCall(
  state: RunState,
  a: Activity,
  e: StoredEventOf<'tool.called'>,
  log: ChangeLog,
): void {
  const resultOnlyPlaceholder = a.input.kind === 'other' && a.seqCompleted !== undefined;
  const candidateFidelity = callFidelity(e);
  rememberEventId(a, e.id);
  if (a.input.kind !== 'other' && candidateFidelity <= (a.callFidelity ?? -1)) return;
  const previousInputKind = a.input.kind;
  const previousTurn = a.turnId ? state.turns.find((t) => t.id === a.turnId) : undefined;
  const turn = turnFor(state, e);
  if (previousTurn && turn && previousTurn.id !== turn.id)
    previousTurn.activityIds = previousTurn.activityIds.filter((id) => id !== a.callId);
  if (turn && !turn.activityIds.includes(a.callId)) turn.activityIds.push(a.callId);
  a.turnId = turn?.id ?? a.turnId;
  a.agentId = e.agentId ?? a.agentId;
  a.toolName = e.toolName;
  a.kind = e.input.kind;
  a.title = clip(e.title, 200);
  a.input =
    e.input.kind === 'command' && e.input.command.length > 1200
      ? { ...e.input, command: `${e.input.command.slice(0, 1200)}…` }
      : e.input;
  a.startedAt = e.ts;
  if (!a.resultDurationExplicit && a.endedAt) a.durationMs = msBetween(e.ts, a.endedAt);
  a.seqCalled = e.seq;
  a.callFidelity = candidateFidelity;
  if (previousInputKind !== 'command' && e.input.kind === 'command') state.counters.commands += 1;
  if (previousInputKind === 'command' && e.input.kind !== 'command') state.counters.commands -= 1;
  const lane = e.agentId ? state.subagents[e.agentId] : undefined;
  if (lane && resultOnlyPlaceholder) lane.toolCalls += 1;
  if (e.input.kind !== 'command' || a.status === 'running') return;

  if (a.result?.kind === 'command') {
    const completion = {
      ...e,
      id: a.eventIds.find((id) => id !== e.id) ?? e.id,
      kind: 'tool.completed',
      callId: a.callId,
      toolName: a.toolName,
      result: a.result,
      isError: a.isError,
      durationMs: a.durationMs,
    } as StoredEventOf<'tool.completed'>;
    onCommandCompleted(state, a, completion, log, turn);
    a.result = trimResultForState(a.result);
    return;
  }

  if (a.isError && a.status === 'failed') {
    // Replace the generic placeholder issue with the command-specific interpretation now that the
    // input is known. The original generic history remains a truthful earlier observation.
    for (let i = state.issues.length - 1; i >= 0; i--)
      if (state.issues[i]?.callId === a.callId && state.issues[i]?.kind === 'toolError')
        state.issues.splice(i, 1);
    const failure = {
      ...e,
      id: a.eventIds.find((id) => id !== e.id) ?? e.id,
      kind: 'tool.failed',
      callId: a.callId,
      toolName: a.toolName,
      errorExcerpt: a.errorExcerpt ?? '',
      cause: a.failureCause ?? 'error',
      exit: a.exit,
      interrupted: a.failureCause === 'interrupted' || undefined,
      durationMs: a.durationMs,
    } as StoredEventOf<'tool.failed'>;
    recordToolFailure(state, a, failure, log);
  }
}

function completeActivity(state: RunState, callId: string, e: StoredEvent): Activity | undefined {
  const a = state.activities[callId];
  if (!a) return undefined;
  if (a.status !== 'running') return a;
  a.endedAt = e.ts;
  a.seqCompleted = e.seq;
  rememberEventId(a, e.id);
  state.running = state.running.filter((id) => id !== callId);
  if (state.waiting && (state.waiting.kind === 'permission' || state.waiting.kind === 'input'))
    state.waiting = undefined;
  return a;
}

function onToolCompleted(state: RunState, e: StoredEventOf<'tool.completed'>, log: ChangeLog) {
  let a = state.activities[e.callId];
  if (!a) {
    // Result without a recorded call (channel gap): synthesize the activity from the result.
    const turn = turnFor(state, e);
    a = {
      callId: e.callId,
      turnId: turn?.id,
      agentId: e.agentId,
      toolName: e.toolName,
      kind: inferKindFromResult(e),
      title: e.toolName,
      input: { kind: 'other', summary: e.toolName },
      startedAt: e.ts,
      status: 'running',
      isError: false,
      seqCalled: e.seq,
      callFidelity: 0,
      eventIds: [],
    };
    state.activities[e.callId] = a;
    state.activityOrder.push(e.callId);
    state.counters.toolCalls += 1;
    turn?.activityIds.push(e.callId);
    state.running.push(e.callId);
  }
  if (a.status !== 'running') {
    upgradeCompletedActivity(state, a, e, log);
    return;
  }
  completeActivity(state, e.callId, e);
  a.status = e.isError ? 'failed' : 'completed';
  a.isError = e.isError;
  a.result = e.result;
  a.resultFidelity = completionFidelity(e);
  a.resultDurationExplicit = e.durationMs !== undefined;
  a.durationMs = e.durationMs ?? a.durationMs ?? msBetween(a.startedAt, e.ts);
  if (e.result.kind === 'command') a.exit = e.result.exit;
  if (e.isError) state.counters.toolFailures += 1;
  if (a.kind === 'question' && state.waiting?.kind === 'question') state.waiting = undefined;

  const turn = a.turnId ? state.turns.find((t) => t.id === a.turnId) : undefined;

  switch (e.result.kind) {
    case 'fileChanges':
      for (const change of e.result.changes) applyFileChange(state, a, change, e, log, turn);
      break;
    case 'command':
      onCommandCompleted(state, a, e, log, turn);
      break;
    case 'subagent':
      {
        const s = e.result.agentId ? state.subagents[e.result.agentId] : undefined;
        if (s) {
          s.endedAt = s.endedAt ?? e.ts;
          s.lastMessage = s.lastMessage ?? e.result.summaryExcerpt;
        }
      }
      break;
    default:
      break;
  }
  // A command result can precede the call that names the command. Keep its bounded event excerpt
  // until that call arrives so verification parsing sees the same evidence normal ordering does.
  a.result =
    a.input.kind === 'other' && e.result.kind === 'command'
      ? e.result
      : trimResultForState(e.result);
}

/**
 * A second result for an already-completed call arrives when a lower-fidelity channel (a hook
 * without exit codes or line counts) reported first and the provider's own record follows. The
 * canonical rule is "the more informative result wins": explicit exit codes replace inferred or
 * unknown ones (verification is re-derived), and real diffs replace zero-line placeholders.
 * Anything else is a duplicate and is ignored, so replay order cannot change the outcome.
 */
function upgradeCompletedActivity(
  state: RunState,
  a: Activity,
  e: StoredEventOf<'tool.completed'>,
  log: ChangeLog,
) {
  if (a.sourceConflict) {
    rememberEventId(a, e.id);
    return;
  }
  const candidateFidelity = completionFidelity(e);
  rememberEventId(a, e.id);
  const turn = a.turnId ? state.turns.find((t) => t.id === a.turnId) : undefined;
  if (e.result.kind === 'command' && a.result?.kind === 'command') {
    const existingVerdict = commandVerdict(a.result.exit, a.isError);
    const incomingVerdict = commandVerdict(e.result.exit, e.isError);
    if (terminalVerdictsConflict(existingVerdict, incomingVerdict)) {
      markSourceConflict(state, a, e, log);
      return;
    }
    if (candidateFidelity <= (a.resultFidelity ?? -1)) return;
    a.exit = e.result.exit;
    a.isError = e.isError;
    a.status = e.isError ? 'failed' : 'completed';
    a.endedAt = e.ts;
    a.seqCompleted = e.seq;
    a.durationMs = e.durationMs ?? msBetween(a.startedAt, e.ts);
    a.resultDurationExplicit = e.durationMs !== undefined;
    a.resultFidelity = candidateFidelity;
    const full: Activity = { ...a, result: e.result, exit: e.result.exit };
    const previousIdx = state.verifications.findIndex((v) => v.callId === a.callId);
    const previous = previousIdx >= 0 ? state.verifications[previousIdx] : undefined;
    if (previous) {
      state.verifications.splice(previousIdx, 1);
      if (turn) turn.verificationIds = turn.verificationIds.filter((id) => id !== previous.id);
    }
    const verification = deriveVerification(full, e.seq);
    if (verification) {
      const changed = previous === undefined || previous.outcome !== verification.outcome;
      recordVerification(state, a, verification, e, log, turn, changed);
    }
    a.result = trimResultForState(e.result);
    return;
  }
  if (e.result.kind === 'fileChanges' && a.result?.kind === 'fileChanges') {
    if (candidateFidelity <= (a.resultFidelity ?? -1)) return;
    for (const change of e.result.changes) {
      const old = a.result.changes.find((c) => c.path === change.path);
      if (!old) {
        applyFileChange(state, a, change, e, log, turn);
        continue;
      }
      const oldLines = old.linesAdded + old.linesRemoved;
      const newLines = change.linesAdded + change.linesRemoved;
      const file = state.files[change.path];
      if (!file) continue;
      file.linesAdded += change.linesAdded - old.linesAdded;
      file.linesRemoved += change.linesRemoved - old.linesRemoved;
      state.counters.linesAdded += change.linesAdded - old.linesAdded;
      state.counters.linesRemoved += change.linesRemoved - old.linesRemoved;
      file.lastHunks = change.hunks?.slice(0, 20);
      file.lastChangedAt = e.ts;
      file.lastChangeSeq = e.seq;
      file.lastAgentId = e.agentId;
      if (oldLines === 0 && newLines > 0) {
        log.add(
          'what',
          `${changeVerb(change.change)} ${basename(change.path)} (+${change.linesAdded} −${change.linesRemoved})`,
          'observed',
          {
            path: change.path,
            change: change.change,
            linesAdded: change.linesAdded,
            linesRemoved: change.linesRemoved,
            agentId: e.agentId,
          },
        );
      }
    }
    a.endedAt = e.ts;
    a.seqCompleted = e.seq;
    a.durationMs = e.durationMs ?? msBetween(a.startedAt, e.ts);
    a.resultDurationExplicit = e.durationMs !== undefined;
    a.resultFidelity = candidateFidelity;
    a.isError = e.isError;
    a.status = e.isError ? 'failed' : 'completed';
    a.result = trimResultForState(e.result);
    return;
  }
  if (candidateFidelity <= (a.resultFidelity ?? -1)) return;
  a.endedAt = e.ts;
  a.seqCompleted = e.seq;
  a.durationMs = e.durationMs ?? msBetween(a.startedAt, e.ts);
  a.resultDurationExplicit = e.durationMs !== undefined;
  a.resultFidelity = candidateFidelity;
  a.isError = e.isError;
  a.status = e.isError ? 'failed' : 'completed';
  a.result = trimResultForState(e.result);
}

type TerminalVerdict = 'pass' | 'fail' | 'unknown';

function commandVerdict(exit: Activity['exit'], isError: boolean): TerminalVerdict {
  if (isError) return 'fail';
  if (exit?.observation === 'inferred-failure') return 'fail';
  if (exit?.observation === 'inferred-success') return 'pass';
  if (exit?.observation === 'explicit') return exit.code === 0 ? 'pass' : 'fail';
  return 'unknown';
}

function terminalVerdictsConflict(a: TerminalVerdict, b: TerminalVerdict): boolean {
  return (a === 'pass' && b === 'fail') || (a === 'fail' && b === 'pass');
}

function failedEventVerdict(e: StoredEventOf<'tool.failed'>): TerminalVerdict {
  return e.cause === 'timeout' ||
    e.cause === 'interrupted' ||
    e.cause === 'rejected' ||
    e.cause === 'denied'
    ? 'unknown'
    : 'fail';
}

/**
 * Two explicit terminal records disagree about one call. Preserve both as evidence, but do not
 * let arrival order select a winner. The raw records remain available through eventIds; the
 * projected activity and verification intentionally become inconclusive.
 */
function markSourceConflict(
  state: RunState,
  a: Activity,
  e: StoredEventOf<'tool.completed'> | StoredEventOf<'tool.failed'>,
  log: ChangeLog,
): void {
  const evidenceIds = [...new Set([...a.eventIds, e.id])].sort();
  const incomingIsFailure = e.kind === 'tool.failed' || e.isError;
  const priorFailureCounted = a.status === 'failed' || a.isError;
  if (incomingIsFailure && !priorFailureCounted) state.counters.toolFailures += 1;

  const turn = a.turnId ? state.turns.find((candidate) => candidate.id === a.turnId) : undefined;
  const previous = state.verifications.find((v) => v.callId === a.callId);
  state.verifications = state.verifications.filter((v) => v.callId !== a.callId);
  if (turn) turn.verificationIds = turn.verificationIds.filter((id) => id !== a.callId);
  state.issues = state.issues.filter((issue) => issue.callId !== a.callId);
  state.review = state.review.filter(
    (item) =>
      !(item.rule === 'verification-failed' && item.refs.some((ref) => evidenceIds.includes(ref))),
  );

  const endedAt = a.endedAt && a.endedAt > e.ts ? a.endedAt : e.ts;
  const incomingDuration = e.durationMs ?? msBetween(a.startedAt, e.ts) ?? 0;
  a.endedAt = endedAt;
  a.durationMs = Math.max(a.durationMs ?? 0, incomingDuration);
  a.seqCompleted = e.seq;
  a.eventIds = evidenceIds;
  a.status = 'unknown';
  a.sourceConflict = true;
  a.isError = false;
  a.errorExcerpt = undefined;
  a.failureCause = undefined;
  a.exit = { observation: 'unknown' };
  a.result = {
    kind: 'command',
    exit: { observation: 'unknown' },
    outputExcerpt: '',
    outputChars: 0,
    truncated: false,
  };
  state.running = state.running.filter((id) => id !== a.callId);

  const derived = deriveVerification(a, e.seq);
  if (derived) {
    const conflict: Verification = {
      ...derived,
      outcome: 'unknown',
      counts: undefined,
      exit: { observation: 'unknown' },
      outcomeEpistemic: 'observed',
      caveats: [...new Set([...derived.caveats, 'source-conflict'])],
      failureExcerpt: undefined,
    };
    recordVerification(state, a, conflict, e, log, turn);
  } else if (previous && a.input.kind === 'command') {
    const conflict: Verification = {
      ...previous,
      at: endedAt,
      seq: e.seq,
      outcome: 'unknown',
      counts: undefined,
      exit: { observation: 'unknown' },
      outcomeEpistemic: 'observed',
      caveats: [...new Set([...previous.caveats, 'source-conflict'])],
      failureExcerpt: undefined,
    };
    recordVerification(state, a, conflict, e, log, turn);
  }

  const reviewId = `source-conflict:${a.callId}`;
  if (!state.review.some((item) => item.id === reviewId && item.resolvedSeq === undefined)) {
    const label = 'Conflicting tool results';
    const instance = clip(a.input.kind === 'command' ? a.input.command : a.title, 120);
    state.review.push({
      id: reviewId,
      rule: 'source-conflict',
      severity: 'high',
      label,
      instance,
      summary: `${label}: ${instance}`,
      detail: 'The provider records disagree about whether this call succeeded.',
      refs: evidenceIds,
      createdSeq: e.seq,
      createdAt: endedAt,
      epistemic: 'observed',
    });
    log.add('review', `${label}: ${instance}`, 'observed', {
      rule: 'source-conflict',
      severity: 'high',
    });
  }
}

function changeVerb(kind: FileChange['change']): string {
  return kind === 'add'
    ? 'Created'
    : kind === 'delete'
      ? 'Deleted'
      : kind === 'move'
        ? 'Moved'
        : 'Changed';
}

/**
 * The event log keeps full excerpts; the in-memory/checkpointed state keeps only what the
 * projections need. Everything else is one drill-through away via the activity's event ids.
 */
function trimResultForState(
  result: StoredEventOf<'tool.completed'>['result'],
): StoredEventOf<'tool.completed'>['result'] {
  switch (result.kind) {
    case 'command':
      return { ...result, outputExcerpt: clip(result.outputExcerpt, 240) };
    case 'fileChanges':
      return { ...result, changes: result.changes.map((c) => ({ ...c, hunks: undefined })) };
    case 'subagent':
      return {
        ...result,
        summaryExcerpt: result.summaryExcerpt ? clip(result.summaryExcerpt, 400) : undefined,
      };
    case 'generic':
      return { ...result, excerpt: result.excerpt ? clip(result.excerpt, 240) : undefined };
    default:
      return result;
  }
}

function inferKindFromResult(e: StoredEventOf<'tool.completed'>): Activity['kind'] {
  switch (e.result.kind) {
    case 'command':
      return 'command';
    case 'fileChanges':
      return 'fileEdit';
    case 'fileRead':
      return 'fileRead';
    case 'subagent':
      return 'subagent';
    default:
      return 'other';
  }
}

function applyFileChange(
  state: RunState,
  a: Activity,
  change: FileChange,
  e: StoredEvent,
  log: ChangeLog,
  turn: Turn | undefined,
) {
  if (!change.applied) {
    state.issues.push({
      id: `patch:${e.id}:${change.path}`,
      kind: 'patchFailed',
      summary: `Patch not applied: ${basename(change.path)}`,
      seq: e.seq,
      ts: e.ts,
      callId: a.callId,
    });
    log.add('review', `Patch not applied: ${basename(change.path)}`, 'observed');
    return;
  }
  const existing = state.files[change.path];
  const file: FileState = existing ?? {
    path: change.path,
    changeCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    kinds: [],
    firstChangedAt: e.ts,
    lastChangedAt: e.ts,
    lastChangeSeq: e.seq,
    lastCallId: a.callId,
    turnIds: [],
  };
  if (!existing) {
    state.files[change.path] = file;
    state.counters.filesChanged += 1;
  }
  file.changeCount += 1;
  file.linesAdded += change.linesAdded;
  file.linesRemoved += change.linesRemoved;
  if (!file.kinds.includes(change.change)) file.kinds.push(change.change);
  file.lastChangedAt = e.ts > file.lastChangedAt ? e.ts : file.lastChangedAt;
  file.lastChangeSeq = e.seq;
  file.lastCallId = a.callId;
  file.lastAgentId = e.agentId;
  if (change.hunks) file.lastHunks = change.hunks.slice(0, 20);
  if (change.userModifiedBefore) file.userModifiedBefore = true;
  if (turn && !file.turnIds.includes(turn.id)) file.turnIds.push(turn.id);
  if (turn && !turn.filesTouched.includes(change.path)) turn.filesTouched.push(change.path);
  state.counters.linesAdded += change.linesAdded;
  state.counters.linesRemoved += change.linesRemoved;
  for (const v of state.verifications) if (v.at <= e.ts) v.stale = true;

  const verb = changeVerb(change.change);
  const delta =
    change.change === 'delete' ? '' : ` (+${change.linesAdded} −${change.linesRemoved})`;
  // A zero-line update is a placeholder from a channel without diffs; the real result upgrades it.
  const placeholder =
    change.change === 'update' && change.linesAdded + change.linesRemoved === 0 && !change.hunks;
  if (!placeholder) {
    log.add('what', `${verb} ${basename(change.path)}${delta}`, 'observed', {
      path: change.path,
      change: change.change,
      linesAdded: change.linesAdded,
      linesRemoved: change.linesRemoved,
      agentId: e.agentId,
    });
  }
  if (change.userModifiedBefore)
    log.add(
      'review',
      `You had edited ${basename(change.path)} before the agent changed it`,
      'observed',
      { path: change.path, rule: 'user-modified' },
    );
}

const READ_ONLY_COMMAND =
  /^\s*(ls|cat|head|tail|grep|rg|find|fd|pwd|which|echo|wc|tree|stat|file|du|df|env|printenv|git\s+(status|log|diff|show|blame|branch|remote|rev-parse|ls-files)|sed\s+-n|awk|jq|less|more|type|node\s+-e|python3?\s+-c|open|curl\s+-s)\b/;

function onCommandCompleted(
  state: RunState,
  a: Activity,
  e: StoredEventOf<'tool.completed'>,
  log: ChangeLog,
  turn: Turn | undefined,
) {
  if (a.input.kind !== 'command' || e.result.kind !== 'command') return;
  const command = a.input.command;
  const result = e.result;

  if (result.gitOperation) {
    state.git.operations.push({ op: result.gitOperation, at: e.ts, callId: a.callId });
    if (result.gitOperation.commit) {
      state.git.commits.push({
        sha: result.gitOperation.commit.sha,
        at: e.ts,
        callId: a.callId,
        kind: result.gitOperation.commit.kind,
      });
      state.git.head = result.gitOperation.commit.sha;
      log.add('what', `Committed ${shortSha(result.gitOperation.commit.sha)}`, 'observed', {
        sha: result.gitOperation.commit.sha,
      });
    }
    if (result.gitOperation.push) {
      state.git.pushes.push({
        branch: result.gitOperation.push.branch,
        at: e.ts,
        callId: a.callId,
      });
    }
  } else {
    const git = detectGitCommand(command);
    if (git === 'commit' && !e.isError) {
      const sha = /\[[^\]]*\s([0-9a-f]{7,40})\]/.exec(result.outputExcerpt)?.[1];
      state.git.commits.push({ sha: sha ?? '', at: e.ts, callId: a.callId });
      if (sha) state.git.head = sha;
      log.add(
        'what',
        sha ? `Committed ${shortSha(sha)}` : 'Committed',
        sha ? 'observed' : 'inferred',
        { sha },
      );
    } else if (git === 'push' && !e.isError) {
      state.git.pushes.push({ at: e.ts, callId: a.callId });
    }
  }

  const verification = deriveVerification(a, e.seq);
  if (verification) {
    recordVerification(state, a, verification, e, log, turn);
    return;
  }

  if (e.isError) {
    state.issues.push({
      id: `command:${e.id}`,
      kind: 'commandFailed',
      summary: `Command failed: ${clip(command, 100)}`,
      seq: e.seq,
      ts: e.ts,
      callId: a.callId,
    });
    log.add('what', `Command failed: ${clip(command, 100)}`, 'observed', { exit: result.exit });
    return;
  }
  // Routine successful commands are activity, not semantic history: they stay in the Activity list.
  // Long-running ones (installs, builds without a recognized runner) are worth a line.
  if (!READ_ONLY_COMMAND.test(command) && (a.durationMs ?? 0) >= 30_000) {
    log.add(
      'what',
      `Ran ${clip(command, 110)} (${Math.round((a.durationMs ?? 0) / 1000)}s)`,
      'observed',
    );
  }
}

/** Records a derived verification: state, turn linkage, issue tracking, and one history line. */
function recordVerification(
  state: RunState,
  a: Activity,
  verification: Verification,
  e: StoredEvent,
  log: ChangeLog,
  turn: Turn | undefined,
  logChange = true,
) {
  state.verifications.push(verification);
  turn?.verificationIds.push(verification.id);
  if (logChange) {
    log.add('verified', describeVerification(verification), verification.outcomeEpistemic, {
      outcome: verification.outcome,
      runner: verification.runner,
      method: verification.method,
      counts: verification.counts,
      caveats: verification.caveats,
    });
  }
  if (verification.outcome === 'fail') {
    state.issues.push({
      id: `verification:${verification.id}`,
      kind: 'commandFailed',
      summary: describeVerification(verification),
      seq: e.seq,
      ts: e.ts,
      callId: a.callId,
    });
  } else if (verification.outcome === 'pass' && verification.scope !== 'partial') {
    for (const issue of state.issues) {
      if (
        issue.kind === 'commandFailed' &&
        issue.resolvedSeq === undefined &&
        issue.id.startsWith('verification:')
      )
        issue.resolvedSeq = e.seq;
    }
  }
}

export function describeVerification(v: {
  method: string;
  runner?: string;
  outcome: string;
  counts?: { passed?: number; failed?: number; skipped?: number; total?: number };
  scope?: string;
  caveats?: string[];
}): string {
  const runner = v.runner ? ` (${v.runner})` : '';
  const c = v.counts;
  const partial = v.scope === 'partial' ? ' [subset]' : '';
  if (v.method === 'test') {
    if (v.outcome === 'pass') {
      if (c?.total !== undefined && c.total > 0) {
        const skipped = c.skipped ? `, ${c.skipped} skipped` : '';
        return `${c.passed ?? 0}/${c.total} tests passed${skipped}${runner}${partial}`;
      }
      return `Tests passed${runner}${partial}${v.caveats?.includes('exit-inferred') ? ' (exit inferred)' : ''}`;
    }
    if (v.outcome === 'fail') {
      if (c?.failed !== undefined && c.failed > 0)
        return `${c.failed} of ${c.total ?? '?'} tests failed${runner}${partial}`;
      return `Tests failed${runner}${partial}`;
    }
    if (v.outcome === 'partial') return `Tests passed but command failed${runner}`;
    return `Test run result unknown${runner}`;
  }
  const label =
    v.method === 'typecheck'
      ? 'Typecheck'
      : v.method === 'lint'
        ? 'Lint'
        : v.method === 'build'
          ? 'Build'
          : 'Check';
  if (v.outcome === 'pass') return `${label} passed${runner}`;
  if (v.outcome === 'fail')
    return `${label} failed${runner}${c?.failed ? ` (${c.failed} error${c.failed === 1 ? '' : 's'})` : ''}`;
  if (v.outcome === 'partial') return `${label} partially passed${runner}`;
  return `${label} result unknown${runner}`;
}

function onToolFailed(state: RunState, e: StoredEventOf<'tool.failed'>, log: ChangeLog) {
  onToolFailedInner(state, e, log);
  const a = state.activities[e.callId];
  if (a) {
    a.errorExcerpt = a.errorExcerpt === undefined ? undefined : clip(a.errorExcerpt, 400);
    if (a.result?.kind === 'command')
      a.result = { ...a.result, outputExcerpt: clip(a.result.outputExcerpt, 240) };
  }
}

function onToolFailedInner(state: RunState, e: StoredEventOf<'tool.failed'>, log: ChangeLog) {
  let a = state.activities[e.callId];
  if (!a) {
    // Preserve a failure whose call record has not arrived yet. The late call upgrades this
    // placeholder and applies command-specific verification/failure semantics then.
    const turn = turnFor(state, e);
    a = {
      callId: e.callId,
      turnId: turn?.id,
      agentId: e.agentId,
      toolName: e.toolName,
      kind: 'other',
      title: e.toolName,
      input: { kind: 'other', summary: e.toolName },
      startedAt: e.ts,
      status: 'running',
      isError: false,
      seqCalled: e.seq,
      callFidelity: 0,
      eventIds: [],
    };
    state.activities[e.callId] = a;
    state.activityOrder.push(e.callId);
    state.counters.toolCalls += 1;
    turn?.activityIds.push(e.callId);
    state.running.push(e.callId);
  }
  if (a.sourceConflict) {
    rememberEventId(a, e.id);
    return;
  }
  if (a.status !== 'running') {
    if (
      a.result?.kind === 'command' &&
      terminalVerdictsConflict(commandVerdict(a.result.exit, a.isError), failedEventVerdict(e))
    )
      markSourceConflict(state, a, e, log);
    else upgradeFailedActivity(state, a, e, log);
    return;
  }
  completeActivity(state, e.callId, e);
  a.status = 'failed';
  a.isError = true;
  a.errorExcerpt = e.errorExcerpt;
  a.failureCause = e.cause;
  a.resultFidelity = failureFidelity(e);
  a.resultDurationExplicit = e.durationMs !== undefined;
  a.durationMs = e.durationMs ?? msBetween(a.startedAt, e.ts);
  if (e.exit) a.exit = e.exit;
  if (e.cause === 'rejected' || e.cause === 'denied') {
    a.status = 'unknown';
    if (state.waiting?.kind === 'question' && a.kind === 'question') state.waiting = undefined;
    log.add(
      'review',
      `${e.cause === 'rejected' ? 'You rejected' : 'Denied'}: ${a.title}`,
      'observed',
      { cause: e.cause },
    );
    return;
  }
  state.counters.toolFailures += 1;
  recordToolFailure(state, a, e, log);
}

function upgradeFailedActivity(
  state: RunState,
  a: Activity,
  e: StoredEventOf<'tool.failed'>,
  log: ChangeLog,
): void {
  const candidateFidelity = failureFidelity(e);
  rememberEventId(a, e.id);
  if (candidateFidelity <= (a.resultFidelity ?? -1)) return;
  const evidenceIds = new Set(a.eventIds);
  const turn = a.turnId ? state.turns.find((candidate) => candidate.id === a.turnId) : undefined;
  state.verifications = state.verifications.filter(
    (verification) => verification.callId !== a.callId,
  );
  if (turn) turn.verificationIds = turn.verificationIds.filter((id) => id !== a.callId);
  state.issues = state.issues.filter((issue) => issue.callId !== a.callId);
  state.review = state.review.filter(
    (item) =>
      !(item.rule === 'verification-failed' && item.refs.some((ref) => evidenceIds.has(ref))),
  );

  a.endedAt = e.ts;
  a.seqCompleted = e.seq;
  a.status = e.cause === 'rejected' || e.cause === 'denied' ? 'unknown' : 'failed';
  a.isError = true;
  a.errorExcerpt = e.errorExcerpt;
  a.failureCause = e.cause;
  a.exit = e.exit;
  a.result = undefined;
  a.durationMs = e.durationMs ?? msBetween(a.startedAt, e.ts);
  a.resultDurationExplicit = e.durationMs !== undefined;
  a.resultFidelity = candidateFidelity;
  recordToolFailure(state, a, e, log);
}

function recordToolFailure(
  state: RunState,
  a: Activity,
  e: StoredEventOf<'tool.failed'>,
  log: ChangeLog,
) {
  if (a.kind === 'command' && a.input.kind === 'command') {
    const inconclusive = e.cause === 'timeout' || e.cause === 'interrupted';
    if (!a.result) {
      a.result = {
        kind: 'command',
        // A timed-out or interrupted command did not finish: its outcome is unknown, not a failure.
        exit: inconclusive
          ? { observation: 'unknown' }
          : (e.exit ?? { observation: 'inferred-failure' }),
        outputExcerpt: e.errorExcerpt,
        outputChars: e.errorExcerpt.length,
        truncated: false,
        interrupted: e.interrupted || e.cause === 'interrupted' || undefined,
        timedOut: e.cause === 'timeout' || undefined,
      };
    }
    if (inconclusive) a.exit = { observation: 'unknown' };
    const turn = a.turnId ? state.turns.find((t) => t.id === a.turnId) : undefined;
    const verification = deriveVerification(a, e.seq);
    if (verification) {
      recordVerification(state, a, verification, e, log, turn);
      return;
    }
    if (e.interrupted) {
      log.add('what', `Interrupted: ${clip(a.input.command, 100)}`, 'observed');
      return;
    }
    state.issues.push({
      id: `command:${e.id}`,
      kind: 'commandFailed',
      summary: `Command failed: ${clip(a.input.command, 100)}`,
      seq: e.seq,
      ts: e.ts,
      callId: a.callId,
    });
    log.add('what', `Command failed: ${clip(a.input.command, 100)}`, 'observed', { exit: e.exit });
    return;
  }
  state.issues.push({
    id: `tool:${e.id}`,
    kind: 'toolError',
    summary: `${a.title} failed`,
    seq: e.seq,
    ts: e.ts,
    callId: a.callId,
  });
  log.add('what', `${a.title} failed`, 'observed');
}

function onPlanUpdated(state: RunState, e: StoredEventOf<'plan.updated'>, log: ChangeLog) {
  const before = state.plan.items;
  let items: PlanItem[];
  if (e.mode === 'replace') {
    items = e.items.map((i) => ({ ...i }));
  } else {
    const byId = new Map(before.map((i) => [i.id, { ...i }]));
    for (const i of e.items) {
      const prev = byId.get(i.id);
      byId.set(
        i.id,
        prev
          ? {
              ...prev,
              status: i.status,
              text: i.text || prev.text,
              activeForm: i.activeForm ?? prev.activeForm,
            }
          : { ...i },
      );
    }
    items = [...byId.values()].filter(
      (i) => i.status !== 'cancelled' || before.some((b) => b.id === i.id),
    );
  }
  state.plan = {
    items,
    updatedAt: e.ts,
    updatedSeq: e.seq,
    explanation: e.explanation ?? state.plan.explanation,
  };
  const done = items.filter((i) => i.status === 'completed').length;
  const inProgress = items.find((i) => i.status === 'in_progress');
  const pending = items.filter((i) => i.status === 'pending' || i.status === 'in_progress').length;
  const newlyDone = items.filter(
    (i) => i.status === 'completed' && before.find((b) => b.id === i.id)?.status !== 'completed',
  );
  const isNewPlan = before.length === 0 && items.length > 0;
  if (isNewPlan) {
    log.add(
      'how',
      `Plan: ${items.length} steps (${items
        .slice(0, 3)
        .map((i) => i.text)
        .join('; ')})`,
      'planned',
      { items: items.length },
    );
  }
  for (const d of newlyDone)
    log.add('left', `Done: ${d.text}`, 'reported', { itemId: d.id, done, total: items.length });
  if (
    inProgress &&
    (isNewPlan || before.find((b) => b.id === inProgress.id)?.status !== 'in_progress')
  ) {
    log.add('how', `Now: ${inProgress.activeForm ?? inProgress.text}`, 'planned', {
      itemId: inProgress.id,
    });
  }
  if (e.explanation) log.add('why', `Plan changed: ${e.explanation}`, 'reported');
  const changed = JSON.stringify(before) !== JSON.stringify(items);
  if (!isNewPlan && newlyDone.length === 0 && !inProgress && changed) {
    log.add(
      'left',
      pending > 0 ? `${pending} of ${items.length} steps remaining` : 'All plan steps completed',
      'planned',
      { pending, total: items.length },
    );
  }
}

function onGitSnapshot(state: RunState, e: StoredEventOf<'git.snapshot'>, log: ChangeLog) {
  const prevHead = state.git.head;
  state.git.head = e.head ?? state.git.head;
  state.git.branch = e.branch ?? state.git.branch;
  state.git.dirtyCount = e.dirty.length + (e.dirtyTruncated ? 1 : 0);
  state.git.snapshotAt = e.ts;
  if (!state.repoRoot) state.repoRoot = e.repoRoot;
  if (e.head && prevHead && e.head !== prevHead) {
    const known = state.git.commits.find(
      (c) => c.sha && (e.head?.startsWith(c.sha) || c.sha.startsWith(e.head ?? '')),
    );
    if (known) {
      if (known.sha.length < e.head.length) known.sha = e.head; // upgrade a short sha to the full one
    } else {
      // A HEAD move without an observed commit (checkout, reset, pull) is not a commit.
      state.git.headMoves.push({ from: prevHead, to: e.head, at: e.ts });
      log.add('what', `HEAD moved to ${shortSha(e.head)}`, 'observed', {
        sha: e.head,
        branch: e.branch,
      });
    }
  }
}

function msBetween(a: string, b: string): number | undefined {
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2) || t2 < t1) return undefined;
  return t2 - t1;
}

function maxTs(a: string | undefined, b: string): string {
  if (!a) return b;
  return b > a ? b : a;
}
