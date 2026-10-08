import type { ActivityRow, CommitRow, TurnRow, VerificationRow } from '@salidium/core';
import type { IconName } from './Icon.tsx';
import { stopAt, type TimelineStop } from './timelineStops.ts';

/** Identity color survives selection, resizing, and replacement of a partial change history. */
export function turnPalette(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619) >>> 0;
  }
  return hash % 5;
}

export interface TimelineBadge {
  /** Exact native-range position of the representative event; stops.length is the live endpoint. */
  index: number;
  target: number;
  f: number;
  label: string;
  count: number;
  icon: IconName;
  palette: number;
  tone: 'fail' | 'pass' | 'commit' | 'work';
}

type Candidate = TimelineBadge & { at: string; priority: number; key: string };

/** Same recorded tool-kind vocabulary as SessionFlow; no phase or outcome inferred from prose. */
const WORK: Record<ActivityRow['kind'], { icon: IconName; label: string; priority: number }> = {
  fileEdit: { icon: 'edit', label: 'File edit', priority: 3 },
  fileWrite: { icon: 'edit', label: 'File write', priority: 3 },
  fileRead: { icon: 'record', label: 'File read', priority: 4 },
  search: { icon: 'search', label: 'Search', priority: 4 },
  command: { icon: 'terminal', label: 'Command', priority: 4 },
  subagent: { icon: 'delegate', label: 'Delegation', priority: 4 },
  webFetch: { icon: 'search', label: 'Web lookup', priority: 4 },
  webSearch: { icon: 'search', label: 'Web search', priority: 4 },
  mcp: { icon: 'search', label: 'Connected tool', priority: 4 },
  plan: { icon: 'plan', label: 'Plan', priority: 4 },
  question: { icon: 'help', label: 'Question', priority: 4 },
  other: { icon: 'record', label: 'Tool activity', priority: 4 },
};

/**
 * A sparse drawing over the unchanged exact-stop axis. Each representative remains at a real
 * selectable state. Nearby events join a labelled group; they do not become a turn-wide verdict.
 */
export function timelineBadges(
  turns: TurnRow[],
  checks: VerificationRow[],
  commits: CommitRow[],
  stops: TimelineStop[],
  width: number,
  thumb = 16,
): TimelineBadge[] {
  if (stops.length === 0) return [];
  const orderedTurns = [...turns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const turnByCall = new Map<string, TurnRow>();
  const turnByIndex = new Map(turns.map((turn) => [turn.index, turn]));
  for (const turn of turns) {
    for (const activity of turn.activities) turnByCall.set(activity.callId, turn);
    for (const check of turn.verifications) turnByCall.set(check.callId, turn);
  }
  const turnAt = (at: string) => orderedTurns.findLast((turn) => turn.startedAt <= at);
  const candidates: Candidate[] = [];
  const add = (
    at: string,
    key: string,
    label: string,
    icon: IconName,
    tone: TimelineBadge['tone'],
    priority: number,
    turn: TurnRow | undefined,
  ) => {
    const before = stopAt(stops, at);
    // Some checks produce no semantic-change row. The prior stop would show a state before the
    // evidence existed, so select the next available state, or live after the final stop.
    const index = stops[before]?.ts === at ? before : before + 1;
    candidates.push({
      index,
      target: index,
      f: index / stops.length,
      label,
      count: 1,
      icon,
      tone,
      palette: turnPalette(turn?.id ?? 'unassigned'),
      at,
      key,
      priority,
    });
  };

  const specialCalls = new Set<string>(checks.map((check) => check.callId));
  for (const commit of commits) if (commit.callId) specialCalls.add(commit.callId);
  const seenActivities = new Set<string>();
  for (const turn of turns) {
    for (const activity of turn.activities) {
      if (specialCalls.has(activity.callId) || seenActivities.has(activity.callId)) continue;
      seenActivities.add(activity.callId);
      const kind = WORK[activity.kind];
      // ActivityRow exposes start time, not a reliable completion timestamp. Describe the kind
      // of recorded operation; do not backdate its later success or failure to its start.
      add(
        activity.startedAt,
        `activity:${activity.callId}`,
        `${kind.label}: ${activity.title}`,
        kind.icon,
        'work',
        kind.priority,
        turn,
      );
    }
  }
  for (const check of checks) {
    const turn =
      (check.turnIndex === undefined ? undefined : turnByIndex.get(check.turnIndex)) ??
      turnByCall.get(check.callId) ??
      turnAt(check.at);
    const failed = check.outcome === 'fail';
    const passed = check.outcome === 'pass';
    const outcome = failed
      ? 'Failed check'
      : passed
        ? 'Passed check'
        : check.outcome === 'partial'
          ? 'Check with conflicting evidence'
          : 'Check with unknown outcome';
    add(
      check.at,
      `check:${check.id}`,
      `${outcome}: ${check.label}`,
      failed ? 'flag' : passed ? 'check' : check.outcome === 'partial' ? 'auto' : 'help',
      failed ? 'fail' : passed ? 'pass' : 'work',
      failed ? 0 : passed ? 1 : 4,
      turn,
    );
  }
  for (const commit of commits) {
    add(
      commit.at,
      `commit:${commit.sha}:${commit.at}`,
      `Commit: ${commit.sha.slice(0, 8)}`,
      'commit',
      'commit',
      2,
      (commit.callId ? turnByCall.get(commit.callId) : undefined) ?? turnAt(commit.at),
    );
  }

  const travel = Math.max(0, width - thumb);
  const pitch = Math.max(44, width / 10);
  const groups: Array<{ representative: Candidate; events: Candidate[] }> = [];
  // Choose important representatives first, then attach nearby events to them. Their anchors do
  // not move, so choosing a later failure cannot push its badge into the next group's badge.
  candidates.sort(
    (a, b) => a.priority - b.priority || a.index - b.index || a.key.localeCompare(b.key),
  );
  for (const candidate of candidates) {
    let closest: (typeof groups)[number] | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const group of groups) {
      const distance = Math.abs(candidate.f - group.representative.f) * travel;
      if (distance < pitch && distance < closestDistance) {
        closest = group;
        closestDistance = distance;
      }
    }
    if (closest) closest.events.push(candidate);
    else groups.push({ representative: candidate, events: [candidate] });
  }
  return groups
    .sort((a, b) => a.representative.index - b.representative.index)
    .map(({ representative, events }) => {
      const { index, target, f, label, icon, palette, tone } = representative;
      const groupedLabel =
        events.length === 1
          ? label
          : `${events.length} recorded events: ${events
              .slice(0, 3)
              .map((event) => event.label)
              .join('; ')}${events.length > 3 ? `; ${events.length - 3} more` : ''}`;
      return { index, target, f, label: groupedLabel, count: events.length, icon, palette, tone };
    });
}
