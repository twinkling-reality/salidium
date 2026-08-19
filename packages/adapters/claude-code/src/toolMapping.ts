import {
  asObject,
  asString,
  countHunkLines,
  excerpt,
  pathArgumentMetadata,
} from '@salidium/adapter-kit';
import type {
  ExitStatus,
  FileChange,
  GitOperation,
  Hunk,
  PlanItem,
  ToolInput,
  ToolResult,
} from '@salidium/protocol';

/**
 * Maps Claude Code tool names + inputs + structured results to canonical tool inputs/results.
 * Shared by the transcript parser and the hook parser so both channels produce identical events.
 * Tool output shapes mirror the Agent SDK's ToolOutputSchemas (BashOutput, FileEditOutput, ...).
 */

const HOME = process.env.HOME ?? '';

function tidyPath(p: string): string {
  return HOME && p.startsWith(`${HOME}/`) ? `~/${p.slice(HOME.length + 1)}` : p;
}

export function mapToolInput(
  toolName: string,
  rawInput: unknown,
): { input: ToolInput; title: string } {
  const input = asObject(rawInput) ?? {};
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const command = asString(input.command) ?? '';
      const description = asString(input.description);
      const background = input.run_in_background === true;
      return {
        input: { kind: 'command', command, description, background },
        title: description ? `${description}` : `Run: ${firstLine(command)}`,
      };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const path = asString(input.file_path) ?? asString(input.notebook_path) ?? '';
      return { input: { kind: 'fileEdit', path }, title: `Edit ${tidyPath(path)}` };
    }
    case 'Write': {
      const path = asString(input.file_path) ?? '';
      return { input: { kind: 'fileWrite', path }, title: `Write ${tidyPath(path)}` };
    }
    case 'Read': {
      const path = asString(input.file_path) ?? '';
      return { input: { kind: 'fileRead', path }, title: `Read ${tidyPath(path)}` };
    }
    case 'Glob':
    case 'Grep': {
      const query = asString(input.pattern) ?? '';
      const path = asString(input.path);
      return {
        input: { kind: 'search', query, path },
        title: `${toolName === 'Grep' ? 'Search' : 'Find files'}: ${query}`,
      };
    }
    case 'WebFetch': {
      const url = asString(input.url) ?? '';
      return { input: { kind: 'webFetch', target: url }, title: `Fetch ${url}` };
    }
    case 'WebSearch': {
      const q = asString(input.query) ?? '';
      return { input: { kind: 'webSearch', target: q }, title: `Web search: ${q}` };
    }
    case 'Agent':
    case 'Task': {
      const description = asString(input.description);
      const agentType = asString(input.subagent_type);
      const background = input.run_in_background === true;
      return {
        input: { kind: 'subagent', description, agentType, background },
        title: `Delegate: ${description ?? agentType ?? 'subagent'}`,
      };
    }
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'TodoWrite':
    case 'ExitPlanMode':
    case 'EnterPlanMode':
      return { input: { kind: 'plan' }, title: planTitle(toolName, input) };
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      const questions = qs.map((q) => asString(asObject(q)?.question) ?? '').filter(Boolean);
      return {
        input: { kind: 'question', questions },
        title: `Ask: ${questions[0] ?? 'question'}`,
      };
    }
    default: {
      const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
      if (mcp) {
        const server = mcp[1] ?? '';
        const tool = mcp[2] ?? '';
        const pathMetadata = pathArgumentMetadata(input);
        const argsExcerpt = excerpt(JSON.stringify(input), 300, 0).text;
        return {
          input: {
            kind: 'mcp',
            server,
            tool,
            pathArgs: pathMetadata.paths.length ? pathMetadata.paths : undefined,
            pathArgsTruncated: pathMetadata.truncated || undefined,
            argsExcerpt,
          },
          title: `${server}: ${tool}`,
        };
      }
      return { input: { kind: 'other', summary: toolName }, title: toolName };
    }
  }
}

function planTitle(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'TaskCreate':
      return `Task: ${asString(input.subject) ?? ''}`;
    case 'TaskUpdate':
      return `Task ${asString(input.taskId) ?? ''} → ${asString(input.status) ?? 'updated'}`;
    case 'TodoWrite':
      return 'Update todo list';
    case 'ExitPlanMode':
      return 'Present plan';
    case 'EnterPlanMode':
      return 'Enter plan mode';
    default:
      return toolName;
  }
}

function firstLine(s: string): string {
  const l = s.split('\n')[0] ?? '';
  return l.length > 120 ? `${l.slice(0, 119)}…` : l;
}

export interface MappedResult {
  result: ToolResult;
  isError: boolean;
}

/**
 * Maps a structured tool result. `structured` is the toolUseResult (transcript) or tool_response
 * (hook); `contentText` is the tool_result text the model saw (transcript only).
 */
export function mapToolResult(
  toolName: string,
  rawInput: unknown,
  structured: unknown,
  contentText: string | undefined,
): MappedResult {
  const input = asObject(rawInput) ?? {};
  const s = asObject(structured);
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const stdout = asString(s?.stdout) ?? contentText ?? '';
      const stderr = asString(s?.stderr) ?? '';
      const merged =
        stderr && !stdout.includes(stderr) ? `${stdout}${stdout ? '\n' : ''}${stderr}` : stdout;
      const ex = excerpt(merged);
      const interrupted = s?.interrupted === true;
      const timedOut = typeof s?.timedOutAfterMs === 'number';
      // A backgrounded command has not run yet: its stub result says nothing about the outcome.
      const background =
        input.run_in_background === true ||
        typeof s?.backgroundTaskId === 'string' ||
        /^Command running in background/i.test(stdout);
      const exit: ExitStatus =
        interrupted || background
          ? { observation: 'unknown' }
          : { observation: 'inferred-success' };
      const gitOperation = mapGitOperation(s?.gitOperation);
      return {
        result: {
          kind: 'command',
          exit,
          outputExcerpt: ex.text,
          outputChars: merged.length,
          truncated: ex.truncated,
          interrupted,
          timedOut,
          gitOperation,
        },
        isError: false,
      };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Write': {
      const path =
        asString(s?.filePath) ?? asString(input.file_path) ?? asString(input.notebook_path) ?? '';
      const hunks = toHunks(s?.structuredPatch);
      const counts = countHunkLines(hunks);
      const isCreate =
        s?.type === 'create' ||
        (toolName === 'Write' &&
          (s?.originalFile === null || s?.originalFile === undefined) &&
          s?.structuredPatch !== undefined &&
          hunks.length === 0);
      let linesAdded = counts.added;
      let linesRemoved = counts.removed;
      if (isCreate) {
        const content = asString(s?.content) ?? asString(input.content) ?? '';
        linesAdded = content ? content.split('\n').length : 0;
        linesRemoved = 0;
      } else if (hunks.length === 0 && toolName === 'Write') {
        // Overwrite without a patch (older versions): count from content vs originalFile.
        const content = asString(s?.content) ?? asString(input.content) ?? '';
        const original = asString(s?.originalFile) ?? '';
        linesAdded = content ? content.split('\n').length : 0;
        linesRemoved = original ? original.split('\n').length : 0;
      }
      const change: FileChange = {
        path,
        change: isCreate ? 'add' : 'update',
        hunks: hunks.length ? hunks : undefined,
        linesAdded,
        linesRemoved,
        applied: true,
        userModifiedBefore: s?.userModified === true ? true : undefined,
      };
      return { result: { kind: 'fileChanges', changes: [change] }, isError: false };
    }
    case 'Read': {
      const path = asString(input.file_path) ?? asString(asObject(s?.file)?.filePath) ?? '';
      return { result: { kind: 'fileRead', path }, isError: false };
    }
    case 'Agent':
    case 'Task': {
      const status = asString(s?.status);
      const contentArr = Array.isArray(s?.content) ? s.content : [];
      const text =
        contentArr
          .map((b) => asString(asObject(b)?.text) ?? '')
          .filter(Boolean)
          .join('\n') ||
        contentText ||
        '';
      return {
        result: {
          kind: 'subagent',
          agentId: asString(s?.agentId),
          status:
            status === 'completed'
              ? 'completed'
              : status === 'async_launched' || status === 'remote_launched'
                ? 'launched'
                : status
                  ? 'unknown'
                  : 'completed',
          summaryExcerpt: text ? excerpt(text, 1500, 500).text : undefined,
          toolCalls: typeof s?.totalToolUseCount === 'number' ? s.totalToolUseCount : undefined,
          durationMs: typeof s?.totalDurationMs === 'number' ? s.totalDurationMs : undefined,
        },
        isError: false,
      };
    }
    default: {
      const text =
        contentText ??
        (typeof structured === 'string'
          ? structured
          : structured !== undefined
            ? JSON.stringify(structured)
            : '');
      return {
        result: { kind: 'generic', excerpt: text ? excerpt(text, 800, 400).text : undefined },
        isError: false,
      };
    }
  }
}

function toHunks(v: unknown): Hunk[] {
  if (!Array.isArray(v)) return [];
  const out: Hunk[] = [];
  for (const h of v) {
    const o = asObject(h);
    if (!o) continue;
    const lines = Array.isArray(o.lines)
      ? o.lines.filter((l): l is string => typeof l === 'string')
      : [];
    out.push({
      oldStart: Number(o.oldStart ?? 0),
      oldLines: Number(o.oldLines ?? 0),
      newStart: Number(o.newStart ?? 0),
      newLines: Number(o.newLines ?? 0),
      lines,
    });
  }
  return out;
}

function mapGitOperation(v: unknown): GitOperation | undefined {
  const o = asObject(v);
  if (!o) return undefined;
  const commit = asObject(o.commit);
  const push = asObject(o.push);
  const branch = asObject(o.branch);
  const pr = asObject(o.pr);
  const out: Record<string, unknown> = {};
  if (commit && asString(commit.sha))
    out.commit = { sha: asString(commit.sha), kind: asString(commit.kind) };
  if (push) out.push = { branch: asString(push.branch) };
  if (branch) out.branch = { ref: asString(branch.ref), action: asString(branch.action) };
  if (pr)
    out.pr = {
      number: typeof pr.number === 'number' ? pr.number : undefined,
      url: asString(pr.url),
      action: asString(pr.action),
    };
  return Object.keys(out).length ? (out as GitOperation) : undefined;
}

/**
 * Parses the failure string Claude Code stores for a failed tool call ("Error: Exit code 1\n…",
 * "User rejected tool use", "Error: Permission for this action was denied…").
 */
export function parseFailure(text: string): {
  errorExcerpt: string;
  cause: 'error' | 'rejected' | 'denied' | 'interrupted' | 'timeout';
  exit?: ExitStatus;
  interrupted: boolean;
} {
  const body = text
    .replace(/^Error:\s*/, '')
    .replace(/^<tool_use_error>/, '')
    .replace(/<\/tool_use_error>$/, '');
  const m = /^Exit code (\d+)/.exec(body);
  const timeout = /Command timed out/i.test(body);
  const interrupted = /interrupted by user|\[Request interrupted/i.test(body);
  const rejected = /^User rejected|user doesn't want to proceed|The user doesn't want/i.test(body);
  const denied =
    /Permission (for this action was |to use .* )?denied|denied by the Claude Code|Blocked by classifier|hook blocked|blocked by hook/i.test(
      body,
    );
  const cause = rejected
    ? 'rejected'
    : denied
      ? 'denied'
      : interrupted
        ? 'interrupted'
        : timeout
          ? 'timeout'
          : 'error';
  const ex = excerpt(body, 3000, 3000);
  const exit: ExitStatus | undefined = m
    ? { code: Number(m[1]), observation: 'explicit' }
    : cause === 'error'
      ? { observation: 'inferred-failure' }
      : undefined;
  return { errorExcerpt: ex.text, cause, exit, interrupted };
}

/** Plan/task tools → plan items (mode replace/merge). */
export function mapPlanUpdate(
  toolName: string,
  rawInput: unknown,
  structured: unknown,
): { mode: 'replace' | 'merge'; items: PlanItem[] } | undefined {
  const input = asObject(rawInput) ?? {};
  const s = asObject(structured);
  switch (toolName) {
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos)
        ? input.todos
        : Array.isArray(s?.newTodos)
          ? s.newTodos
          : [];
      const items: PlanItem[] = [];
      const seenKeys = new Map<string, number>();
      todos.forEach((t) => {
        const o = asObject(t);
        if (!o) return;
        const text = asString(o.content) ?? '';
        if (!text) return;
        // Stable identity: an explicit id if the tool gave one, else the normalized text (so
        // reordering does not look like completion), disambiguated when texts repeat.
        const key = asString(o.id) ?? `todo:${text.toLowerCase().replace(/\s+/g, ' ').trim()}`;
        const n = seenKeys.get(key) ?? 0;
        seenKeys.set(key, n + 1);
        items.push({
          id: n === 0 ? key : `${key}#${n}`,
          text,
          status: normalizeStatus(asString(o.status)),
          activeForm: asString(o.activeForm),
        });
      });
      return { mode: 'replace', items };
    }
    case 'TaskCreate': {
      const task = asObject(s?.task);
      const id = asString(task?.id) ?? '';
      const text = asString(task?.subject) ?? asString(input.subject) ?? '';
      if (!text) return undefined;
      return {
        mode: 'merge',
        items: [
          {
            id: id || `task-${text.slice(0, 40)}`,
            text,
            status: normalizeStatus(asString(task?.status)) ?? 'pending',
            activeForm: asString(task?.activeForm) ?? asString(input.activeForm),
          },
        ],
      };
    }
    case 'TaskUpdate': {
      const id = asString(input.taskId) ?? '';
      if (!id) return undefined;
      const status = asString(input.status);
      // Only status changes are semantically meaningful for LEFT; subject/description edits are skipped.
      if (!status) return undefined;
      return {
        mode: 'merge',
        items: [
          {
            id,
            text: asString(input.subject) ?? '',
            status: normalizeStatus(status),
            activeForm: asString(input.activeForm),
          },
        ],
      };
    }
    default:
      return undefined;
  }
}

function normalizeStatus(s: string | undefined): PlanItem['status'] {
  switch (s) {
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'deleted':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}
