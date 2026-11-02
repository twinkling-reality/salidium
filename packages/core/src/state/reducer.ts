import type { PlanItem, SemanticChange, StoredEvent, StoredEventOf } from '@salidium/protocol';
import { extractClaims, headlineOf } from '../claims/classifyAgentMessage.ts';
import { plainText } from '../claims/markdown.ts';
import { deriveVerification } from '../verification/deriveVerification.ts';
import { basename, ChangeLog, clip, shortSha } from './changeLog.ts';
import { deriveStatus } from './deriveStatus.ts';
import {
  absorbed,
  callFidelity,
  commandVerdict,
  completionFidelity,
  failedEventVerdict,
  failureFidelity,
  maxTs,
  msBetween,
  rememberEventId,
  terminalVerdictsConflict,
} from './fidelity.ts';
import {
  applyFileChange,
  changeVerb,
  inferKindFromResult,
  markRemovedUnknown,
  trimResultForState,
} from './fileChanges.ts';
import { ownEntry, setEntry } from './keyedRecord.ts';
import { applyReviewRulesAfterEvent } from './reviewRules.ts';
import type { Activity, Claim, RunState, Turn } from './runState.ts';
import {
  markSourceConflict,
  onCommandCompleted,
  recordToolFailure,
  recordVerification,
} from './verificationReducer.ts';

export { describeVerification } from './verificationReducer.ts';

/**
 * Folds one stored event into the run state, mutating it in place, and returns the semantic
 * changes the event caused. Deterministic: same events in the same order -> same state and
 * same changes. No wall clock, no I/O.
 */
export function applyEvent(state: RunState, event: StoredEvent): SemanticChange[] {
  if (event.seq <= state.latestSeq) return []; // already applied (idempotent replay)
  const log = new ChangeLog(state.sessionId, event);
  state.latestSeq = event.seq;
  state.revision += 1;
  state.lastEventAt = maxTs(state.lastEventAt, event.ts);
  if (event.redactions) state.counters.redactions += event.redactions;
  if (absorbed(state, event)) return log.changes;

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
      setEntry(state.subagents, event.subagentId, {
        id: event.subagentId,
        agentType: event.agentType,
        description: event.description,
        startedAt: event.ts,
        toolCalls: 0,
        eventId: event.id,
      });
      log.add(
        'how',
        `Delegated to ${event.agentType ?? 'subagent'}: ${event.description ?? event.subagentId}`,
        'observed',
      );
      break;
    case 'subagent.ended': {
      const s = ownEntry(state.subagents, event.subagentId);
      if (s) {
        s.endedAt = event.ts;
        s.lastMessage = event.lastMessage ? clip(plainText(event.lastMessage), 600) : undefined;
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
        epistemic: 'observed',
      };
      break;
    case 'notification':
      if (
        event.notificationType === 'idle_prompt' ||
        event.notificationType === 'agent_needs_input'
      ) {
        state.waiting = {
          kind: 'input',
          since: event.ts,
          summary: event.message,
          seq: event.seq,
          epistemic: 'observed',
        };
      }
      break;
    case 'git.snapshot':
      onGitSnapshot(state, event, log);
      break;
    case 'file.located':
      for (const file of event.files) setEntry(state.fileLocations, file.path, file.repository);
      break;
    case 'ingest.warning':
      state.counters.ingestWarnings += 1;
      break;
    case 'salidium.explanation':
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
        ...(event.canvasBlocks ? { canvasBlocks: event.canvasBlocks } : {}),
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
    return openTurn(state, event.turnId, '', event.ts, event.seq);
  }
  const byTime = state.turns.find(
    (t) => t.startedAt <= event.ts && (!t.endedAt || event.ts <= t.endedAt),
  );
  return byTime ?? currentTurn(state) ?? state.turns[state.turns.length - 1];
}

function openTurn(state: RunState, id: string, prompt: string, ts: string, seq: number): Turn {
  const open = currentTurn(state);
  if (open && open.id !== id && open.activityIds.length === 0 && open.prompt === '') {
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
  if (e.prompt?.includes('[salidium-explainer]')) state.internal = true;
  const id = e.turnId ?? `turn-${state.turns.length + 1}`;
  const existing = state.turns.find((t) => t.id === id);
  if (existing) {
    if (existing.prompt) return;
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
    turn = openTurn(state, e.turnId, '', e.ts, e.seq);
  }
  if (!turn) return;
  if (turn.endedAt && !turn.endInferred) {
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
  for (const id of state.running) {
    const a = ownEntry(state.activities, id);
    if (a && a.turnId === turn.id) {
      a.status = 'unknown';
      a.endedAt = e.ts;
    }
  }
  state.running = state.running.filter((id) => ownEntry(state.activities, id)?.turnId !== turn.id);

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
    if (e.agentId) continue;

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
          state.waiting = {
            kind: 'question',
            since: e.ts,
            summary: claim.text,
            seq: e.seq,
            epistemic: 'reported',
          };
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

function onAgentUsage(state: RunState, e: StoredEventOf<'agent.usage'>) {
  const u = state.usage;
  const lane = e.agentId ?? 'main';
  const prev = ownEntry(u.lastByLane, lane);
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
  setEntry(u.lastByLane, lane, {
    messageId: e.messageId,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheReadTokens: e.cacheReadTokens,
    cacheWriteTokens: e.cacheWriteTokens,
  });
}

function onToolCalled(state: RunState, e: StoredEventOf<'tool.called'>, log: ChangeLog) {
  const existing = ownEntry(state.activities, e.callId);
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
  setEntry(state.activities, e.callId, activity);
  state.activityOrder.push(e.callId);
  state.running.push(e.callId);
  state.counters.toolCalls += 1;
  if (e.input.kind === 'command') state.counters.commands += 1;
  turn?.activityIds.push(e.callId);
  const lane = e.agentId ? ownEntry(state.subagents, e.agentId) : undefined;
  if (lane) lane.toolCalls += 1;

  if (e.input.kind === 'question') {
    const q = e.input.questions[0] ?? 'question';
    state.waiting = {
      kind: 'question',
      since: e.ts,
      summary: q,
      seq: e.seq,
      epistemic: 'observed',
    };
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
  const lane = e.agentId ? ownEntry(state.subagents, e.agentId) : undefined;
  if (lane && resultOnlyPlaceholder) lane.toolCalls += 1;
  if (e.input.kind !== 'command' || a.status === 'running' || previousInputKind === 'command')
    return;

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
  const a = ownEntry(state.activities, callId);
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
  let a = ownEntry(state.activities, e.callId);
  if (!a) {
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
    setEntry(state.activities, e.callId, a);
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
        const s = e.result.agentId ? ownEntry(state.subagents, e.result.agentId) : undefined;
        if (s) {
          s.endedAt = s.endedAt ?? e.ts;
          s.lastMessage = s.lastMessage ?? e.result.summaryExcerpt;
        }
      }
      break;
    default:
      break;
  }
  a.result =
    a.input.kind === 'other' && e.result.kind === 'command'
      ? e.result
      : trimResultForState(e.result);
}

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
      const file = ownEntry(state.files, change.path);
      if (!file) continue;
      file.linesAdded += change.linesAdded - old.linesAdded;
      file.linesRemoved += change.linesRemoved - old.linesRemoved;
      state.counters.linesAdded += change.linesAdded - old.linesAdded;
      state.counters.linesRemoved += change.linesRemoved - old.linesRemoved;
      file.lastHunks = change.hunks?.slice(0, 20);
      if (change.linesRemovedUnknown) markRemovedUnknown(state, file);
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

function onToolFailed(state: RunState, e: StoredEventOf<'tool.failed'>, log: ChangeLog) {
  onToolFailedInner(state, e, log);
  const a = ownEntry(state.activities, e.callId);
  if (a) {
    a.errorExcerpt = a.errorExcerpt === undefined ? undefined : clip(a.errorExcerpt, 400);
    if (a.result?.kind === 'command')
      a.result = { ...a.result, outputExcerpt: clip(a.result.outputExcerpt, 240) };
  }
}

function onToolFailedInner(state: RunState, e: StoredEventOf<'tool.failed'>, log: ChangeLog) {
  let a = ownEntry(state.activities, e.callId);
  if (!a) {
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
    setEntry(state.activities, e.callId, a);
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
  state.git.dirtyCount = e.dirty ? e.dirty.length + (e.dirtyTruncated ? 1 : 0) : undefined;
  state.git.snapshotAt = e.ts;
  if (!state.repoRoot) state.repoRoot = e.repoRoot;
  const anchor = { root: e.repoRoot, head: e.head, branch: e.branch, at: e.ts };
  if (e.trigger === 'session.started' && !state.git.atStart) state.git.atStart = anchor;
  if (e.trigger === 'turn.ended') state.git.atTurnEnd = anchor;
  if (e.head && prevHead && e.head !== prevHead) {
    const known = state.git.commits.find(
      (c) => c.sha && (e.head?.startsWith(c.sha) || c.sha.startsWith(e.head ?? '')),
    );
    if (known) {
      if (known.sha.length < e.head.length) known.sha = e.head;
    } else {
      state.git.headMoves.push({ from: prevHead, to: e.head, at: e.ts });
      log.add('what', `HEAD moved to ${shortSha(e.head)}`, 'observed', {
        sha: e.head,
        branch: e.branch,
      });
    }
  }
}
