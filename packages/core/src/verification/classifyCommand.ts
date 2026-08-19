import type { VerificationMethod } from '../state/runState.ts';

export interface CommandClassification {
  method: VerificationMethod;
  runner: string;
  /** partial: filters/paths narrow the run; unknown: cannot tell (e.g. `npm test` script). */
  scope: 'full' | 'partial' | 'unknown';
  /** Watch mode never counts as verification. */
  watch: boolean;
}

interface RunnerRule {
  runner: string;
  method: VerificationMethod;
  /** Matches against the first meaningful command segment (pipes/&& are split). */
  pattern: RegExp;
  scopeUnknown?: boolean;
}

/**
 * Deterministic classification of a shell command into a verification method + runner.
 * Only recognized runners produce Verification objects; everything else is just a command.
 * Matching is against the *command word* of each pipeline segment (after stripping env
 * assignments and launcher prefixes like `npx`/`pnpm exec`/`python -m`), so a runner name that
 * merely appears as an argument (`pnpm add -D vitest`, `rg pytest src`) never counts.
 * Order matters: earlier rules win.
 */
const RULES: RunnerRule[] = [
  { runner: 'vitest', method: 'test', pattern: /^vitest(\s|$)/ },
  { runner: 'jest', method: 'test', pattern: /^jest(\s|$)/ },
  { runner: 'playwright', method: 'test', pattern: /^playwright\s+test(\s|$)/ },
  { runner: 'mocha', method: 'test', pattern: /^mocha(\s|$)/ },
  { runner: 'pytest', method: 'test', pattern: /^(pytest|py\.test)(\s|$)/ },
  { runner: 'cargo', method: 'test', pattern: /^cargo\s+(nextest\s+run|test)(\s|$)/ },
  { runner: 'go', method: 'test', pattern: /^go\s+test(\s|$)/ },
  {
    runner: 'xcodebuild',
    method: 'test',
    pattern: /^xcodebuild\b.*\stest(-without-building)?(\s|$)/,
  },
  { runner: 'swift', method: 'test', pattern: /^swift\s+test(\s|$)/ },
  { runner: 'dotnet', method: 'test', pattern: /^dotnet\s+test(\s|$)/ },
  { runner: 'rspec', method: 'test', pattern: /^rspec(\s|$)/ },
  { runner: 'phpunit', method: 'test', pattern: /^phpunit(\s|$)/ },
  { runner: 'mix', method: 'test', pattern: /^mix\s+test(\s|$)/ },
  { runner: 'gradle', method: 'test', pattern: /^gradlew?\s+(:[\w-]+:)?test(\s|$)/ },
  { runner: 'maven', method: 'test', pattern: /^mvn\s+(-[^\s]+\s+)*(test|verify)(\s|$)/ },
  { runner: 'node-test', method: 'test', pattern: /^node\s+(--[^\s]+\s+)*--test(\s|$)/ },
  { runner: 'tsc', method: 'typecheck', pattern: /^tsc(\s|$)/ },
  { runner: 'mypy', method: 'typecheck', pattern: /^mypy(\s|$)/ },
  { runner: 'pyright', method: 'typecheck', pattern: /^pyright(\s|$)/ },
  { runner: 'eslint', method: 'lint', pattern: /^eslint(\s|$)/ },
  { runner: 'biome', method: 'lint', pattern: /^biome\s+(check|lint|ci)(\s|$)/ },
  { runner: 'ruff', method: 'lint', pattern: /^ruff\s+(check|format\s+--check)(\s|$)/ },
  { runner: 'clippy', method: 'lint', pattern: /^cargo\s+clippy(\s|$)/ },
  { runner: 'golangci-lint', method: 'lint', pattern: /^golangci-lint\s+run(\s|$)/ },
  { runner: 'cargo-build', method: 'build', pattern: /^cargo\s+(build|check)(\s|$)/ },
  { runner: 'go-build', method: 'build', pattern: /^go\s+(build|vet)(\s|$)/ },
  { runner: 'xcodebuild', method: 'build', pattern: /^xcodebuild(\s|$)/ },
  { runner: 'swift-build', method: 'build', pattern: /^swift\s+build(\s|$)/ },
  { runner: 'vite-build', method: 'build', pattern: /^vite\s+build(\s|$)/ },
  { runner: 'make', method: 'build', pattern: /^make(\s|$)/ },
  // Package-manager scripts: intent is clear, runner is unknown until output is parsed.
  {
    runner: 'npm-script',
    method: 'test',
    pattern: /^(npm|pnpm|yarn|bun)\s+(run\s+)?test(:[\w-]+)?(\s|$)/,
    scopeUnknown: true,
  },
  {
    runner: 'npm-script',
    method: 'typecheck',
    pattern: /^(npm|pnpm|yarn|bun)\s+(run\s+)?(typecheck|type-check|tsc)(\s|$)/,
    scopeUnknown: true,
  },
  {
    runner: 'npm-script',
    method: 'lint',
    pattern: /^(npm|pnpm|yarn|bun)\s+(run\s+)?lint(\s|$)/,
    scopeUnknown: true,
  },
  {
    runner: 'npm-script',
    method: 'build',
    pattern: /^(npm|pnpm|yarn|bun)\s+(run\s+)?build(\s|$)/,
    scopeUnknown: true,
  },
];

const WATCH = /(^|\s)(--watch(=\S+)?|-w|--watchAll)(\s|$)/;
const PARTIAL =
  /(^|\s)(-k|-t|--grep|-g|--filter|-run|--only-testing|--testNamePattern|--testPathPattern|-x|--bail)(\s|=)/;

/** Package-manager script names that are commands themselves, not binaries to unwrap. */
const PM_SCRIPTS = new Set([
  'run',
  'test',
  'lint',
  'build',
  'typecheck',
  'type-check',
  'start',
  'dev',
  'exec',
  'dlx',
  'x',
  'add',
  'install',
  'i',
  'remove',
  'rm',
  'update',
  'up',
  'create',
  'init',
  'publish',
  'link',
  'why',
  'ls',
  'list',
  'outdated',
  'audit',
  'view',
  'info',
  'config',
  'cache',
  'store',
  'setup',
  'env',
  'patch',
]);

/**
 * Splits a compound command into segments and normalizes each to "<command word> <args>", where
 * the command word is the basename of the executable after removing env assignments and known
 * launcher prefixes.
 */
function normalizedSegments(command: string): string[] {
  const out: string[] = [];
  for (const raw of splitSegments(command)) {
    const seg = raw.real.trim();
    if (!seg) continue;
    const tokens = seg.split(/\s+/);
    // Leading env assignments (FOO=bar cmd).
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift();
    if (tokens.length === 0) continue;
    if (tokens[0] === 'cd') continue;
    // Launchers that run a binary given as the next token.
    for (let guard = 0; guard < 3; guard++) {
      const t0 = tokens[0] ?? '';
      const t1 = tokens[1] ?? '';
      if (t0 === 'npx' || t0 === 'bunx' || t0 === 'yarn') {
        if (t0 === 'yarn' && (PM_SCRIPTS.has(t1) || t1.startsWith('-') || !t1)) break;
        tokens.shift();
        if (tokens[0]?.startsWith('-')) tokens.shift(); // e.g. npx -y
        continue;
      }
      if (
        (t0 === 'pnpm' || t0 === 'npm' || t0 === 'bun') &&
        (t1 === 'exec' || t1 === 'dlx' || t1 === 'x')
      ) {
        tokens.splice(0, 2);
        continue;
      }
      if (t0 === 'pnpm' && t1 && !PM_SCRIPTS.has(t1) && !t1.startsWith('-')) {
        tokens.shift(); // pnpm <bin> runs a local binary directly
        continue;
      }
      if ((t0 === 'python' || t0 === 'python3') && t1 === '-m') {
        tokens.splice(0, 2);
        continue;
      }
      if (
        (t0 === 'bundle' && t1 === 'exec') ||
        ((t0 === 'poetry' || t0 === 'uv' || t0 === 'pipenv') && t1 === 'run')
      ) {
        tokens.splice(0, 2);
        continue;
      }
      break;
    }
    if (tokens.length === 0) continue;
    const head = tokens[0] ?? '';
    const base = head.slice(head.lastIndexOf('/') + 1);
    out.push([base, ...tokens.slice(1)].join(' '));
  }
  return out;
}

/** Detects paths passed to test runners (narrows scope). */
function hasPathArgs(segment: string): boolean {
  const tokens = segment.split(/\s+/).slice(1);
  return tokens.some(
    (t) =>
      !t.startsWith('-') && /\.(test|spec)\.[cm]?[jt]sx?$|\/|\.py$|\.rs$|\.go$|_test\b/.test(t),
  );
}

export function classifyCommand(command: string): CommandClassification | undefined {
  for (const segment of normalizedSegments(command)) {
    for (const rule of RULES) {
      if (!rule.pattern.test(segment)) continue;
      const watch = WATCH.test(segment);
      let scope: CommandClassification['scope'] = rule.scopeUnknown ? 'unknown' : 'full';
      if (!rule.scopeUnknown && (PARTIAL.test(segment) || hasPathArgs(segment))) scope = 'partial';
      return { method: rule.method, runner: rule.runner, scope, watch };
    }
  }
  return undefined;
}

const DESTRUCTIVE: Array<{ id: string; pattern: RegExp; summary: string }> = [
  {
    id: 'rm-rf',
    pattern: /(^|\s)rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/,
    summary: 'Recursive force delete',
  },
  {
    id: 'git-force-push',
    pattern: /(^|\s)git\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/,
    summary: 'Force push',
  },
  { id: 'git-reset-hard', pattern: /(^|\s)git\s+reset\s+--hard\b/, summary: 'Hard reset' },
  { id: 'git-clean', pattern: /(^|\s)git\s+clean\s+-[a-zA-Z]*f/, summary: 'git clean -f' },
  {
    id: 'git-checkout-discard',
    pattern: /(^|\s)git\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/,
    summary: 'Discard working tree changes',
  },
  {
    id: 'drop-table',
    pattern: /\bdrop\s+(table|database|schema)\b/i,
    summary: 'DROP TABLE/DATABASE',
  },
  {
    id: 'no-verify',
    pattern: /(^|\s)git\s+(commit|push)\b[^|;&]*\s--no-verify\b/,
    summary: 'Skipped git hooks (--no-verify)',
  },
  { id: 'chmod-777', pattern: /(^|\s)chmod\s+(-R\s+)?777\b/, summary: 'chmod 777' },
  { id: 'sudo', pattern: /(^|\s)sudo\s/, summary: 'sudo' },
];

/**
 * Blanks out heredoc bodies and quoted strings before scanning for dangerous commands. A shell
 * call that *writes* a script or commit message mentioning `rm -rf` is not itself destructive,
 * and flagging it costs more than it saves: false items train the reader to ignore the one
 * signal that is supposed to stop them. Spans are replaced by spaces of equal length so any
 * offsets and the surrounding text stay put.
 */
function maskLiterals(command: string): string {
  // Every character becomes a space except newlines, which stay put: offsets are preserved, and
  // so is the line structure the segment split below depends on. Blanking newlines too would
  // leave the masked copy with fewer lines than the real one, and the two would no longer agree
  // on which segment the match landed in — the reader would be shown a different line entirely.
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return command
    .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^[ \t]*\2[ \t]*$/gm, blank)
    .replace(/'[^']*'/g, blank)
    .replace(/"[^"]*"/g, blank);
}

/**
 * Reports which part of a compound command triggered the rule, not just that something did.
 * `cd /some/very/long/path && rm -rf build` matches on its second segment, and quoting the head
 * of the command would show the reader a harmless `cd` under a "recursive force delete" heading.
 *
 * A newline separates commands exactly as `;` does, and leaving it out of the split was the whole
 * of that failure in practice: agents send scripts, not one-liners, so the entire script was one
 * segment and the quoted head was whatever the script happened to open with. That can quote text
 * after the `rm` or even an unrelated heredoc line under the heading "Recursive force delete".
 */
const SEGMENT_SPLIT = /&&|\|\||;|\||\n/g;

interface CommandSegment {
  /** The segment as the agent wrote it, for quoting back to a reader. */
  real: string;
  /** The same span with quoted and heredoc text blanked, for matching against. */
  masked: string;
}

/**
 * Splits a compound command into its segments, on the masked copy so that a separator inside a
 * quoted string does not start one. `pgrep -af 'node --test|playwright test'` is one command that
 * looks for two runners, not three commands — split naively it produces a segment whose command
 * word is `playwright test`, and the classifier then reports the pipeline as a test run and reads
 * its exit code as the verdict. That can assert a passing test suite for a `pgrep`.
 *
 * Spans are cut by offset rather than by splitting both copies, because masking preserves length
 * but not separator count: `rg 'a|b'` is two parts split raw and one split masked, so matching
 * them up by index shows the reader a different segment than the one that matched.
 */
function splitSegments(command: string): CommandSegment[] {
  const masked = maskLiterals(command);
  const out: CommandSegment[] = [];
  let start = 0;
  SEGMENT_SPLIT.lastIndex = 0;
  for (let m = SEGMENT_SPLIT.exec(masked); m; m = SEGMENT_SPLIT.exec(masked)) {
    out.push({ real: command.slice(start, m.index), masked: masked.slice(start, m.index) });
    start = m.index + m[0].length;
  }
  out.push({ real: command.slice(start), masked: masked.slice(start) });
  return out;
}

export function detectDestructiveCommand(
  command: string,
): { id: string; summary: string; segment: string } | undefined {
  const segments = splitSegments(command);
  for (const rule of DESTRUCTIVE) {
    const hit = segments.find((s) => rule.pattern.test(s.masked));
    if (!hit) continue;
    // Report the real text; the segment was chosen on the masked copy, which is the same span.
    return { id: rule.id, summary: rule.summary, segment: hit.real.trim() };
  }
  return undefined;
}

const GIT_OPTS = String.raw`(?:(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-\w)\s+)*`;
const GIT_COMMIT = new RegExp(String.raw`(^|\s)git\s+${GIT_OPTS}commit\b`);
const GIT_PUSH = new RegExp(String.raw`(^|\s)git\s+${GIT_OPTS}push\b`);

export function detectGitCommand(command: string): 'commit' | 'push' | undefined {
  if (GIT_PUSH.test(command)) return 'push';
  if (GIT_COMMIT.test(command)) return 'commit';
  return undefined;
}
