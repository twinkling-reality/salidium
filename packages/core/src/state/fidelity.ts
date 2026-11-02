import type { StoredEvent, StoredEventOf } from '@salidium/protocol';
import { ownEntry, setEntry } from './keyedRecord.ts';
import type { Activity, RunState } from './runState.ts';

export function sourceFidelity(e: StoredEvent): number {
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

export function callFidelity(e: StoredEventOf<'tool.called'>): number {
  return (e.input.kind === 'other' ? 0 : 100) + sourceFidelity(e);
}

export function completionFidelity(e: StoredEventOf<'tool.completed'>): number {
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

export function failureFidelity(e: StoredEventOf<'tool.failed'>): number {
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

/**
 * True for a tool event that belongs to a call folded into its parent, which then only remembers
 * the event for drill-through.
 */
export function absorbed(state: RunState, e: StoredEvent): boolean {
  if (e.kind !== 'tool.called' && e.kind !== 'tool.completed' && e.kind !== 'tool.failed')
    return false;
  let parentId = ownEntry(state.absorbedCalls, e.callId);
  if (
    !parentId &&
    e.kind === 'tool.called' &&
    e.parentCallId &&
    !ownEntry(state.activities, e.callId) &&
    ownEntry(state.activities, e.parentCallId)?.kind === 'command'
  ) {
    parentId = e.parentCallId;
    setEntry(state.absorbedCalls, e.callId, parentId);
  }
  if (!parentId) return false;
  const parent = ownEntry(state.activities, parentId);
  if (parent) rememberEventId(parent, e.id);
  return true;
}

export function rememberEventId(a: Activity, id: string): void {
  if (!a.eventIds.includes(id)) a.eventIds.push(id);
  a.eventIds.sort((left, right) => left.localeCompare(right));
}

export type TerminalVerdict = 'pass' | 'fail' | 'unknown';

export function commandVerdict(exit: Activity['exit'], isError: boolean): TerminalVerdict {
  if (isError) return 'fail';
  if (exit?.observation === 'inferred-failure') return 'fail';
  if (exit?.observation === 'inferred-success') return 'pass';
  if (exit?.observation === 'explicit') return exit.code === 0 ? 'pass' : 'fail';
  return 'unknown';
}

export function terminalVerdictsConflict(a: TerminalVerdict, b: TerminalVerdict): boolean {
  return (a === 'pass' && b === 'fail') || (a === 'fail' && b === 'pass');
}

export function failedEventVerdict(e: StoredEventOf<'tool.failed'>): TerminalVerdict {
  return e.cause === 'timeout' ||
    e.cause === 'interrupted' ||
    e.cause === 'rejected' ||
    e.cause === 'denied'
    ? 'unknown'
    : 'fail';
}

export function msBetween(a: string, b: string): number | undefined {
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (Number.isNaN(t1) || Number.isNaN(t2) || t2 < t1) return undefined;
  return t2 - t1;
}

export function maxTs(a: string | undefined, b: string): string {
  if (!a) return b;
  return b > a ? b : a;
}
