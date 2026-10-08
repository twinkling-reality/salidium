import type { ActivityRow, TurnRow, VerificationRow } from '@salidium/core';
import { describe, expect, it } from 'vitest';
import { timelineBadges, turnPalette } from './timelineAppearance.ts';

const at = (minute: number) => `2026-10-07T09:${String(minute).padStart(2, '0')}:00.000Z`;
const stops = (minutes: number[]) => minutes.map((minute) => ({ ts: at(minute), seq: minute }));
const activity = (
  minute: number,
  kind: ActivityRow['kind'] = 'command',
  callId = `call-${minute}`,
): ActivityRow => ({
  callId,
  kind,
  title: `${kind} ${minute}`,
  toolName: kind,
  startedAt: at(minute),
  status: 'completed',
  isVerification: false,
  eventIds: [],
});
const turn = (id: string, activities: ActivityRow[], startedAt = at(0)): TurnRow => ({
  id,
  index: 0,
  prompt: 'Recorded request',
  startedAt,
  activityCount: activities.length,
  activities,
  verifications: [],
  files: [],
  linesAdded: 0,
  linesRemoved: 0,
  claims: [],
});
const check = (minute: number, outcome: VerificationRow['outcome']): VerificationRow => ({
  id: `check-${minute}`,
  callId: `call-${minute}`,
  at: at(minute),
  label: `Tests at ${minute}`,
  method: 'test',
  outcome,
  scope: 'full',
  exit: { observation: 'unknown' },
  epistemic: 'observed',
  caveats: [],
  stale: false,
  command: 'test',
});

describe('timeline appearance', () => {
  it('keeps each turn identity in a bounded palette independently of history and layout', () => {
    const palette = turnPalette('session/turn-123');
    expect(palette).toBeGreaterThanOrEqual(0);
    expect(palette).toBeLessThan(5);
    expect(Number.isInteger(palette)).toBe(true);
    const turns = [turn('session/turn-123', [activity(4)])];
    expect(timelineBadges(turns, [], [], stops([4]), 320)[0]?.palette).toBe(palette);
    expect(timelineBadges(turns, [], [], stops([1, 2, 4, 5]), 1200)[0]?.palette).toBe(palette);
  });

  it('targets the first state containing an event, with live after the final recorded stop', () => {
    const badges = timelineBadges(
      [],
      [check(3, 'pass'), check(9, 'fail')],
      [],
      stops([2, 4, 8]),
      1000,
    );
    expect(badges.map((badge) => [badge.index, badge.target, badge.f])).toEqual([
      [1, 1, 1 / 3],
      [3, 3, 1],
    ]);
  });

  it('represents a check or commit once instead of duplicating its underlying command', () => {
    const badges = timelineBadges(
      [turn('a', [activity(1), activity(5)])],
      [check(1, 'pass')],
      [{ sha: 'abcdefgh123', at: at(5), callId: 'call-5' }],
      stops([1, 2, 3, 4, 5]),
      1000,
    );
    expect(badges.map((badge) => badge.icon)).toEqual(['check', 'commit']);
    expect(badges.every((badge) => !badge.label.includes('recorded events'))).toBe(true);
  });

  it('keeps a failure visible in a dense mixed group and labels it as multiple events', () => {
    const badges = timelineBadges(
      [turn('a', [activity(2, 'fileEdit')])],
      [check(1, 'pass'), check(3, 'fail')],
      [{ sha: '12345678', at: at(4) }],
      stops([1, 2, 3, 4]),
      40,
    );
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({ icon: 'flag', tone: 'fail', target: 2, count: 4 });
    expect(badges[0]?.label).toContain('4 recorded events: Failed check');
    expect(badges[0]?.label).toContain('1 more');
  });

  it('keeps exact badge anchors separated and limits density even on a wide display', () => {
    const minutes = Array.from({ length: 50 }, (_, index) => index);
    const turns = [
      turn(
        'dense',
        minutes.map((minute) => activity(minute)),
      ),
    ];
    for (const width of [320, 1200, 2400]) {
      const badges = timelineBadges(turns, [], [], stops(minutes), width);
      expect(badges.reduce((sum, badge) => sum + badge.count, 0)).toBe(minutes.length);
      const pitch = Math.max(44, width / 10);
      expect(badges.length).toBeLessThanOrEqual(11);
      for (let index = 1; index < badges.length; index += 1) {
        const distance = ((badges[index]?.f ?? 0) - (badges[index - 1]?.f ?? 0)) * (width - 16);
        expect(distance).toBeGreaterThanOrEqual(pitch - 0.0001);
      }
      for (const badge of badges) expect(badge.f).toBe(badge.target / minutes.length);
    }
  });

  it('maps observed work kinds without inferring success from a completed turn', () => {
    const kinds: ActivityRow['kind'][] = ['fileEdit', 'command', 'subagent', 'plan', 'fileRead'];
    const turns = [
      {
        ...turn(
          'a',
          kinds.map((kind, index) => activity(index, kind)),
        ),
        outcome: 'completed' as const,
      },
    ];
    const badges = timelineBadges(turns, [], [], stops([0, 1, 2, 3, 4]), 1000);
    expect(badges.map((badge) => badge.icon)).toEqual([
      'edit',
      'terminal',
      'delegate',
      'plan',
      'record',
    ]);
    expect(badges.every((badge) => badge.tone === 'work')).toBe(true);
  });

  it('associates delayed check evidence with its owning turn rather than its timestamp neighbor', () => {
    const earlier = turn('earlier', [activity(1)]);
    const later = { ...turn('later', [], at(5)), index: 1 };
    const delayed = { ...check(6, 'pass'), callId: 'call-1' };
    const badges = timelineBadges([earlier, later], [delayed], [], stops([1, 5, 6]), 1000);
    expect(badges[0]?.palette).toBe(turnPalette('earlier'));
  });

  it('distinguishes partial and unreadable checks without labelling either as passed', () => {
    const badges = timelineBadges(
      [],
      [check(1, 'partial'), check(4, 'unknown')],
      [],
      stops([1, 2, 3, 4]),
      1000,
    );
    expect(badges.map((badge) => badge.icon)).toEqual(['auto', 'help']);
    expect(badges.every((badge) => badge.tone === 'work')).toBe(true);
    expect(badges[0]?.label).toContain('conflicting evidence');
    expect(badges[1]?.label).toContain('unknown outcome');
  });

  it('has no interactive event position before any replay stop exists', () => {
    expect(timelineBadges([turn('a', [activity(1)])], [], [], [], 1000)).toEqual([]);
  });
});
