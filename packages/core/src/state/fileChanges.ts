import type { FileChange, StoredEvent, StoredEventOf } from '@salidium/protocol';
import { basename, type ChangeLog, clip } from './changeLog.ts';
import { ownEntry, setEntry } from './keyedRecord.ts';
import type { Activity, FileState, RunState, Turn } from './runState.ts';

/**
 * Sticky: once any change replaced a file without saying what it held, its removed count and the
 * session's are lower bounds, whatever exact changes follow.
 */
export function markRemovedUnknown(state: RunState, file: FileState): void {
  file.linesRemovedUnknown = true;
  state.counters.linesRemovedUnknown = true;
}

export function changeVerb(kind: FileChange['change']): string {
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
export function trimResultForState(
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

export function inferKindFromResult(e: StoredEventOf<'tool.completed'>): Activity['kind'] {
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

export function applyFileChange(
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
  const existing = ownEntry(state.files, change.path);
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
    setEntry(state.files, change.path, file);
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
  if (change.linesRemovedUnknown) markRemovedUnknown(state, file);
  if (turn && !file.turnIds.includes(turn.id)) file.turnIds.push(turn.id);
  if (turn && !turn.filesTouched.includes(change.path)) turn.filesTouched.push(change.path);
  state.counters.linesAdded += change.linesAdded;
  state.counters.linesRemoved += change.linesRemoved;
  for (const v of state.verifications) if (v.at <= e.ts) v.stale = true;

  const verb = changeVerb(change.change);
  const delta =
    change.change === 'delete' ? '' : ` (+${change.linesAdded} −${change.linesRemoved})`;
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
