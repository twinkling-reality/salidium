import type { VerificationCounts, VerificationOutcome } from '../state/runState.ts';

export interface RunnerSummary {
  runner: string;
  outcome: VerificationOutcome;
  counts?: VerificationCounts;
  /** Which summary rule matched, for provenance. */
  rule: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters by definition.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function lastMatch(re: RegExp, text: string): RegExpExecArray | undefined {
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | undefined;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic global-regex iteration
  while ((m = g.exec(text)) !== null) last = m;
  return last;
}

/** Parses "N failed | M passed (T)"-style token lists (vitest) into counts. */
function tokenCounts(parts: string): VerificationCounts {
  const c: VerificationCounts = {};
  for (const m of parts.matchAll(
    /(\d+)\s+(failed|passed|skipped|todo|pending|expected fail|flaky)/g,
  )) {
    const n = Number(m[1]);
    switch (m[2]) {
      case 'failed':
        c.failed = (c.failed ?? 0) + n;
        break;
      case 'passed':
        c.passed = (c.passed ?? 0) + n;
        break;
      default:
        c.skipped = (c.skipped ?? 0) + n;
    }
  }
  return c;
}

/** Totals every `<label> <n>` summary line in the text; undefined when none appear. */
function sumLabelled(re: RegExp, text: string): { pass: number; fail: number } | undefined {
  let seen = false;
  const out = { pass: 0, fail: 0 };
  for (const m of text.matchAll(re)) {
    seen = true;
    if (m[1] === 'pass') out.pass += num(m[2]) ?? 0;
    else out.fail += num(m[2]) ?? 0;
  }
  return seen ? out : undefined;
}

function outcomeFromCounts(c: VerificationCounts | undefined): VerificationOutcome {
  if (!c) return 'unknown';
  if ((c.failed ?? 0) > 0) return 'fail';
  if ((c.passed ?? 0) > 0) return 'pass';
  // Nothing failed but nothing passed either (everything skipped/todo): not evidence of a pass.
  return 'unknown';
}

type Parser = (text: string) => RunnerSummary | undefined;

const parsers: Record<string, Parser> = {
  vitest: (t) => {
    const tests = lastMatch(/^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/m, t);
    const files = lastMatch(/^\s*Test Files\s+(.+?)\s*\((\d+)\)\s*$/m, t);
    const src = tests ?? files;
    if (!src) {
      if (/No test files found/i.test(t))
        return { runner: 'vitest', outcome: 'unknown', rule: 'vitest.none' };
      return undefined;
    }
    const counts = tokenCounts(src[1] ?? '');
    counts.total = num(src[2]);
    return { runner: 'vitest', outcome: outcomeFromCounts(counts), counts, rule: 'vitest.summary' };
  },
  jest: (t) => {
    const m = lastMatch(/^Tests:\s+(.+?),\s*(\d+)\s+total\s*$/m, t);
    if (!m) return undefined;
    const counts = tokenCounts(m[1] ?? '');
    counts.total = num(m[2]);
    return { runner: 'jest', outcome: outcomeFromCounts(counts), counts, rule: 'jest.summary' };
  },
  pytest: (t) => {
    const m = lastMatch(/^=+\s+(.+?)\s+in\s+[\d.]+s(?:\s+\([^)]*\))?\s+=+\s*$/m, t);
    if (!m) {
      if (/no tests ran/i.test(t))
        return { runner: 'pytest', outcome: 'unknown', rule: 'pytest.none' };
      return undefined;
    }
    const counts: VerificationCounts = {};
    for (const p of (m[1] ?? '').matchAll(
      /(\d+)\s+(failed|passed|skipped|deselected|xfailed|xpassed|errors?|warnings?)/g,
    )) {
      const n = Number(p[1]);
      const k = p[2] ?? '';
      if (k === 'failed' || k.startsWith('error')) counts.failed = (counts.failed ?? 0) + n;
      else if (k === 'passed' || k === 'xpassed') counts.passed = (counts.passed ?? 0) + n;
      else if (k === 'skipped' || k === 'xfailed' || k === 'deselected')
        counts.skipped = (counts.skipped ?? 0) + n;
    }
    counts.total = (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.skipped ?? 0);
    return { runner: 'pytest', outcome: outcomeFromCounts(counts), counts, rule: 'pytest.summary' };
  },
  cargo: (t) => {
    const all = [
      ...t.matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm),
    ];
    if (all.length === 0) {
      if (/^error(\[E\d+\])?:/m.test(t))
        return { runner: 'cargo', outcome: 'fail', rule: 'cargo.compile-error' };
      return undefined;
    }
    const counts: VerificationCounts = { passed: 0, failed: 0, skipped: 0 };
    let failed = false;
    for (const m of all) {
      if (m[1] === 'FAILED') failed = true;
      counts.passed = (counts.passed ?? 0) + Number(m[2]);
      counts.failed = (counts.failed ?? 0) + Number(m[3]);
      counts.skipped = (counts.skipped ?? 0) + Number(m[4]);
    }
    counts.total = (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.skipped ?? 0);
    return {
      runner: 'cargo',
      outcome: failed || (counts.failed ?? 0) > 0 ? 'fail' : 'pass',
      counts,
      rule: 'cargo.summary',
    };
  },
  go: (t) => {
    const pkgs = [...t.matchAll(/^(ok|FAIL|\?)\s+(\S+)/gm)];
    if (pkgs.length === 0) return undefined;
    const tests = [...t.matchAll(/^\s*--- (PASS|FAIL|SKIP): /gm)];
    const counts: VerificationCounts = {};
    if (tests.length > 0) {
      counts.passed = tests.filter((m) => m[1] === 'PASS').length;
      counts.failed = tests.filter((m) => m[1] === 'FAIL').length;
      counts.skipped = tests.filter((m) => m[1] === 'SKIP').length;
      counts.total = tests.length;
    }
    const anyFail = pkgs.some((m) => m[1] === 'FAIL') || /\[build failed\]/.test(t);
    return {
      runner: 'go',
      outcome: anyFail ? 'fail' : 'pass',
      counts: tests.length ? counts : undefined,
      rule: 'go.package-lines',
    };
  },
  xcodebuild: (t) => {
    const marker = lastMatch(/\*\* (TEST|BUILD) (SUCCEEDED|FAILED|EXECUTE FAILED) \*\*/, t);
    const executed = lastMatch(
      /Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures?/,
      t,
    );
    if (!marker && !executed) return undefined;
    const counts: VerificationCounts | undefined = executed
      ? {
          total: num(executed[1]),
          skipped: num(executed[2]) ?? 0,
          failed: num(executed[3]),
          passed: (num(executed[1]) ?? 0) - (num(executed[3]) ?? 0) - (num(executed[2]) ?? 0),
        }
      : undefined;
    const outcome: VerificationOutcome = marker
      ? marker[2] === 'SUCCEEDED'
        ? 'pass'
        : 'fail'
      : outcomeFromCounts(counts);
    return { runner: 'xcodebuild', outcome, counts, rule: 'xcodebuild.marker' };
  },
  swift: (t) => {
    const st = lastMatch(
      /Test run with (\d+) tests?(?: in \d+ suites?)? (passed|failed) after [\d.]+ seconds(?: with (\d+) issues?)?/,
      t,
    );
    const xct = lastMatch(
      /Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures?/,
      t,
    );
    if (!st && !xct) {
      if (/^error:/m.test(t) || /Compiling.*\n.*error:/.test(t))
        return { runner: 'swift', outcome: 'fail', rule: 'swift.compile-error' };
      return undefined;
    }
    const counts: VerificationCounts = {};
    let outcome: VerificationOutcome = 'unknown';
    if (st) {
      counts.total = (counts.total ?? 0) + (num(st[1]) ?? 0);
      const issues = num(st[3]) ?? 0;
      counts.failed = (counts.failed ?? 0) + (st[2] === 'failed' ? Math.max(1, issues) : 0);
      outcome = st[2] === 'passed' ? 'pass' : 'fail';
    }
    if (xct) {
      counts.total = (counts.total ?? 0) + (num(xct[1]) ?? 0);
      counts.failed = (counts.failed ?? 0) + (num(xct[3]) ?? 0);
      counts.skipped = (counts.skipped ?? 0) + (num(xct[2]) ?? 0);
      if ((num(xct[3]) ?? 0) > 0) outcome = 'fail';
      else if (outcome === 'unknown') outcome = 'pass';
    }
    // Swift prints two summaries and a grep-filtered log can keep parts of both, which can count
    // one failure twice and produce a negative pass count.
    // A negative pass count is arithmetic rather than evidence, so it is left unsaid.
    const passed = (counts.total ?? 0) - (counts.failed ?? 0) - (counts.skipped ?? 0);
    if (passed >= 0) counts.passed = passed;
    return { runner: 'swift', outcome, counts, rule: 'swift.summary' };
  },
  playwright: (t) => {
    const passed = lastMatch(/^\s*(\d+) passed(?: \([^)]*\))?\s*$/m, t);
    const failed = lastMatch(/^\s*(\d+) failed\s*$/m, t);
    const skipped = lastMatch(/^\s*(\d+) skipped\s*$/m, t);
    const flaky = lastMatch(/^\s*(\d+) flaky\s*$/m, t);
    if (!passed && !failed) return undefined;
    const counts: VerificationCounts = {
      passed: num(passed?.[1]) ?? 0,
      failed: num(failed?.[1]) ?? 0,
      skipped: (num(skipped?.[1]) ?? 0) + (num(flaky?.[1]) ?? 0),
    };
    counts.total = (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.skipped ?? 0);
    return {
      runner: 'playwright',
      outcome: outcomeFromCounts(counts),
      counts,
      rule: 'playwright.summary',
    };
  },
  mocha: (t) => {
    const passing = lastMatch(/^\s*(\d+) passing/m, t);
    const failing = lastMatch(/^\s*(\d+) failing/m, t);
    const pending = lastMatch(/^\s*(\d+) pending/m, t);
    if (!passing && !failing) return undefined;
    const counts: VerificationCounts = {
      passed: num(passing?.[1]) ?? 0,
      failed: num(failing?.[1]) ?? 0,
      skipped: num(pending?.[1]) ?? 0,
    };
    counts.total = (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.skipped ?? 0);
    return { runner: 'mocha', outcome: outcomeFromCounts(counts), counts, rule: 'mocha.summary' };
  },
  // `node --test` prints TAP when piped on older Node and the `spec` reporter by default since
  // Node 22, so a store recorded today is almost all `ℹ pass N`. Both are summed rather than
  // read from the last block: one call often runs several suites (`a && b`), and each process
  // prints its own summary — taking the last would report on the final suite as if it were the
  // whole run.
  'node-test': (t) => {
    const tap = sumLabelled(/^# (pass|fail) (\d+)$/gm, t);
    const spec = sumLabelled(/^ℹ (pass|fail) (\d+)$/gm, t);
    const hit = spec ?? tap;
    if (!hit) return undefined;
    const counts: VerificationCounts = { passed: hit.pass, failed: hit.fail };
    counts.total = hit.pass + hit.fail;
    return {
      runner: 'node-test',
      outcome: outcomeFromCounts(counts),
      counts,
      rule: spec ? 'node-test.spec' : 'node-test.tap',
    };
  },
  // `astro check && astro build` is the shape of an Astro project's build script. The check
  // prints its totals as a list under a header, so the count is not on the line that names it.
  astro: (t) => {
    const check = lastMatch(/^Result \(\d+ files?\):[ \t]*\n-[ \t]*(\d+) errors?/m, t);
    if (check) {
      const failed = num(check[1]) ?? 0;
      return {
        runner: 'astro',
        outcome: failed > 0 ? 'fail' : 'pass',
        counts: { failed },
        rule: 'astro.check',
      };
    }
    // The build only runs if the check passed, and only says this once it has finished.
    if (/\[build\] Complete!/.test(t))
      return { runner: 'astro', outcome: 'pass', rule: 'astro.build' };
    return undefined;
  },
  dotnet: (t) => {
    const m = lastMatch(
      /(Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)/,
      t,
    );
    if (!m) return undefined;
    const counts: VerificationCounts = {
      failed: num(m[2]),
      passed: num(m[3]),
      skipped: num(m[4]),
      total: num(m[5]),
    };
    return { runner: 'dotnet', outcome: outcomeFromCounts(counts), counts, rule: 'dotnet.summary' };
  },
  rspec: (t) => {
    const m = lastMatch(/^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/m, t);
    if (!m) return undefined;
    const counts: VerificationCounts = {
      total: num(m[1]),
      failed: num(m[2]),
      skipped: num(m[3]) ?? 0,
    };
    counts.passed = (counts.total ?? 0) - (counts.failed ?? 0) - (counts.skipped ?? 0);
    return { runner: 'rspec', outcome: outcomeFromCounts(counts), counts, rule: 'rspec.summary' };
  },
  mix: (t) => {
    const m = lastMatch(/^(\d+) tests?, (\d+) failures?/m, t);
    if (!m) return undefined;
    const counts: VerificationCounts = { total: num(m[1]), failed: num(m[2]) };
    counts.passed = (counts.total ?? 0) - (counts.failed ?? 0);
    return { runner: 'mix', outcome: outcomeFromCounts(counts), counts, rule: 'mix.summary' };
  },
  phpunit: (t) => {
    const ok = lastMatch(/^OK \((\d+) tests?, \d+ assertions?\)/m, t);
    if (ok)
      return {
        runner: 'phpunit',
        outcome: 'pass',
        counts: { total: num(ok[1]), passed: num(ok[1]), failed: 0 },
        rule: 'phpunit.ok',
      };
    const m = lastMatch(
      /^Tests: (\d+), Assertions: \d+(?:, Failures: (\d+))?(?:, Errors: (\d+))?/m,
      t,
    );
    if (!m) return undefined;
    const failed = (num(m[2]) ?? 0) + (num(m[3]) ?? 0);
    return {
      runner: 'phpunit',
      outcome: failed > 0 ? 'fail' : 'pass',
      counts: { total: num(m[1]), failed, passed: (num(m[1]) ?? 0) - failed },
      rule: 'phpunit.summary',
    };
  },
  tsc: (t) => {
    const found = lastMatch(/Found (\d+) errors?/, t);
    if (found)
      return {
        runner: 'tsc',
        outcome: Number(found[1]) > 0 ? 'fail' : 'pass',
        counts: { failed: num(found[1]) },
        rule: 'tsc.found',
      };
    if (/error TS\d+:/.test(t))
      return {
        runner: 'tsc',
        outcome: 'fail',
        counts: { failed: (t.match(/error TS\d+:/g) ?? []).length },
        rule: 'tsc.errors',
      };
    return undefined;
  },
  eslint: (t) => {
    const m = lastMatch(/✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/, t);
    if (m)
      return {
        runner: 'eslint',
        outcome: Number(m[2]) > 0 ? 'fail' : 'pass',
        counts: { failed: num(m[2]) },
        rule: 'eslint.summary',
      };
    return undefined;
  },
  biome: (t) => {
    const m = lastMatch(/Found (\d+) errors?/, t);
    if (m)
      return {
        runner: 'biome',
        outcome: Number(m[1]) > 0 ? 'fail' : 'pass',
        counts: { failed: num(m[1]) },
        rule: 'biome.errors',
      };
    if (/Checked \d+ files? in/.test(t))
      return { runner: 'biome', outcome: 'pass', rule: 'biome.checked' };
    return undefined;
  },
};

/** Alias parsers for runners whose output matches an existing parser. */
const ALIASES: Record<string, string[]> = {
  'npm-script': [
    'vitest',
    'jest',
    'playwright',
    'mocha',
    'node-test',
    'tsc',
    'eslint',
    'biome',
    'pytest',
    'astro',
  ],
  ruff: [],
  mypy: [],
  pyright: [],
  clippy: ['cargo'],
  'cargo-build': ['cargo'],
  'go-build': ['go'],
  'swift-build': ['swift'],
  'vite-build': [],
  make: ['vitest', 'jest', 'pytest', 'cargo', 'go'],
  gradle: [],
  maven: [],
  'golangci-lint': [],
};

/**
 * Which method each parser reports on. Several runners print the same summary line — `tsc` and
 * `biome` both end with "Found N errors" — so when a package-manager script hides the real
 * binary, the alias order alone decides who claims the output. Trying same-method parsers first
 * keeps `pnpm lint` from being reported as a typecheck.
 */
export const RUNNER_METHOD: Record<string, string> = {
  vitest: 'test',
  jest: 'test',
  playwright: 'test',
  mocha: 'test',
  'node-test': 'test',
  pytest: 'test',
  cargo: 'test',
  go: 'test',
  swift: 'test',
  dotnet: 'test',
  rspec: 'test',
  mix: 'test',
  phpunit: 'test',
  xcodebuild: 'build',
  astro: 'build',
  tsc: 'typecheck',
  eslint: 'lint',
  biome: 'lint',
};

/**
 * Parses runner output into a summary. Tries the classified runner first, then any aliases —
 * ordered so that parsers for the method we believe we are running are consulted before the
 * rest. Returns undefined when nothing recognizable was printed; the caller then falls back to
 * the exit status and must say so.
 */
export function parseRunnerOutput(
  runner: string,
  rawOutput: string,
  method?: string,
): RunnerSummary | undefined {
  const text = stripAnsi(rawOutput);
  const direct = parsers[runner];
  if (direct) {
    const r = direct(text);
    if (r) return r;
  }
  const aliases = ALIASES[runner] ?? [];
  const ordered =
    method === undefined
      ? aliases
      : [
          ...aliases.filter((a) => RUNNER_METHOD[a] === method),
          ...aliases.filter((a) => RUNNER_METHOD[a] !== method),
        ];
  for (const alias of ordered) {
    const r = parsers[alias]?.(text);
    if (r) return r;
  }
  return undefined;
}

export const KNOWN_RUNNER_PARSERS = Object.keys(parsers);
