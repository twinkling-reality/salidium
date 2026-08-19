import { describe, expect, it } from 'vitest';
import { classifyCommand, detectDestructiveCommand, detectGitCommand } from './classifyCommand.ts';
import { parseRunnerOutput, RUNNER_METHOD } from './parseRunnerOutput.ts';

describe('classifyCommand', () => {
  it('recognizes runners, scope and watch mode', () => {
    expect(classifyCommand('pnpm vitest run')).toMatchObject({
      runner: 'vitest',
      method: 'test',
      scope: 'full',
      watch: false,
    });
    expect(classifyCommand('npx vitest src/auth.test.ts')).toMatchObject({
      runner: 'vitest',
      scope: 'partial',
    });
    expect(classifyCommand('vitest --watch')?.watch).toBe(true);
    expect(classifyCommand('cd packages/core && pnpm test')).toMatchObject({
      runner: 'npm-script',
      method: 'test',
      scope: 'unknown',
    });
    expect(classifyCommand('FOO=1 cargo test -p core')).toMatchObject({
      runner: 'cargo',
      method: 'test',
    });
    expect(classifyCommand('go test ./...')).toMatchObject({ runner: 'go' });
    expect(classifyCommand('python -m pytest -k auth')).toMatchObject({
      runner: 'pytest',
      scope: 'partial',
    });
    expect(classifyCommand('xcodebuild -scheme App -destination x test')).toMatchObject({
      runner: 'xcodebuild',
      method: 'test',
    });
    expect(classifyCommand('swift build')).toMatchObject({ method: 'build' });
    expect(classifyCommand('npx tsc --noEmit')).toMatchObject({
      runner: 'tsc',
      method: 'typecheck',
    });
    expect(classifyCommand('biome check .')).toMatchObject({ runner: 'biome', method: 'lint' });
    expect(classifyCommand('ls -la')).toBeUndefined();
    expect(classifyCommand('git status')).toBeUndefined();
    // Runner names as arguments are not verification runs.
    expect(classifyCommand('pnpm add -D vitest')).toBeUndefined();
    expect(classifyCommand('rg pytest src/')).toBeUndefined();
    expect(classifyCommand('echo "run cargo test later"')).toBeUndefined();
    expect(classifyCommand('cat jest.config.ts')).toBeUndefined();
    expect(classifyCommand('pnpm vitest run')).toMatchObject({ runner: 'vitest' });
    expect(classifyCommand('npx -y vitest run')).toMatchObject({ runner: 'vitest' });
  });

  it('detects destructive and git commands', () => {
    expect(detectDestructiveCommand('rm -rf node_modules')?.id).toBe('rm-rf');
    expect(detectDestructiveCommand('git push --force origin main')?.id).toBe('git-force-push');
    expect(detectDestructiveCommand('git commit -m x --no-verify')?.id).toBe('no-verify');
    expect(detectDestructiveCommand('ls')).toBeUndefined();
    expect(detectGitCommand('git commit -m "x"')).toBe('commit');
    expect(detectGitCommand('git -C /repo push origin HEAD')).toBe('push');
    expect(detectGitCommand('git status')).toBeUndefined();
  });
});

describe('parseRunnerOutput', () => {
  it('vitest', () => {
    const out = parseRunnerOutput(
      'vitest',
      ' Test Files  2 passed (2)\n      Tests  10 passed | 1 skipped (11)\n',
    );
    expect(out).toMatchObject({
      runner: 'vitest',
      outcome: 'pass',
      counts: { passed: 10, skipped: 1, total: 11 },
    });
    expect(parseRunnerOutput('vitest', '      Tests  2 failed | 8 passed (10)')?.outcome).toBe(
      'fail',
    );
  });
  it('jest', () => {
    expect(
      parseRunnerOutput('jest', 'Tests:       1 failed, 2 skipped, 7 passed, 10 total'),
    ).toMatchObject({ outcome: 'fail', counts: { failed: 1, passed: 7, skipped: 2, total: 10 } });
  });
  it('pytest', () => {
    expect(
      parseRunnerOutput('pytest', '========== 3 failed, 42 passed, 1 skipped in 2.31s =========='),
    ).toMatchObject({ outcome: 'fail', counts: { failed: 3, passed: 42, skipped: 1, total: 46 } });
    expect(
      parseRunnerOutput('pytest', '=================== 12 passed in 0.10s ===================')
        ?.outcome,
    ).toBe('pass');
  });
  it('cargo aggregates multiple result lines', () => {
    const out = parseRunnerOutput(
      'cargo',
      'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\ntest result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out',
    );
    expect(out).toMatchObject({ outcome: 'fail', counts: { passed: 4, failed: 2 } });
  });
  it('go', () => {
    expect(
      parseRunnerOutput(
        'go',
        '--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\nFAIL\tgithub.com/x/y\t0.02s',
      ),
    ).toMatchObject({ outcome: 'fail', counts: { passed: 1, failed: 1 } });
    expect(parseRunnerOutput('go', 'ok  \tgithub.com/x/y\t0.02s')?.outcome).toBe('pass');
  });
  it('xcodebuild / swift', () => {
    expect(
      parseRunnerOutput(
        'xcodebuild',
        'Executed 20 tests, with 1 failure (0 unexpected) in 1.0 (1.1) seconds\n** TEST FAILED **',
      ),
    ).toMatchObject({ outcome: 'fail', counts: { total: 20, failed: 1 } });
    expect(
      parseRunnerOutput('swift', 'Test run with 8 tests passed after 0.5 seconds.'),
    ).toMatchObject({ outcome: 'pass', counts: { total: 8 } });
  });
  it('playwright, mocha, tsc, eslint, biome, node --test', () => {
    expect(
      parseRunnerOutput('playwright', '  1 failed\n  1 flaky\n  9 passed (12.3s)'),
    ).toMatchObject({ outcome: 'fail', counts: { failed: 1, passed: 9 } });
    expect(parseRunnerOutput('mocha', '  12 passing (1s)\n  1 failing')?.outcome).toBe('fail');
    expect(
      parseRunnerOutput('tsc', 'src/a.ts(1,1): error TS2322: x\nFound 1 error in src/a.ts'),
    ).toMatchObject({ outcome: 'fail', counts: { failed: 1 } });
    expect(parseRunnerOutput('eslint', '✖ 3 problems (0 errors, 3 warnings)')?.outcome).toBe(
      'pass',
    );
    expect(parseRunnerOutput('biome', 'Checked 42 files in 12ms. No fixes applied.')?.outcome).toBe(
      'pass',
    );
    expect(parseRunnerOutput('node-test', '# tests 3\n# pass 2\n# fail 1')).toMatchObject({
      outcome: 'fail',
      counts: { passed: 2, failed: 1 },
    });
  });
  it('npm-script falls through to any recognized reporter and strips ANSI', () => {
    expect(parseRunnerOutput('npm-script', '[32m Tests [0m 3 passed (3)')?.runner).toBe('vitest');
    expect(parseRunnerOutput('npm-script', 'nothing recognizable')).toBeUndefined();
  });

  it('attributes an ambiguous summary line to the method being run', () => {
    // Both tsc and biome end with "Found N errors"; `pnpm lint` must not be reported as tsc.
    const biome = 'Checked 105 files in 68ms. No fixes applied.\nFound 2 errors.';
    expect(parseRunnerOutput('npm-script', biome, 'lint')?.runner).toBe('biome');
    expect(parseRunnerOutput('npm-script', biome, 'typecheck')?.runner).toBe('tsc');
    // With no method the historical alias order still applies and must not throw.
    expect(parseRunnerOutput('npm-script', biome)?.runner).toBeTruthy();
  });
});

describe('method follows the output, not the command shape', () => {
  it('exports a method for each parser that reports one', () => {
    expect(RUNNER_METHOD.biome).toBe('lint');
    expect(RUNNER_METHOD.tsc).toBe('typecheck');
    expect(RUNNER_METHOD.vitest).toBe('test');
  });
});

describe('detectDestructiveCommand', () => {
  it('reports the segment that matched, not the head of the command', () => {
    const d = detectDestructiveCommand('cd /a/very/long/path/somewhere && rm -rf build');
    expect(d?.id).toBe('rm-rf');
    expect(d?.segment).toBe('rm -rf build');
  });

  it('ignores dangerous-looking text inside quotes and heredocs', () => {
    expect(detectDestructiveCommand('git commit -m "stop using rm -rf here"')).toBeUndefined();
    expect(detectDestructiveCommand("echo 'rm -rf /' > notes.txt")).toBeUndefined();
    const heredoc = ["python3 - <<'PY'", "s = 'a && rm -rf x'", 'PY'].join('\n');
    expect(detectDestructiveCommand(heredoc)).toBeUndefined();
  });

  it('still catches the real thing next to a quoted argument', () => {
    expect(detectDestructiveCommand('rm -rf "$BUILD_DIR"')?.id).toBe('rm-rf');
  });
});

describe('classifyCommand path prefixes', () => {
  it('recognizes runners invoked by path', () => {
    expect(classifyCommand('node_modules/.bin/vitest run')?.runner).toBe('vitest');
    expect(classifyCommand('./node_modules/.bin/tsc --build')?.runner).toBe('tsc');
    expect(classifyCommand('/usr/local/bin/pytest -q')?.runner).toBe('pytest');
  });
});

/**
 * `node --test` printed TAP when this parser was written and prints the `spec` reporter by
 * default from Node 22, so current sessions commonly contain the spec form.
 */
describe('node:test reporters', () => {
  const spec = 'ℹ tests 28\nℹ suites 0\nℹ pass 28\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\n';

  it('reads the spec reporter as well as TAP', () => {
    expect(parseRunnerOutput('node-test', spec)).toMatchObject({
      outcome: 'pass',
      counts: { passed: 28, failed: 0, total: 28 },
      rule: 'node-test.spec',
    });
    expect(parseRunnerOutput('node-test', '# tests 3\n# pass 2\n# fail 1')?.rule).toBe(
      'node-test.tap',
    );
  });

  it('sums every suite a call ran rather than reporting on the last', () => {
    // `a && b` is two processes and two summaries; the last one alone is not the run.
    expect(
      parseRunnerOutput('node-test', `ℹ pass 5\nℹ fail 0\n${spec}ℹ pass 3\nℹ fail 2\n`),
    ).toMatchObject({ outcome: 'fail', counts: { passed: 36, failed: 2 } });
  });

  it('says nothing when no summary was printed', () => {
    expect(parseRunnerOutput('node-test', '✔ a test ran (1ms)\n')).toBeUndefined();
  });
});

describe('swift counts', () => {
  it('does not report a negative pass count from two overlapping summaries', () => {
    // A grep-filtered log can keep part of both summaries, counting one failure twice.
    const r = parseRunnerOutput(
      'swift',
      'Test run with 1 test failed after 0.5 seconds.\nExecuted 0 tests, with 1 failure',
    );
    expect(r?.outcome).toBe('fail');
    expect(r?.counts?.passed).toBeUndefined();
  });
});

describe('astro', () => {
  const check = (errors: number) =>
    `Result (534 files): \n- ${errors} errors\n- 0 warnings\n- 3 hints\n`;
  it('reads the check totals, which sit under the line that names them', () => {
    expect(parseRunnerOutput('astro', check(2))).toMatchObject({
      outcome: 'fail',
      counts: { failed: 2 },
    });
    expect(parseRunnerOutput('astro', check(0))?.outcome).toBe('pass');
  });
  it('reads a finished build as a pass, since the check gates it', () => {
    expect(
      parseRunnerOutput(
        'astro',
        '10:00:00 [build] 14 page(s) built in 1.05s\n10:00:00 [build] Complete!\n',
      ),
    ).toMatchObject({ outcome: 'pass', rule: 'astro.build' });
  });
  it('is reachable through a package-manager build script', () => {
    expect(parseRunnerOutput('npm-script', check(1), 'build')?.runner).toBe('astro');
  });
  it('says nothing about a build still running', () => {
    expect(parseRunnerOutput('astro', '> astro check && astro build\n')).toBeUndefined();
  });
});
