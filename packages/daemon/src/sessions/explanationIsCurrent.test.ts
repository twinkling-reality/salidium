import { describe, expect, it } from 'vitest';
import { explanationIsCurrent } from './sessionCoordinator.ts';

/**
 * This predicate decides whether opening a session spends a `claude -p` call. An off-by-one here
 * is invisible on screen — you get an explanation either way — so it is pinned rather than left to
 * be noticed in a token bill.
 */
describe('explanationIsCurrent', () => {
  it('is false when there is no explanation', () => {
    expect(explanationIsCurrent(42, undefined)).toBe(false);
  });

  it('is true immediately after the explanation lands', () => {
    // Written from seq 41, ingested as seq 42: the only event since is the explanation itself.
    expect(explanationIsCurrent(42, 41)).toBe(true);
  });

  it('is true for an explanation reloaded from a checkpoint', () => {
    expect(explanationIsCurrent(41, 41)).toBe(true);
  });

  it('is false once the agent has done anything since', () => {
    expect(explanationIsCurrent(43, 41)).toBe(false);
    expect(explanationIsCurrent(120, 41)).toBe(false);
  });
});
