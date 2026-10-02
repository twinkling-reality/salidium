import { isAbsolute, resolve } from 'node:path';
import {
  asObject,
  asString,
  countHunkLines,
  excerpt,
  hunksFromUnifiedDiff,
  pathArgumentMetadata,
} from '@salidium/adapter-kit';
import type {
  ExitStatus,
  FileChange,
  FileChangeKind,
  PlanItem,
  PlanItemStatus,
  ToolFailureCause,
  ToolInput,
  ToolResult,
} from '@salidium/protocol';

/*
 * OpenCode 2.x tool parts to canonical tool inputs and results.
 *
 * A tool part is `{type:"tool", id, name, state, time}` inside an assistant step. `state.status`
 * is `completed` (`input`, `content`, `metadata`) or `error` (`input`, `error:{type, message}`).
 * Names verified on 2.0.18: read, glob, grep, edit, write, patch, shell, subagent, question,
 * skill, webfetch, websearch. Sessions migrated from OpenCode 1.x may still carry the old names
 * (bash, task, apply_patch, todowrite) and `filePath` instead of `path`; they map the same way.
 */

const HOME = process.env.HOME ?? '';

function tidyPath(p: string): string {
  return HOME && p.startsWith(`${HOME}/`) ? `~/${p.slice(HOME.length + 1)}` : p;
}

function bounded(text: string | undefined, max: number): string | undefined {
  return text !== undefined && text.length > max ? `${text.slice(0, max)}…` : text;
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/** v1 names are renamed by OpenCode's own migration; accept both. */
export function canonicalToolName(name: string): string {
  if (name === 'bash') return 'shell';
  if (name === 'task') return 'subagent';
  if (name === 'apply_patch') return 'patch';
  return name;
}

/** Files named by a `*** Begin Patch` text, in order. */
export function patchPaths(patchText: string): string[] {
  const out: string[] = [];
  for (const m of patchText.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) {
    const path = m[1]?.trim();
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

function pathOf(input: Record<string, unknown>): string {
  return asString(input.path) ?? asString(input.filePath) ?? '';
}

/** Text of a completed part's `content` array (text items only). */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const o = asObject(item);
      return o?.type === 'text' ? (asString(o.text) ?? '') : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function mapToolInput(
  rawName: string,
  rawInput: unknown,
  resultText: string,
): { input: ToolInput; title: string } {
  const name = canonicalToolName(rawName);
  const input = asObject(rawInput) ?? {};
  switch (name) {
    case 'shell': {
      const command = excerpt(asString(input.command) ?? '', 8000, 2000).text;
      const description = bounded(asString(input.description), 500);
      const cwd = bounded(asString(input.workdir), 4096);
      return {
        input: { kind: 'command', command, description, cwd },
        title: description ?? `Run: ${firstLine(command)}`,
      };
    }
    case 'edit': {
      const path = pathOf(input);
      return { input: { kind: 'fileEdit', path }, title: `Edit ${tidyPath(path)}` };
    }
    case 'write': {
      const path = pathOf(input);
      return { input: { kind: 'fileWrite', path }, title: `Write ${tidyPath(path)}` };
    }
    case 'patch': {
      const paths = patchPaths(asString(input.patchText) ?? asString(input.patch) ?? '');
      const first = paths[0] ?? '';
      const more = paths.length > 1 ? ` and ${paths.length - 1} more` : '';
      return {
        input: { kind: 'fileEdit', path: first },
        title: first ? `Patch ${tidyPath(first)}${more}` : 'Apply patch',
      };
    }
    case 'read': {
      const path = pathOf(input);
      // `read` also lists directories; a listing is not a file read.
      if (resultText.startsWith('Read directory '))
        return {
          input: { kind: 'other', summary: 'List directory' },
          title: `List ${tidyPath(path)}`,
        };
      return { input: { kind: 'fileRead', path }, title: `Read ${tidyPath(path)}` };
    }
    case 'grep':
    case 'glob': {
      const query = asString(input.pattern) ?? '';
      const path = asString(input.path);
      return {
        input: { kind: 'search', query, path },
        title: `${name === 'grep' ? 'Search' : 'Find files'}: ${query}`,
      };
    }
    case 'webfetch': {
      const url = asString(input.url) ?? '';
      return { input: { kind: 'webFetch', target: url }, title: `Fetch ${url}` };
    }
    case 'websearch': {
      const query = asString(input.query) ?? '';
      return { input: { kind: 'webSearch', target: query }, title: `Web search: ${query}` };
    }
    case 'subagent': {
      const description = asString(input.description);
      const agentType = asString(input.agent) ?? asString(input.subagent_type);
      return {
        input: { kind: 'subagent', description, agentType },
        title: `Delegate: ${description ?? agentType ?? 'subagent'}`,
      };
    }
    case 'question': {
      const list = Array.isArray(input.questions) ? input.questions : [];
      const questions = list
        .map((q) => asString(asObject(q)?.question) ?? asString(q) ?? '')
        .filter(Boolean);
      return {
        input: { kind: 'question', questions },
        title: `Ask: ${questions[0] ?? 'question'}`,
      };
    }
    case 'todowrite':
      return { input: { kind: 'plan' }, title: 'Update to-do list' };
    case 'skill': {
      const skill = asString(input.id) ?? asString(input.name) ?? 'skill';
      return { input: { kind: 'other', summary: `Skill ${skill}` }, title: `Use skill ${skill}` };
    }
    default: {
      // OpenCode names an MCP server's tool `<server>_<tool>`. Mapped as MCP, a file read through
      // one is recognised and suppressed exactly as a native read is. A server whose own name has
      // an underscore splits at its first one, so its tool name keeps the rest.
      const split = name.indexOf('_');
      if (split > 0 && split < name.length - 1) {
        const server = name.slice(0, split);
        const tool = name.slice(split + 1);
        const paths = pathArgumentMetadata(input);
        return {
          input: {
            kind: 'mcp',
            server,
            tool,
            pathArgs: paths.paths.length ? paths.paths : undefined,
            pathArgsTruncated: paths.truncated || undefined,
            argsExcerpt: excerpt(JSON.stringify(input), 300, 0).text,
          },
          title: `${server}: ${tool}`,
        };
      }
      return { input: { kind: 'other', summary: name.slice(0, 120) }, title: name.slice(0, 120) };
    }
  }
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

function changeKind(status: string | undefined): FileChangeKind {
  if (status === 'added') return 'add';
  if (status === 'deleted') return 'delete';
  if (status === 'moved') return 'move';
  return 'update';
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * `edit` and `patch` record `metadata.files[]`: `file` relative to the session's directory, a
 * unified diff, `status` and line counts. Paths become absolute against that directory.
 */
function changesFromMetadata(metadata: Record<string, unknown>, directory: string): FileChange[] {
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  const changes: FileChange[] = [];
  for (const item of files) {
    const f = asObject(item);
    const file = asString(f?.file);
    if (!f || !file) continue;
    const hunks = hunksFromUnifiedDiff(asString(f.patch) ?? '');
    const counted = countHunkLines(hunks);
    const from = asString(f.from);
    const change = changeKind(asString(f.status));
    changes.push({
      path: isAbsolute(file) ? file : resolve(directory, file),
      change,
      movedFrom:
        change === 'move' && from
          ? isAbsolute(from)
            ? from
            : resolve(directory, from)
          : undefined,
      hunks: hunks.length ? hunks : undefined,
      linesAdded: nonNegative(f.additions) ?? counted.added,
      linesRemoved: nonNegative(f.deletions) ?? counted.removed,
      applied: true,
    });
  }
  return changes;
}

/**
 * `write` records no diff. Its result says whether it created the file or replaced one. A new
 * file's lines are all added. A replaced file's earlier content is not recorded, so its removed
 * lines are unknown: `linesRemovedUnknown`, never a guess.
 */
function writeChange(input: Record<string, unknown>, resultText: string): FileChange {
  const path = pathOf(input);
  const content = asString(input.content) ?? '';
  const created = resultText.startsWith('Created file successfully');
  return {
    path,
    change: created ? 'add' : 'update',
    linesAdded: lineCount(content),
    linesRemoved: 0,
    linesRemovedUnknown: created ? undefined : true,
    applied: true,
  };
}

function shellResult(
  metadata: Record<string, unknown>,
  text: string,
): {
  result: ToolResult;
  isError: boolean;
} {
  const code = metadata.exit;
  const exit: ExitStatus =
    typeof code === 'number' && Number.isInteger(code)
      ? { code, observation: 'explicit' }
      : { observation: 'unknown' };
  const ex = excerpt(text, 6000, 6000);
  const status = asString(metadata.status);
  return {
    result: {
      kind: 'command',
      exit,
      outputExcerpt: ex.text,
      outputChars: text.length,
      truncated: ex.truncated || metadata.truncated === true,
      timedOut: status === 'timeout' || undefined,
      interrupted: status === 'killed' || undefined,
    },
    isError: exit.code !== undefined && exit.code !== 0,
  };
}

function subagentResult(metadata: Record<string, unknown>, text: string): ToolResult {
  const status = asString(metadata.status);
  // The result wraps the child's answer as `<subagent sessionID=... state=...>…</subagent>`.
  const inner = text.replace(/^<subagent[^>]*>\n?/, '').replace(/\n?<\/subagent>\s*$/, '');
  return {
    kind: 'subagent',
    agentId: asString(metadata.sessionID),
    status:
      status === 'completed'
        ? 'completed'
        : status === 'error' || status === 'failed'
          ? 'failed'
          : status === 'running'
            ? 'launched'
            : 'unknown',
    summaryExcerpt: inner ? excerpt(inner, 1500, 500).text : undefined,
  };
}

/** Result of a completed tool part. */
export function mapToolResult(
  rawName: string,
  rawInput: unknown,
  rawMetadata: unknown,
  text: string,
  directory: string,
): { result: ToolResult; isError: boolean } {
  const name = canonicalToolName(rawName);
  const input = asObject(rawInput) ?? {};
  const metadata = asObject(rawMetadata) ?? {};
  switch (name) {
    case 'shell':
      return shellResult(metadata, text);
    case 'edit':
    case 'patch': {
      const changes = changesFromMetadata(metadata, directory);
      if (changes.length) return { result: { kind: 'fileChanges', changes }, isError: false };
      break;
    }
    case 'write':
      return {
        result: { kind: 'fileChanges', changes: [writeChange(input, text)] },
        isError: false,
      };
    case 'read':
      if (!text.startsWith('Read directory '))
        return { result: { kind: 'fileRead', path: pathOf(input) }, isError: false };
      break;
    case 'subagent':
      return { result: subagentResult(metadata, text), isError: false };
  }
  return {
    result: { kind: 'generic', excerpt: text ? excerpt(text, 800, 400).text : undefined },
    isError: false,
  };
}

/** Why a tool part ended in `state.status: "error"`. */
export function failureCause(error: Record<string, unknown> | undefined): ToolFailureCause {
  const type = asString(error?.type);
  const message = asString(error?.message) ?? '';
  // OpenCode records a person declining a permission prompt as an aborted call.
  if (type === 'aborted' && /declined/i.test(message)) return 'rejected';
  if (type === 'aborted') return 'interrupted';
  return 'error';
}

const PLAN_STATUS: Record<string, PlanItemStatus> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  cancelled: 'cancelled',
};

/** A migrated 1.x `todowrite` call's full list. 2.x has no to-do tool. */
export function planItems(rawInput: unknown): PlanItem[] | undefined {
  const todos = asObject(rawInput)?.todos;
  if (!Array.isArray(todos)) return undefined;
  const items: PlanItem[] = [];
  todos.forEach((todo, index) => {
    const t = asObject(todo);
    const text = asString(t?.content);
    if (!t || !text) return;
    const status = asString(t.status) ?? '';
    items.push({
      id: (asString(t.id) ?? String(index + 1)).slice(0, 128),
      text: excerpt(text, 400, 0).text,
      status: Object.hasOwn(PLAN_STATUS, status) ? (PLAN_STATUS[status] ?? 'pending') : 'pending',
    });
  });
  return items;
}
