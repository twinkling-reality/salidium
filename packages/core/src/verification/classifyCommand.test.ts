import { describe, expect, it } from 'vitest';
import { classifyCommand, detectDestructiveCommand } from './classifyCommand.ts';

/**
 * Synthetic script shapes that pin which command segment a destructive-operation warning quotes.
 */
describe('detectDestructiveCommand', () => {
  it('quotes the offending line of a script, not the line it opens with', () => {
    const d = detectDestructiveCommand(
      'cd /Users/example/dev/sample-app\nrm -rf apps/demo/.cache-tool\npnpm --silent sample-tool',
    );
    expect(d?.id).toBe('rm-rf');
    expect(d?.segment).toBe('rm -rf apps/demo/.cache-tool');
  });

  it('does not run past the delete into the next command', () => {
    const d = detectDestructiveCommand(
      'rm -rf /tmp/sample/probe1/.cache-tool\nNO_COLOR=1 pnpm --silent sample-tool --cwd /tmp/sample',
    );
    expect(d?.segment).toBe('rm -rf /tmp/sample/probe1/.cache-tool');
  });

  it('still splits on the shell operators', () => {
    const d = detectDestructiveCommand('cd /some/very/long/path && rm -rf build');
    expect(d?.segment).toBe('rm -rf build');
  });

  it('keeps a heredoc body from being read as the offending line', () => {
    // The `rm -rf` is real and on its own line; the heredoc above it mentions nothing dangerous
    // but is long, and used to be what got quoted.
    const d = detectDestructiveCommand(
      "python3 - <<'PY'\nimport pathlib\np = pathlib.Path('x')\nPY\nrm -rf .cache-tool",
    );
    expect(d?.segment).toBe('rm -rf .cache-tool');
  });

  it('does not flag a command that merely writes text mentioning a delete', () => {
    expect(
      detectDestructiveCommand("git commit -m 'document why rm -rf .cache is needed'"),
    ).toBeUndefined();
    expect(
      detectDestructiveCommand("cat > cleanup.md <<'EOF'\nRun rm -rf build to clean.\nEOF"),
    ).toBeUndefined();
  });

  it('reports the line for a delete inside a loop body', () => {
    const d = detectDestructiveCommand(
      'for p in probe1 probeW\ndo rm -rf /tmp/sample-regress/$p/.cache-tool\ndone',
    );
    expect(d?.segment).toBe('do rm -rf /tmp/sample-regress/$p/.cache-tool');
  });
});

/**
 * A separator inside a quoted string is not a separator. Splitting on it produces a segment whose
 * command word is whatever the quotes contained, and the classifier then reports the pipeline as
 * a run of that tool and reads the exit code as its verdict. This used to let a `pgrep` assert a
 * passing test suite.
 */
describe('classifyCommand segmentation', () => {
  it('ignores runner names inside quoted arguments', () => {
    expect(
      classifyCommand(
        "pgrep -af 'node --test|astro check|playwright test|vite.*4321' || true\nlsof -nP -iTCP:4312",
      ),
    ).toBeUndefined();
    expect(classifyCommand("rg -n 'pnpm test|vitest' src")).toBeUndefined();
    expect(classifyCommand('echo "run pnpm test later"')).toBeUndefined();
  });

  it('treats a newline as a separator, so a check inside a script still counts', () => {
    expect(classifyCommand('cd packages/core\npnpm vitest run')).toMatchObject({
      method: 'test',
      runner: 'vitest',
    });
  });

  it('still classifies real compound commands', () => {
    expect(classifyCommand('npm run build && npm run lint')).toMatchObject({ method: 'build' });
    expect(classifyCommand('node --test tests/a.test.ts')).toMatchObject({ runner: 'node-test' });
  });
});
