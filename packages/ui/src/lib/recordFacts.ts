import type {
  ExitStatus,
  PlanItemStatus,
  StoredEvent,
  ToolFailureCause,
  ToolInput,
  ToolResult,
} from '@salidium/protocol';

/**
 * One named thing a record says.
 *
 * `mono` follows the app's provenance-by-form rule: measured values are monospace and prose is
 * not, so a command and a sentence about a command never look like the same kind of statement.
 */
export interface Fact {
  label: string;
  value: string;
  /** A measured value: a command, a path, a sha, an exit code, a count. */
  mono?: boolean;
  /** Worth its own copy control — something a reader takes out of here and uses somewhere else. */
  copy?: boolean;
  /** Set in a block under its label rather than on the line beside it: output, prose, a prompt. */
  block?: boolean;
  /** A caveat about the value, printed quietly after it. Never folded into the value itself. */
  note?: string;
}

export interface RecordFacts {
  /** What this record is, in the page's words rather than the schema's. */
  title: string;
  /**
   * Which record, and off which channel — one line for the head, where a reader stepping through
   * the log with the arrow keys is already looking. It is not repeated in `origin`.
   */
  meta: string;
  /** What it says, most useful first. The first entry is the one the reader came for. */
  facts: Fact[];
  /** How Salidium came to have it. Separate, because it answers a different question. */
  origin: Fact[];
}

/**
 * The named facts of one canonical event.
 *
 * The drawer used to be `JSON.stringify(event, null, 2)` and nothing else. Tool records can run to
 * many lines with the useful command or result buried under opaque identifiers. The app exists to
 * do that reading, so it does it here and
 * keeps the whole record one press away rather than making it the only thing on offer.
 *
 * Nothing here judges: every value is copied out of the record or formatted from it. Where the
 * record says "unknown", so does this — `exitText` will not turn an absent exit code into a pass.
 */
export function recordFacts(e: StoredEvent): RecordFacts {
  const version = e.source.version ? ` ${e.source.version}` : '';
  return {
    title: title(e),
    meta: `seq ${e.seq} · ${e.source.provider} ${e.source.channel}${version}`,
    facts: facts(e),
    origin: origin(e),
  };
}

function title(e: StoredEvent): string {
  switch (e.kind) {
    case 'session.started':
      return 'Session started';
    case 'session.updated':
      return 'Session details changed';
    case 'session.ended':
      return 'Session ended';
    case 'turn.started':
      return 'Turn started';
    case 'turn.ended':
      return 'Turn ended';
    case 'agent.message':
      return e.phase === 'final' ? 'The agent’s answer' : 'The agent said';
    case 'agent.thinking':
      return 'The agent thought';
    case 'agent.usage':
      return 'What one model call used';
    case 'tool.called':
      return CALL_TITLE[e.input.kind];
    case 'tool.completed':
      return RESULT_TITLE[e.result.kind];
    case 'tool.failed':
      return e.cause === 'rejected' || e.cause === 'denied' ? 'Tool stopped' : 'Tool failed';
    case 'subagent.started':
      return 'Subagent started';
    case 'subagent.ended':
      return 'Subagent finished';
    case 'plan.updated':
      return 'Plan updated';
    case 'compaction':
      return 'Context compacted';
    case 'permission.requested':
      return 'Permission asked for';
    case 'notification':
      return 'Notification';
    case 'git.snapshot':
      return 'Repository snapshot';
    case 'ingest.warning':
      return 'A record could not be read';
    case 'salidium.explanation':
      return 'Generated explanation';
    default:
      return 'Record';
  }
}

const CALL_TITLE: Record<ToolInput['kind'], string> = {
  command: 'Command run',
  fileEdit: 'File edited',
  fileWrite: 'File written',
  fileRead: 'File read',
  search: 'Search',
  webFetch: 'Page fetched',
  webSearch: 'Web search',
  subagent: 'Subagent launched',
  plan: 'Plan written',
  question: 'Question asked',
  mcp: 'MCP tool called',
  other: 'Tool called',
};

const RESULT_TITLE: Record<ToolResult['kind'], string> = {
  command: 'Command finished',
  fileChanges: 'Files changed',
  fileRead: 'File read',
  subagent: 'Subagent reported',
  generic: 'Tool finished',
};

/**
 * How an exit code was established, said in full.
 *
 * `unknown` and `inferred` are first-class in this protocol because Claude Code records no exit
 * code for a successful Bash call and Codex hides the nested shell's, so the observation is as
 * much of the answer as the number is. Printing `0` on its own would assert something the record
 * does not contain.
 */
export function exitText(exit: ExitStatus): { value: string; note?: string } {
  const code = exit.code === undefined ? '' : String(exit.code);
  switch (exit.observation) {
    case 'explicit':
      return { value: code === '' ? 'reported, no code' : code };
    case 'inferred-success':
      return { value: code === '' ? 'success' : code, note: 'inferred, not reported' };
    case 'inferred-failure':
      return { value: code === '' ? 'failure' : code, note: 'inferred, not reported' };
    default:
      return { value: 'unknown', note: 'the record does not say' };
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Token counts run to six figures, so they are grouped; which separator is the reader's locale. */
function count(n: number): string {
  return n.toLocaleString();
}

function facts(e: StoredEvent): Fact[] {
  switch (e.kind) {
    case 'tool.called':
      return [...callFacts(e), { label: 'Tool', value: e.toolName, mono: true }];
    case 'tool.completed':
      return [
        ...resultFacts(e),
        { label: 'Tool', value: e.toolName, mono: true },
        ...(e.durationMs === undefined
          ? []
          : [{ label: 'Took', value: `${e.durationMs} ms`, mono: true }]),
      ];
    case 'tool.failed': {
      const ex = e.exit ? exitText(e.exit) : undefined;
      return [
        { label: 'Error', value: e.errorExcerpt, mono: true, block: true, copy: true },
        { label: 'Cause', value: CAUSE[e.cause] },
        ...(ex ? [{ label: 'Exit', value: ex.value, mono: true, note: ex.note }] : []),
        { label: 'Tool', value: e.toolName, mono: true },
        ...(e.durationMs === undefined
          ? []
          : [{ label: 'Took', value: `${e.durationMs} ms`, mono: true }]),
      ];
    }
    case 'agent.message':
      return [
        {
          label: 'Said',
          value: e.text,
          block: true,
          copy: true,
          note: e.truncated ? 'cut short by the excerpt limit' : undefined,
        },
        ...(e.phase ? [{ label: 'Phase', value: e.phase }] : []),
      ];
    case 'agent.thinking':
      return [
        {
          label: 'Length',
          value: plural(e.chars, 'character'),
          mono: true,
          note: 'the reasoning itself is neither stored nor shown',
        },
      ];
    /*
     * Tokens are observed — the provider reported these four numbers — so they are printed flat,
     * as fact. No currency figure belongs on this record at any detail: a dollar amount is
     * Salidium's own arithmetic over a price table this drawer cannot name, and on a subscription
     * no dollar is charged for the call at all. The unit is in each label rather than beside each
     * value, so the four numbers line up as the one comparison a reader is here to make.
     *
     * The response id is a fact rather than an id to step past. Claude Code can stamp a whole
     * response's usage onto each content-block record, so these numbers describe the response and
     * two records with the same response id must never be added together. That is the caveat the
     * note carries.
     */
    case 'agent.usage':
      return [
        { label: 'Input tokens', value: count(e.inputTokens), mono: true },
        { label: 'Output tokens', value: count(e.outputTokens), mono: true },
        { label: 'Cache read tokens', value: count(e.cacheReadTokens), mono: true },
        { label: 'Cache write tokens', value: count(e.cacheWriteTokens), mono: true },
        ...opt('Model', e.model, true),
        {
          label: 'Response',
          value: e.messageId,
          mono: true,
          copy: true,
          note: 'one API response; its other records repeat these same figures',
        },
      ];
    case 'turn.started':
      return [
        {
          label: 'Asked',
          value: e.prompt,
          block: true,
          copy: true,
          note: e.promptTruncated ? 'cut short by the excerpt limit' : undefined,
        },
      ];
    case 'turn.ended':
      return [
        { label: 'Outcome', value: e.outcome },
        ...(e.error ? [{ label: 'Error', value: e.error, mono: true, block: true }] : []),
        ...(e.lastMessage
          ? [{ label: 'Last message', value: e.lastMessage, block: true, copy: true }]
          : []),
      ];
    case 'session.started':
      return [
        { label: 'Working in', value: e.cwd, mono: true, copy: true },
        ...opt('Title', e.title),
        ...opt('Model', e.model, true),
        ...opt('Branch', e.gitBranch, true),
        ...opt('Started by', e.entrypoint),
        ...opt('Reason', e.reason),
        ...opt('Transcript', e.transcriptPath, true, true),
      ];
    case 'session.updated':
      return [
        ...opt('Title', e.title),
        ...opt('Model', e.model, true),
        ...opt('Branch', e.gitBranch, true),
        ...opt('Working in', e.cwd, true, true),
      ];
    case 'session.ended':
      return [...opt('Reason', e.reason)];
    case 'subagent.started':
      return [
        ...opt('Task', e.description),
        ...opt('Kind', e.agentType, true),
        { label: 'Lane', value: e.subagentId, mono: true },
        ...opt('From call', e.parentCallId, true),
        ...opt('Transcript', e.transcriptPath, true, true),
      ];
    case 'subagent.ended':
      return [
        { label: 'Lane', value: e.subagentId, mono: true },
        ...(e.lastMessage
          ? [{ label: 'Reported', value: e.lastMessage, block: true, copy: true }]
          : []),
      ];
    case 'plan.updated': {
      const done = e.items.filter((i) => i.status === 'completed').length;
      const doing = e.items.filter((i) => i.status === 'in_progress').length;
      return [
        {
          label: 'Plan',
          value: `${plural(e.items.length, 'item')} · ${done} done · ${doing} in progress`,
        },
        ...e.items.map((i) => ({ label: STATUS_MARK[i.status], value: i.text })),
        ...opt('Why', e.explanation),
        { label: 'Kind', value: e.mode === 'replace' ? 'the whole plan' : 'an update to it' },
      ];
    }
    case 'compaction':
      return [
        ...opt('Trigger', e.trigger),
        ...(e.summaryExcerpt
          ? [{ label: 'Kept', value: e.summaryExcerpt, block: true, copy: true }]
          : []),
      ];
    case 'permission.requested':
      return [
        { label: 'Asked', value: e.summary, block: true },
        { label: 'Tool', value: e.toolName, mono: true },
      ];
    case 'notification':
      return [
        { label: 'Message', value: e.message, block: true },
        ...opt('Kind', e.notificationType),
      ];
    case 'git.snapshot':
      return [
        { label: 'Repository', value: e.repoRoot, mono: true, copy: true },
        ...opt('Head', e.head, true, true),
        ...opt('Branch', e.branch, true),
        {
          label: 'Dirty',
          value: e.dirty.length === 0 ? 'nothing uncommitted' : plural(e.dirty.length, 'path'),
          note: e.dirtyTruncated ? 'the list is capped, so there may be more' : undefined,
        },
        // Porcelain codes are two columns and one of them is often a space, so a raw code can be
        // blank; the path is the fact either way and the code is a note on it.
        ...e.dirty.map((d) => ({
          label: d.status.trim() === '' ? 'unchanged' : d.status.trim(),
          value: d.path,
          mono: true,
        })),
      ];
    case 'ingest.warning':
      return [{ label: 'Problem', value: e.code }, ...opt('Detail', e.detail, true, false, true)];
    case 'salidium.explanation':
      return [
        {
          label: 'Summary',
          value: e.what.summary,
          block: true,
          note: 'generated, not observed',
        },
        ...opt('Currently', e.what.currently ?? undefined),
        { label: 'Generated by', value: e.model, mono: true },
        { label: 'From records up to', value: `seq ${e.basedOnSeq}`, mono: true },
      ];
    default:
      return [];
  }
}

const CAUSE: Record<ToolFailureCause, string> = {
  error: 'the tool itself failed',
  rejected: 'a human declined it',
  denied: 'policy refused it',
  interrupted: 'it was interrupted',
  timeout: 'it ran out of time',
};

const STATUS_MARK: Record<PlanItemStatus, string> = {
  completed: 'done',
  in_progress: 'doing',
  pending: 'to do',
  cancelled: 'dropped',
};

function opt(label: string, value?: string, mono = false, copy = false, block = false): Fact[] {
  return value === undefined || value === '' ? [] : [{ label, value, mono, copy, block }];
}

function callFacts(e: Extract<StoredEvent, { kind: 'tool.called' }>): Fact[] {
  const i = e.input;
  switch (i.kind) {
    case 'command':
      return [
        { label: 'Command', value: i.command, mono: true, block: true, copy: true },
        ...opt('Why', i.description),
        ...opt('In', i.cwd, true, true),
        ...(i.background ? [{ label: 'Runs', value: 'in the background' }] : []),
      ];
    case 'fileEdit':
    case 'fileWrite':
    case 'fileRead':
      return [{ label: 'File', value: i.path, mono: true, copy: true }];
    case 'search':
      return [
        { label: 'Query', value: i.query, mono: true, copy: true },
        ...opt('In', i.path, true, true),
      ];
    case 'webFetch':
    case 'webSearch':
      return [{ label: 'Target', value: i.target, mono: true, copy: true }];
    case 'subagent':
      return [...opt('Task', i.description), ...opt('Kind', i.agentType, true)];
    case 'question':
      // One fact, not one per question: a second row with an empty label is a blank cell, and the
      // questions are one thing the agent asked rather than several unrelated facts.
      return [{ label: 'Asked', value: i.questions.join('\n'), block: true, copy: true }];
    case 'mcp':
      return [
        { label: 'Tool', value: `${i.server}/${i.tool}`, mono: true, copy: true },
        ...opt('Arguments', i.argsExcerpt, true, true, true),
      ];
    case 'plan':
      return [{ label: 'Wrote', value: e.title }];
    default:
      return [...opt('Summary', i.summary)];
  }
}

function resultFacts(e: Extract<StoredEvent, { kind: 'tool.completed' }>): Fact[] {
  const r = e.result;
  switch (r.kind) {
    case 'command': {
      const ex = exitText(r.exit);
      const git = r.gitOperation;
      return [
        { label: 'Exit', value: ex.value, mono: true, note: ex.note },
        ...(r.outputExcerpt
          ? [
              {
                label: 'Output',
                value: r.outputExcerpt,
                mono: true,
                block: true,
                copy: true,
                note: r.truncated
                  ? `excerpt of ${plural(r.outputChars, 'character')}`
                  : plural(r.outputChars, 'character'),
              },
            ]
          : [{ label: 'Output', value: 'none recorded' }]),
        ...(r.interrupted ? [{ label: 'Interrupted', value: 'yes' }] : []),
        ...(r.timedOut ? [{ label: 'Timed out', value: 'yes' }] : []),
        ...(git?.commit
          ? [{ label: 'Commit', value: git.commit.sha, mono: true, copy: true }]
          : []),
        ...(git?.push ? [{ label: 'Pushed', value: git.push.branch ?? 'yes', mono: true }] : []),
        ...(git?.pr?.number === undefined
          ? []
          : [{ label: 'Pull request', value: `#${git.pr.number}`, mono: true }]),
      ];
    }
    case 'fileChanges': {
      const add = r.changes.reduce((n, c) => n + c.linesAdded, 0);
      const del = r.changes.reduce((n, c) => n + c.linesRemoved, 0);
      return [
        { label: 'Changed', value: `${plural(r.changes.length, 'file')} · +${add} −${del}` },
        ...r.changes.map((c) => ({
          label: c.change,
          value: `${c.path}  +${c.linesAdded} −${c.linesRemoved}`,
          mono: true,
          note: c.applied ? undefined : 'not applied',
        })),
      ];
    }
    case 'fileRead':
      return [
        { label: 'File', value: r.path, mono: true, copy: true },
        ...(r.suppressed
          ? [{ label: 'Contents', value: 'withheld: this path holds credentials' }]
          : []),
      ];
    case 'subagent':
      return [
        { label: 'Status', value: r.status },
        ...(r.summaryExcerpt
          ? [{ label: 'Reported', value: r.summaryExcerpt, block: true, copy: true }]
          : []),
        ...(r.toolCalls === undefined
          ? []
          : [{ label: 'Tool calls', value: String(r.toolCalls), mono: true }]),
        ...(r.durationMs === undefined
          ? []
          : [{ label: 'Ran for', value: `${r.durationMs} ms`, mono: true }]),
        ...opt('Lane', r.agentId, true),
      ];
    default:
      return r.excerpt
        ? [{ label: 'Result', value: r.excerpt, mono: true, block: true, copy: true }]
        : [{ label: 'Result', value: 'nothing recorded' }];
  }
}

/**
 * How the record got here. Kept apart from what it says, because "the agent ran `pnpm test`" and
 * "we learned that from the transcript rather than from a hook" are two different questions, and
 * the second one is the one that decides how much the first is worth.
 */
function origin(e: StoredEvent): Fact[] {
  return [
    {
      label: 'When',
      value: e.ts,
      mono: true,
      note: e.tsSource === 'ingest' ? 'when Salidium received it, not when it happened' : undefined,
    },
    ...opt('Lane', e.agentId, true),
    ...opt('Turn', e.turnId, true),
    ...(e.redactions
      ? [
          {
            label: 'Redacted',
            value: plural(e.redactions, 'credential-shaped string'),
            note: 'removed at ingest, before anything was stored',
          },
        ]
      : []),
    { label: 'Id', value: e.id, mono: true, copy: true },
  ];
}
