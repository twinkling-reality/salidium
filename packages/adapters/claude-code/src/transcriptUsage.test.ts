import { applyEvent, createInitialState } from '@salidium/core';
import {
  type CanonicalEvent,
  CanonicalEventSchema,
  makeSessionId,
  type StoredEvent,
} from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { claudeCodeAdapter } from './claudeCodeAdapter.ts';

/**
 * `agent.usage`, from the `usage` object on assistant records. These synthetic records preserve
 * Claude Code's shape: one record per
 * content block, the whole response's usage repeated on each, and the figures still growing on the
 * early ones — which is the only reason any of this is more complicated than reading a number.
 */

const PID = 'usage-transcript';
const SESSION = makeSessionId('claude-code', PID);

function record(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

/** One assistant record: `usage` is the response's, `block` is this record's single content block. */
function assistant(
  uuid: string,
  messageId: string,
  usage: Record<string, number>,
  block: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return record({
    type: 'assistant',
    uuid,
    timestamp: '2026-08-18T10:00:00.000Z',
    cwd: '/repo/app',
    ...extra,
    message: {
      id: messageId,
      model: 'claude-haiku-4-5-20251001',
      content: [block],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        ...usage,
      },
    },
  });
}

function parse(lines: string[], path = '/tmp/usage.jsonl', agentId?: string): CanonicalEvent[] {
  const parser = claudeCodeAdapter.createRecordParser({
    sessionId: SESSION,
    providerSessionId: PID,
    path,
    agentId,
    observedAt: '2026-08-19T00:00:00.000Z',
  });
  return lines.flatMap((l, i) => parser.parseRecord(l, i + 1));
}

const usageOf = (events: CanonicalEvent[]) => events.filter((e) => e.kind === 'agent.usage');

describe('transcript parser: agent.usage', () => {
  const thinking = { type: 'thinking', thinking: 'weighing the options' };
  const text = { type: 'text', text: 'Reading the auth middleware.' };
  const toolUse = { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/a.ts' } };

  it('emits one schema-valid event per record, keyed on the record and naming the response', () => {
    const events = parse([
      assistant('u1', 'msg_a', { input_tokens: 10, output_tokens: 200 }, text),
      assistant('u2', 'msg_b', { input_tokens: 3, output_tokens: 40 }, toolUse),
    ]);
    const u = usageOf(events);
    expect(u).toHaveLength(2);
    for (const e of u) expect(() => CanonicalEventSchema.parse(e)).not.toThrow();
    expect(u.map((e) => e.id)).toEqual([`${SESSION}#usage:u1`, `${SESSION}#usage:u2`]);
    expect(u.map((e) => e.kind === 'agent.usage' && e.messageId)).toEqual(['msg_a', 'msg_b']);
    expect(u[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 200,
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('emits for a thinking-only record, which produces no other event at all', () => {
    // Thinking-only records prove why usage needs a separate event rather than another event's field.
    const events = parse([assistant('u1', 'msg_a', { output_tokens: 900 }, thinking)]);
    // Nothing the record itself said reaches the log: a thinking block is a length, not an event.
    expect(events.map((e) => e.kind)).toEqual([
      'session.started',
      'session.updated',
      'agent.usage',
    ]);
    expect(usageOf(events)).toHaveLength(1);
  });

  it('drops an unchanged repeat of the same response, and re-emits when the figures move', () => {
    const events = parse([
      assistant('u1', 'msg_a', { input_tokens: 10, output_tokens: 4 }, thinking),
      assistant('u2', 'msg_a', { input_tokens: 10, output_tokens: 4 }, text),
      assistant('u3', 'msg_a', { input_tokens: 10, output_tokens: 3906 }, toolUse),
    ]);
    const u = usageOf(events);
    expect(u.map((e) => e.id)).toEqual([`${SESSION}#usage:u1`, `${SESSION}#usage:u3`]);
  });

  it('regenerates exactly the same ids on a full re-parse, so re-ingest stays free', () => {
    const lines = [
      assistant('u1', 'msg_a', { output_tokens: 4 }, thinking),
      assistant('u2', 'msg_a', { output_tokens: 4 }, text),
      assistant('u3', 'msg_a', { output_tokens: 3906 }, toolUse),
    ];
    expect(usageOf(parse(lines)).map((e) => e.id)).toEqual(usageOf(parse(lines)).map((e) => e.id));
  });

  it('says nothing for an API error record, whose usage is four zeroes in every real case', () => {
    const events = parse([
      assistant(
        'u1',
        'msg_a',
        {},
        { type: 'text', text: 'API Error' },
        {
          isApiErrorMessage: true,
        },
      ),
    ]);
    expect(usageOf(events)).toHaveLength(0);
  });

  it('stamps a subagent lane, so its tokens are attributed and not merged with the main lane', () => {
    const events = parse(
      [assistant('u1', 'msg_a', { output_tokens: 70 }, toolUse)],
      '/tmp/sub.jsonl',
      'sub-1',
    );
    expect(usageOf(events)[0]).toMatchObject({ agentId: 'sub-1', outputTokens: 70 });
  });

  it('folds into RunState as the response total, not the record total', () => {
    const events = parse([
      assistant(
        'u1',
        'msg_a',
        { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 23586 },
        thinking,
      ),
      assistant(
        'u2',
        'msg_a',
        { input_tokens: 10, output_tokens: 3906, cache_read_input_tokens: 23586 },
        toolUse,
      ),
      assistant(
        'u3',
        'msg_b',
        { input_tokens: 2, output_tokens: 404, cache_creation_input_tokens: 34462 },
        text,
      ),
    ]);
    const state = createInitialState({
      sessionId: SESSION,
      provider: 'claude-code',
      providerSessionId: PID,
    });
    for (const [i, e] of events.entries()) applyEvent(state, { ...e, seq: i } as StoredEvent);
    expect(state.usage.messages).toBe(2);
    expect(state.usage.outputTokens).toBe(4310); // 3906 + 404, not 4310 + 4
    expect(state.usage.cacheReadTokens).toBe(23_586); // counted once, not twice
    expect(state.usage.cacheWriteTokens).toBe(34_462);
    expect(state.usage.inputTokens).toBe(12);
  });
});
