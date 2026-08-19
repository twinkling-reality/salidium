import { asString } from '@salidium/adapter-kit';
import type { ExitStatus } from '@salidium/protocol';

/**
 * A command that is still running when the tool call yielded. Codex hands the model a handle
 * (code-mode cell id, unified-exec session id) it later polls with `wait` / `write_stdin`; the
 * real result arrives in that later call's output.
 */
export interface RunningHandle {
  kind: 'cell' | 'session';
  id: string;
}

export interface ParsedExecOutput {
  exit: ExitStatus;
  body: string;
  truncated: boolean;
  /** Set when the header says the process/script is still running (no result yet). */
  running?: RunningHandle;
}

/**
 * Parses the text Codex writes as command output. Three formats exist:
 *  - `shell` function tool:  "Exit code: N\nWall time: X seconds\n[Total output lines: N\n]Output:\n…"
 *  - unified exec:           "Chunk ID: …\nWall time: X seconds\nProcess exited with code N\n…Output:\n…"
 *                            or "…\nProcess running with session ID N\n…" while still running
 *  - code-mode `exec`:       "Script completed|failed|terminated\nWall time X seconds\nOutput:\n…"
 *                            or "Script running with cell ID N\n…" while still running
 * The last one reports *script* status, not a shell exit code — but the script's own printed
 * output usually carries `exec_command`'s result object, which does; see `decodeChunkResults`.
 */
export function parseExecOutput(output: string): ParsedExecOutput {
  const truncated = TRUNCATION.test(output);
  const header = output.slice(0, 400);
  const explicit =
    /^Exit code:\s*(-?\d+)/m.exec(header) ?? /Process exited with code (-?\d+)/.exec(header);
  const body = stripHeader(output);
  if (explicit)
    return { exit: { code: Number(explicit[1]), observation: 'explicit' }, body, truncated };
  const chunks = decodeChunkResults(body);
  if (chunks) {
    const t = truncated || chunks.truncated;
    if (chunks.running)
      return {
        exit: { observation: 'unknown' },
        body: chunks.body,
        truncated: t,
        running: chunks.running,
      };
    if (chunks.exitCode !== undefined)
      return {
        exit: { code: chunks.exitCode, observation: 'explicit' },
        body: chunks.body,
        truncated: t,
      };
    return { exit: { observation: 'unknown' }, body: chunks.body, truncated: t };
  }
  if (/^Script failed|^Script error/m.test(header))
    return { exit: { observation: 'inferred-failure' }, body, truncated };
  if (/^Script (completed|terminated)/m.test(header))
    return { exit: { observation: 'unknown' }, body, truncated };
  const cell = /^Script running with cell ID (\S+)/m.exec(header);
  if (cell?.[1])
    return {
      exit: { observation: 'unknown' },
      body,
      truncated,
      running: { kind: 'cell', id: cell[1] },
    };
  const session = /^Process running with session ID (\S+)/m.exec(header);
  if (session?.[1])
    return {
      exit: { observation: 'unknown' },
      body,
      truncated,
      running: { kind: 'session', id: session[1] },
    };
  return { exit: { observation: 'unknown' }, body, truncated };
}

/** The cell/session a `wait` / `write_stdin` call polls, from its JSON arguments. */
export function runningHandleFromArgs(
  name: string,
  args: Record<string, unknown>,
): RunningHandle | undefined {
  const raw = name === 'wait' ? args.cell_id : name === 'write_stdin' ? args.session_id : undefined;
  if (typeof raw === 'number')
    return { kind: name === 'wait' ? 'cell' : 'session', id: String(raw) };
  if (typeof raw === 'string' && raw)
    return { kind: name === 'wait' ? 'cell' : 'session', id: raw };
  return undefined;
}

export function runningHandleKey(h: RunningHandle): string {
  return `${h.kind}:${h.id}`;
}

const POLL_SESSION = /tools\.write_stdin\s*\(\s*\{[^}]*?["']?session_id["']?\s*:\s*["']?(\d+)/;
const POLL_CELL = /tools\.wait\s*\(\s*\{[^}]*?["']?cell_id["']?\s*:\s*["']?(\d+)/;
const RUNS_COMMAND = /tools\.exec_command\s*\(/;

/**
 * The cell/session a code-mode cell polls, when polling is all it does.
 *
 * A command that outlives its call hands the model a handle, and the model collects the rest by
 * calling `write_stdin` / `wait` again. Codex records that second call two different ways: as a
 * `function_call` named `wait`, which this parser already understood, or as another code cell whose
 * whole body is the poll. Read as a cell it becomes a command of its own, named after the
 * JavaScript that fetched it, and the command that actually ran keeps the empty stub it yielded
 * with.
 *
 * A cell that polls *and* runs something is a command cell: the poll is incidental to it.
 */
export function codeCellPoll(script: string): RunningHandle | undefined {
  if (RUNS_COMMAND.test(script)) return undefined;
  const session = POLL_SESSION.exec(script);
  if (session?.[1]) return { kind: 'session', id: session[1] };
  const cell = POLL_CELL.exec(script);
  if (cell?.[1]) return { kind: 'cell', id: cell[1] };
  return undefined;
}

/**
 * Codex truncates a long command's output in the middle. The wrappers announce it differently:
 * the shell tool with a warning line, the code-mode result object with an inline `…N tokens
 * truncated…` marker inside the text it kept.
 *
 * A bare `Original token count: N` used to count as a marker and is not one — the unified-exec
 * header prints it on every result, truncated or not. It appears in the real warning too
 * (`Warning: truncated output (original token count: N)`), which is what made it look
 * load-bearing.
 */
const TRUNCATION =
  /Warning: truncated output|\[Total output lines: \d+\]|…\s*[\d,]+ tokens truncated\s*…/i;

interface ChunkResults {
  body: string;
  exitCode?: number;
  running?: RunningHandle;
  truncated: boolean;
}

/**
 * Decodes `exec_command`'s own result objects out of what a code-mode script printed.
 *
 * A code cell's wrapper only reports whether the *script* ran, so read that way a code-mode
 * command's exit status is never observable. But the model's cells almost always end
 * `text(JSON.stringify(r))`, and `r` is Codex's result: `{chunk_id, wall_time_seconds,
 * exit_code | session_id, original_token_count, output}`. Reading it is reading the record, not
 * inferring: the keys are `exec_command`'s, and the real stdout lives in `output`, JSON-escaped.
 * Left escaped it defeats every runner parser, since a summary line matched at the start of a
 * line has no line to start.
 *
 * A cell may run several commands and print several objects, separated by whatever the script
 * wrote between them, so they are found by brace matching rather than by line. One still running
 * makes the whole cell unfinished — a sibling's exit code must not be read as the cell's verdict.
 */
function decodeChunkResults(body: string): ChunkResults | undefined {
  const found: Array<{ exit_code?: number; session_id?: number | string; output?: string }> = [];
  let i = 0;
  for (;;) {
    const start = body.indexOf('{"chunk_id"', i);
    if (start < 0) break;
    const end = endOfObject(body, start);
    if (end < 0) break;
    i = end + 1;
    try {
      found.push(JSON.parse(body.slice(start, end + 1)));
    } catch {
      /* not the object we are looking for */
    }
  }
  if (!found.length) return undefined;
  const texts = found.map((f) => f.output).filter((o): o is string => typeof o === 'string');
  // Nothing carried output: keep what the script printed rather than replacing it with nothing.
  const text = texts.length ? texts.join('\n') : body;
  const truncated = TRUNCATION.test(text);
  const running = found.find(
    (f) =>
      f.exit_code === undefined &&
      (typeof f.session_id === 'number' || typeof f.session_id === 'string'),
  );
  if (running)
    return { body: text, truncated, running: { kind: 'session', id: String(running.session_id) } };
  const codes = found.map((f) => f.exit_code).filter((c): c is number => typeof c === 'number');
  if (!codes.length) return { body: text, truncated };
  // One cell can run several commands, and a verification is about exactly one of them. All
  // zero means the one we classified passed, whichever it was; a single result is its own. A
  // mixed cell says something failed without saying which, so it says nothing here — the
  // summary in the output can still decide, and inventing an attribution is the failure mode
  // this whole layer exists to avoid.
  if (codes.length === 1 || codes.every((c) => c === 0))
    return { body: text, truncated, exitCode: codes[0] === 0 ? 0 : codes[0] };
  return { body: text, truncated };
}

/** Index of the `}` closing the object that starts at `start`, or -1. String-aware. */
function endOfObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

function stripHeader(output: string): string {
  const idx = output.indexOf('Output:\n');
  if (idx >= 0 && idx < 400) return output.slice(idx + 'Output:\n'.length);
  return output;
}

/** Shell function args: {command: string | string[]} or {cmd: string}. */
export function parseShellFunctionArgs(args: Record<string, unknown>): string {
  const cmd = args.cmd ?? args.command;
  if (Array.isArray(cmd)) {
    const parts = cmd.map(String);
    // ["bash","-lc","actual command"] → actual command
    if (parts.length >= 3 && /^(bash|sh|zsh)$/.test(parts[0] ?? '') && parts[1] === '-lc')
      return parts.slice(2).join(' ');
    return parts.join(' ');
  }
  return asString(cmd) ?? '';
}

const EXEC_CALL = /tools\.exec_command\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const CMD_LITERAL = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/;

/** Best-effort extraction of shell commands from a code-mode JS cell. */
export function extractCodeCellCommands(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(EXEC_CALL)) {
    const lit = CMD_LITERAL.exec(m[1] ?? '')?.[1];
    if (!lit) continue;
    out.push(decodeLiteral(lit));
  }
  return out;
}

function decodeLiteral(lit: string): string {
  const q = lit[0];
  const inner = lit.slice(1, -1);
  if (q === '"') {
    try {
      return JSON.parse(lit) as string;
    } catch {
      return inner;
    }
  }
  return inner.replace(/\\(['`\\nrt])/g, (_, c: string) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c,
  );
}

/** Paths named in an apply_patch payload ("*** Update File: path", "*** Add File:", "*** Delete File:"). */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
    const p = m[1]?.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
