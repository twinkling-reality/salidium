import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createConsumerCredential, type DaemonHandle, startDaemon } from '@salidium/daemon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMapCommand } from './mapCommand.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'salidium-map-cli-')));
const home = join(root, 'salidium');
const repo = join(root, 'repo');
const worktree = join(root, 'worktree');
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
let commit: string;

async function run(...argv: string[]) {
  let out = '';
  let err = '';
  const [subcommand, ...args] = argv;
  const code = await runMapCommand(
    home,
    subcommand,
    args,
    { json: false, cwd: root },
    { out: (text) => (out += text), err: (text) => (err += text) },
  );
  return { code, out, err };
}

beforeAll(() => {
  mkdirSync(repo);
  git('init', '-q');
  write('package.json', JSON.stringify({ name: 'pkg' }));
  write('src/a.ts', "import './b.ts';\n");
  write('src/b.ts', 'export {};\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  commit = git('rev-parse', 'HEAD');
  git('worktree', 'add', '-q', worktree);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('salidium map', () => {
  it('refuses to show or read a repository that is not allowed', async () => {
    const shown = await run('show', repo);
    expect(shown.code).toBe(1);
    expect(shown.err).toContain('is not allowed');
    expect(existsSync(join(home, 'project-map'))).toBe(false);
  });

  it('keys a worktree, or any directory inside a repository, by its main repository', async () => {
    const allowed = await run('allow', join(worktree, 'src'));
    expect(allowed.code).toBe(0);
    expect(allowed.out).toContain(`Salidium may now map ${repo}.`);
    expect(allowed.out).toContain(
      "Tools you've given a consumer credential can read this repository's committed structure.",
    );
    expect((await run('allow', repo)).out).toContain('was already allowed');
    const listed = await run('list');
    expect(listed.out.trim().split('\n')).toHaveLength(2);
    expect(listed.out).toContain(repo);
    expect(listed.out).not.toContain(worktree);
  });

  it('prints where objects are read from, and never prints control characters', async () => {
    const allowed = await run('allow', repo);
    expect(allowed.out).toContain(`Maps read its committed objects from ${join(repo, '.git')}.`);
    const crafted = join(root, 'esc\u001b[31mred\u009b');
    mkdirSync(crafted, { recursive: true });
    const refused = await run('allow', crafted);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('esc?[31mred?');
    expect(refused.err.includes('\u001b') || refused.err.includes('\u009b')).toBe(false);
  });

  it('refuses a directory that is not in a repository', async () => {
    const outside = join(root, 'plain');
    mkdirSync(outside, { recursive: true });
    const result = await run('allow', outside);
    expect(result.code).toBe(1);
    expect(result.err).toContain('is not inside a Git repository');
  });

  it('shows a summary at HEAD or at a full commit id', async () => {
    const head = await run('show', repo);
    expect(head.code).toBe(0);
    expect(head.out).toContain(`commit ${commit}`);
    expect(head.out).toContain('1 import edges between files');
    expect(head.out).toContain('Not analyzed:');
    expect((await run('show', worktree, commit)).code).toBe(0);
    const unknown = await run('show', repo, 'f'.repeat(40));
    expect([unknown.code, unknown.err.trim()]).toEqual([
      1,
      'the repository has no commit with that id',
    ]);
  });

  it('does not read HEAD through a .git repointed since the repository was allowed', async () => {
    const other = join(root, 'other');
    mkdirSync(other);
    execFileSync('git', ['-C', other, 'init', '-q'], { env });
    writeFileSync(join(other, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    const moved = join(root, 'moved');
    mkdirSync(moved);
    execFileSync('git', ['-C', moved, 'init', '-q'], { env });
    expect((await run('allow', moved)).code).toBe(0);
    rmSync(join(moved, '.git'), { recursive: true, force: true });
    writeFileSync(join(moved, '.git'), `gitdir: ${join(other, '.git')}\n`);
    const shownResult = await run('show', moved);
    expect(shownResult.code).toBe(1);
    expect(shownResult.err).toContain('now resolves to a different git directory');
    expect(shownResult.err).not.toContain('HEAD does not name a commit');
  });

  it('is enforced the same way by a running daemon', async () => {
    const daemon: DaemonHandle = await startDaemon({
      home,
      userHome: join(root, 'providers'),
      port: 0,
      providers: [],
      gitEnrichment: false,
      historyDays: 0,
      logLevel: 'silent',
      alertSink: { publish: () => {} },
    });
    try {
      const { token } = createConsumerCredential(home, 'cli test');
      const fetchMap = async () =>
        (
          await fetch(
            `http://127.0.0.1:${daemon.port}/project-map/v0/maps?repository=${encodeURIComponent(repo)}&commit=${commit}`,
            { headers: { Authorization: `Bearer ${token}` } },
          )
        ).status;
      expect(await fetchMap()).toBe(200);
      const cacheRoot = join(home, 'project-map', 'cache');
      expect(readdirSync(cacheRoot)).toHaveLength(1);
      const revoked = await run('revoke', worktree);
      expect(revoked.code).toBe(0);
      expect(await fetchMap()).toBe(404);
      expect(readdirSync(cacheRoot)).toHaveLength(0);
      expect((await run('allow', repo)).code).toBe(0);
      expect(await fetchMap()).toBe(200);
    } finally {
      await daemon.stop();
    }
  });

  it('revokes a repository that no longer exists by the root list shows', async () => {
    const gone = join(root, 'gone');
    mkdirSync(gone);
    execFileSync('git', ['-C', gone, 'init', '-q'], { env });
    expect((await run('allow', gone)).code).toBe(0);
    rmSync(gone, { recursive: true, force: true });
    expect((await run('revoke', gone)).code).toBe(0);
    expect((await run('list')).out).not.toContain(gone);
    expect((await run('revoke', gone)).code).toBe(1);
  });
});
