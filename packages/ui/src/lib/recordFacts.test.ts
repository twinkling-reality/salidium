import type { CanonicalEventKind, StoredEvent } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import { exitText, recordFacts } from './recordFacts.ts';

/** The envelope every canonical event carries, in the shape the store actually holds. */
const base = {
  id: 'claude-code:s1#tool:call-1:call',
  sessionId: 'claude-code:s1',
  ts: '2026-08-18T01:36:09.639Z',
  tsSource: 'provider',
  turnId: 'turn-1',
  source: {
    provider: 'claude-code',
    channel: 'transcript',
    version: '2.1.233',
    ref: { path: '/home/x/.claude/projects/p/s1.jsonl', line: 9 },
  },
  seq: 42,
} as const;

const ev = (rest: Record<string, unknown>): StoredEvent =>
  ({ ...base, ...rest }) as unknown as StoredEvent;

const value = (e: StoredEvent, label: string): string | undefined =>
  recordFacts(e).facts.find((f) => f.label === label)?.value;

describe('recordFacts', () => {
  it('leads a Bash call with the command, which the raw blob buries on line 22', () => {
    const e = ev({
      kind: 'tool.called',
      callId: 'call-1',
      toolName: 'Bash',
      title: 'Run pnpm test',
      input: {
        kind: 'command',
        command: 'pnpm test',
        description: 'Run the test suite',
        cwd: '/repo',
      },
    });
    const { title, facts } = recordFacts(e);
    expect(title).toBe('Command run');
    expect(facts[0]).toMatchObject({
      label: 'Command',
      value: 'pnpm test',
      mono: true,
      copy: true,
    });
    expect(value(e, 'Why')).toBe('Run the test suite');
    expect(value(e, 'In')).toBe('/repo');
    expect(value(e, 'Tool')).toBe('Bash');
  });

  it('names the pieces of a command result, and says how long the output was', () => {
    const e = ev({
      kind: 'tool.completed',
      callId: 'call-1',
      toolName: 'Bash',
      isError: false,
      durationMs: 1200,
      result: {
        kind: 'command',
        exit: { code: 0, observation: 'explicit' },
        outputExcerpt: '161 passed',
        outputChars: 3200,
        truncated: true,
      },
    });
    expect(recordFacts(e).title).toBe('Command finished');
    expect(value(e, 'Exit')).toBe('0');
    expect(value(e, 'Output')).toBe('161 passed');
    expect(recordFacts(e).facts.find((f) => f.label === 'Output')?.note).toBe(
      'excerpt of 3200 characters',
    );
    expect(value(e, 'Took')).toBe('1200 ms');
  });

  /*
   * The one rule this module may not break. "Unknown" and "inferred" are first-class in the
   * protocol because Claude Code records no exit code for a successful Bash call and Codex hides
   * the nested shell's; printing a bare 0 for either would assert something the record does not
   * contain, on the screen whose whole job is to let a reader check the record.
   */
  it('never turns an unread exit code into a verdict', () => {
    expect(exitText({ observation: 'unknown' })).toEqual({
      value: 'unknown',
      note: 'the record does not say',
    });
    expect(exitText({ code: 0, observation: 'inferred-success' })).toEqual({
      value: '0',
      note: 'inferred, not reported',
    });
    expect(exitText({ code: 1, observation: 'explicit' }).note).toBeUndefined();
  });

  it('keeps a caveat beside the value rather than folded into it', () => {
    const e = ev({
      kind: 'tool.completed',
      callId: 'c',
      toolName: 'Bash',
      isError: false,
      result: {
        kind: 'command',
        exit: { observation: 'unknown' },
        outputExcerpt: '',
        outputChars: 0,
        truncated: false,
      },
    });
    const exit = recordFacts(e).facts.find((f) => f.label === 'Exit');
    expect(exit).toMatchObject({ value: 'unknown', note: 'the record does not say' });
  });

  it('reports a receipt time as a receipt time', () => {
    const e = ev({ kind: 'session.ended', tsSource: 'ingest', reason: 'exit' });
    const when = recordFacts(e).origin.find((f) => f.label === 'When');
    expect(when?.note).toBe('when Salidium received it, not when it happened');
    expect(
      recordFacts(ev({ kind: 'session.ended' })).origin.find((f) => f.label === 'When')?.note,
    ).toBeUndefined();
  });

  it('marks a generated explanation as generated', () => {
    const e = ev({
      kind: 'salidium.explanation',
      basedOnSeq: 40,
      model: 'claude-opus-5',
      what: { summary: 'It fixed the parser.', currently: null },
      why: { summary: '', lanes: [], chain: [] },
      how: {},
    });
    const summary = recordFacts(e).facts.find((f) => f.label === 'Summary');
    expect(summary?.note).toBe('generated, not observed');
  });

  it('keeps several questions as one fact rather than rows with no label', () => {
    const e = ev({
      kind: 'tool.called',
      callId: 'c',
      toolName: 'AskUserQuestion',
      title: 'Ask',
      input: { kind: 'question', questions: ['Which one?', 'And when?'] },
    });
    const { facts } = recordFacts(e);
    expect(facts.filter((f) => f.label === '')).toHaveLength(0);
    expect(value(e, 'Asked')).toBe('Which one?\nAnd when?');
  });

  it('labels a dirty path whose porcelain code is blank', () => {
    const e = ev({
      kind: 'git.snapshot',
      repoRoot: '/repo',
      dirty: [
        { path: 'src/a.ts', status: ' M' },
        { path: 'src/b.ts', status: '  ' },
      ],
    });
    expect(recordFacts(e).facts.map((f) => f.label)).toEqual([
      'Repository',
      'Dirty',
      'M',
      'unchanged',
    ]);
  });

  it('says a suppressed read is suppressed instead of showing nothing', () => {
    const e = ev({
      kind: 'tool.completed',
      callId: 'c',
      toolName: 'Read',
      isError: false,
      result: { kind: 'fileRead', path: '/repo/.env', suppressed: true },
    });
    expect(value(e, 'Contents')).toBe('withheld: this path holds credentials');
  });

  /*
   * Every kind gets a title and a well-formed set of rows, so a kind added to the protocol later
   * cannot quietly render as a blank panel with a copy button on it.
   */
  /**
   * Tokens are observed and money is not. The provider reported these four numbers, so they are
   * printed as fact; a dollar figure would be Salidium's own arithmetic over a price table this
   * drawer does not hold, and on a subscription no dollar is charged for the call at all. The
   * record also had no case at all until now, so the drawer opened it as a bare "Record".
   */
  it('prints a model call’s tokens as fact, and prints no money', () => {
    const e = ev({
      kind: 'agent.usage',
      messageId: 'msg_01ABC',
      model: 'claude-opus-5',
      inputTokens: 1234,
      outputTokens: 56,
      cacheReadTokens: 109492,
      cacheWriteTokens: 0,
    });
    const { title, facts } = recordFacts(e);
    expect(title).toBe('What one model call used');
    expect(value(e, 'Input tokens')).toBe((1234).toLocaleString());
    expect(value(e, 'Output tokens')).toBe((56).toLocaleString());
    expect(value(e, 'Cache read tokens')).toBe((109492).toLocaleString());
    expect(value(e, 'Cache write tokens')).toBe('0');
    expect(value(e, 'Model')).toBe('claude-opus-5');
    expect(value(e, 'Response')).toBe('msg_01ABC');
    // One response's usage rides on every one of its records, so two of them must not be summed.
    expect(facts.find((f) => f.label === 'Response')?.note).toMatch(/one API response/);
    for (const f of facts)
      expect(`${f.label} ${f.value} ${f.note ?? ''}`).not.toMatch(/[$£€¢]|\bUSD\b|cost/i);
  });

  it('gives every event kind a title and no empty rows', () => {
    const kinds: Array<[CanonicalEventKind, Record<string, unknown>]> = [
      ['session.started', { cwd: '/repo' }],
      ['session.updated', { model: 'gpt-5.6' }],
      ['session.ended', {}],
      ['turn.started', { prompt: 'do the thing' }],
      ['turn.ended', { outcome: 'completed' }],
      ['agent.message', { text: 'done' }],
      ['agent.thinking', { chars: 12 }],
      [
        'agent.usage',
        {
          messageId: 'msg_1',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ],
      ['tool.called', { callId: 'c', toolName: 'T', title: 't', input: { kind: 'plan' } }],
      [
        'tool.completed',
        { callId: 'c', toolName: 'T', isError: false, result: { kind: 'generic' } },
      ],
      ['tool.failed', { callId: 'c', toolName: 'T', errorExcerpt: 'boom', cause: 'error' }],
      ['subagent.started', { subagentId: 'a1' }],
      ['subagent.ended', { subagentId: 'a1' }],
      ['plan.updated', { mode: 'replace', items: [{ id: '1', text: 'x', status: 'pending' }] }],
      ['compaction', {}],
      ['permission.requested', { toolName: 'Bash', summary: 'run rm' }],
      ['notification', { message: 'hi' }],
      ['git.snapshot', { repoRoot: '/repo', dirty: [] }],
      ['ingest.warning', { code: 'malformed-record' }],
    ];
    for (const [kind, rest] of kinds) {
      const { title, facts, origin } = recordFacts(ev({ kind, ...rest }));
      expect(title, kind).not.toBe('');
      expect(title, kind).not.toBe('Record');
      for (const f of [...facts, ...origin]) {
        expect(f.label, `${kind} label`).not.toBe('');
        expect(f.value, `${kind} ${f.label}`).not.toBe('');
      }
      expect(
        origin.map((f) => f.label),
        kind,
      ).toContain('When');
      // The record's identity lives in the head line, not twice in the fact list.
      expect(recordFacts(ev({ kind, ...rest })).meta, kind).toMatch(/^seq \d+ · /);
    }
  });
});
