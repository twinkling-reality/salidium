import type { CanonicalEvent, StoredEvent } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { cloneState, replayEvents } from '../history/replay.ts';
import { createInitialState, REDUCER_VERSION } from './createInitialState.ts';
import { applyEvent } from './reducer.ts';
import type { RunState } from './runState.ts';

/**
 * Token consumption, folded from `agent.usage`.
 *
 * The whole weight of these tests is on one property: a message id that repeats REPLACES what its
 * lane last contributed. Claude Code stamps one API response's usage onto every transcript record
 * it split that response across, so a naive sum would print a duplicated number as observed fact.
 */

const SESSION = 'claude-code:usage-session';

function fresh(): RunState {
  return createInitialState({
    sessionId: SESSION,
    provider: 'claude-code',
    providerSessionId: 'usage-session',
    cwd: '/repo/app',
  });
}

let seq = 0;

function usage(
  record: string,
  messageId: string,
  figures: [number, number, number, number],
  agentId?: string,
): StoredEvent {
  const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = figures;
  const event: CanonicalEvent = {
    id: `${SESSION}#usage:${record}`,
    sessionId: SESSION,
    ts: '2026-08-18T10:00:00.000Z',
    tsSource: 'provider',
    agentId,
    source: { provider: 'claude-code', channel: 'transcript' },
    kind: 'agent.usage',
    messageId,
    model: 'claude-haiku-4-5-20251001',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
  return { ...event, seq: seq++ } as StoredEvent;
}

function run(events: StoredEvent[], state = fresh()) {
  for (const e of events) applyEvent(state, e);
  return state;
}

describe('reducer: agent.usage', () => {
  it('sums one response per message id and counts responses, not records', () => {
    const state = run([
      usage('r1', 'msg_a', [10, 200, 5000, 300]),
      usage('r2', 'msg_b', [2, 40, 9000, 0]),
    ]);
    expect(state.usage.messages).toBe(2);
    expect(state.usage.inputTokens).toBe(12);
    expect(state.usage.outputTokens).toBe(240);
    expect(state.usage.cacheReadTokens).toBe(14_000);
    expect(state.usage.cacheWriteTokens).toBe(300);
  });

  it('replaces rather than adds when one response arrives across several records', () => {
    // The shape measured in every real transcript: the figures grow as the response completes,
    // and the record that lands last carries the whole of it.
    const state = run([
      usage('r1', 'msg_a', [10, 4, 23_586, 9694]),
      usage('r2', 'msg_a', [10, 142, 23_586, 9694]),
      usage('r3', 'msg_a', [10, 3906, 23_586, 9694]),
    ]);
    expect(state.usage.messages).toBe(1);
    expect(state.usage.outputTokens).toBe(3906);
    expect(state.usage.cacheReadTokens).toBe(23_586);
    // Summing the three records would give 4052 output and 70,758 cache reads.
    expect(state.usage.outputTokens).not.toBe(4052);
  });

  it('keeps one lane apart from another when their records interleave', () => {
    // Subagent transcripts are separate tailed sources feeding one session, so their records land
    // interleaved in sequence order. A single cursor would see the message id flip away and back
    // and stop replacing, which re-inflates the totals — here, to 300 instead of 200.
    const state = run([
      usage('r1', 'msg_a', [0, 50, 0, 0]),
      usage('s1', 'msg_b', [0, 70, 0, 0], 'sub-1'),
      usage('r2', 'msg_a', [0, 130, 0, 0]),
      usage('s2', 'msg_b', [0, 70, 0, 0], 'sub-1'),
    ]);
    expect(state.usage.messages).toBe(2);
    expect(state.usage.outputTokens).toBe(200);
    expect(state.usage.lastByLane.main?.messageId).toBe('msg_a');
    expect(state.usage.lastByLane['sub-1']?.messageId).toBe('msg_b');
  });

  it('is idempotent: replaying an event already applied changes nothing', () => {
    const state = fresh();
    const events = [usage('r1', 'msg_a', [1, 100, 10, 20]), usage('r2', 'msg_a', [1, 400, 10, 20])];
    run(events, state);
    const before = JSON.stringify(state.usage);
    for (const e of events) applyEvent(state, e);
    expect(JSON.stringify(state.usage)).toBe(before);
  });

  it('survives a checkpoint: state resumed from a clone matches a full replay', () => {
    const events = [
      usage('r1', 'msg_a', [10, 4, 23_586, 9694]),
      usage('r2', 'msg_a', [10, 3906, 23_586, 9694]),
      usage('r3', 'msg_b', [3, 512, 30_000, 0]),
      usage('r4', 'msg_b', [3, 900, 30_000, 0]),
    ];
    const full = run(events);
    // A checkpoint taken mid-response is the case that matters: `lastByLane` has to be in it, or
    // the resumed state adds the completing record instead of replacing with it.
    const checkpoint = run(events.slice(0, 3));
    const resumed = replayEvents(cloneState(checkpoint), events.slice(3)).state;
    expect(resumed.usage).toEqual(full.usage);
    expect(full.usage.outputTokens).toBe(4806);
  });

  it('starts at zero and carries the reducer version that derives it', () => {
    expect(fresh().usage).toEqual({
      messages: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastByLane: {},
    });
    // Summing usage is new derivation, so every checkpoint written before it is stale. This
    // assertion exists to make the bump deliberate: change it in the same edit as the version.
    expect(REDUCER_VERSION).toBe('1.12.0');
    expect(fresh().reducerVersion).toBe(REDUCER_VERSION);
  });
});
