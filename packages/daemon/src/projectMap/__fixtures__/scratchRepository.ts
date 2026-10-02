import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A scratch Git repository for tests, created with the developer's own Git configuration switched
 * off so a test sees the same repository on every machine.
 */
export function scratchRepository(options: { objectFormat?: 'sha1' | 'sha256' } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'salidium-map-repo-')));
  const dir = join(parent, 'repo');
  mkdirSync(dir);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const git = (args: string[], input?: string): string =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env,
      ...(input === undefined ? {} : { input }),
    }).trim();
  git(['init', '-q', `--object-format=${options.objectFormat ?? 'sha1'}`]);
  return {
    parent,
    dir,
    git,
    write(path: string, text: string | Buffer): void {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    },
    commit(message = 'commit'): string {
      git(['add', '-A']);
      git(['commit', '-q', '--allow-empty', '-m', message]);
      return git(['rev-parse', 'HEAD']);
    },
    /** Path of a loose object, for tests that remove one. */
    objectPath(oid: string): string {
      return join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
    },
    remove(): void {
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

export type ScratchRepository = ReturnType<typeof scratchRepository>;
