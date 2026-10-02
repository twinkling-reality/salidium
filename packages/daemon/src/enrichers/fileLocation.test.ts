import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalEvent, StoredEvent } from '@salidium/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import type { Logger } from '../logging/logger.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { FileLocationEnricher, RepositoryLocator } from './fileLocation.ts';

/*
 * Repositories here are built by hand, as the files Git leaves on disk, because the locator never
 * runs git and must not depend on it: a directory `.git` with `HEAD`, and for a linked worktree a
 * `.git` file whose `gitdir:` names a directory holding `HEAD` and `commondir`.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), 'salidium-locate-')));
const users = join(root, 'Users');
const me = join(users, 'me');
const other = join(users, 'other');

function gitDir(dir: string, extra: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
}

const repo = join(me, 'dev', 'repo');
gitDir(join(repo, '.git'));
mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
// A linked worktree outside the repository, as agents create them.
const tree = join(me, 'dev', 'repo-lane');
mkdirSync(tree, { recursive: true });
gitDir(join(repo, '.git', 'worktrees', 'repo-lane'), { commondir: '../..\n' });
writeFileSync(join(tree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'repo-lane')}\n`);
// The same, with the relative pointer Git writes under `worktree.useRelativePaths`.
const relativeTree = join(me, 'dev', 'repo-relative');
mkdirSync(relativeTree, { recursive: true });
gitDir(join(repo, '.git', 'worktrees', 'repo-relative'), { commondir: '../..\n' });
writeFileSync(join(relativeTree, '.git'), 'gitdir: ../repo/.git/worktrees/repo-relative\n');
// Broken or suspicious metadata.
const dangling = join(me, 'dev', 'dangling');
mkdirSync(join(dangling, 'src'), { recursive: true });
writeFileSync(join(dangling, '.git'), `gitdir: ${join(me, 'nowhere')}\n`);
const headless = join(me, 'dev', 'headless');
mkdirSync(join(headless, '.git'), { recursive: true });
const linkedGit = join(me, 'dev', 'linked-git');
mkdirSync(linkedGit, { recursive: true });
symlinkSync(join(repo, '.git'), join(linkedGit, '.git'));
const badCommon = join(me, 'dev', 'bad-common');
mkdirSync(badCommon, { recursive: true });
gitDir(join(repo, '.git', 'worktrees', 'bad-common'), { commondir: `${join(me, 'plain')}\n` });
mkdirSync(join(me, 'plain'), { recursive: true });
writeFileSync(
  join(badCommon, '.git'),
  `gitdir: ${join(repo, '.git', 'worktrees', 'bad-common')}\n`,
);
const oversized = join(me, 'dev', 'oversized');
mkdirSync(oversized, { recursive: true });
writeFileSync(join(oversized, '.git'), `gitdir: ${'x'.repeat(5000)}${join(repo, '.git')}\n`);
// Another user's repository, and a tree of ours whose pointer leads into their home.
const theirs = join(other, 'repo');
gitDir(join(theirs, '.git'));
gitDir(join(theirs, '.git', 'worktrees', 'borrowed'), { commondir: '../..\n' });
const borrowed = join(me, 'dev', 'borrowed');
mkdirSync(borrowed, { recursive: true });
writeFileSync(join(borrowed, '.git'), `gitdir: ${join(theirs, '.git', 'worktrees', 'borrowed')}\n`);
// A directory reached through a symlink, and a scratch directory outside every repository.
symlinkSync(join(repo, 'src'), join(me, 'shortcut'));
const scratch = join(root, 'scratch');
mkdirSync(scratch, { recursive: true });

afterAll(() => rmSync(root, { recursive: true, force: true }));

const locator = () => new RepositoryLocator({ home: me });

describe('locating the repository that holds a changed file', () => {
  it('finds the main working tree and the path inside it', async () => {
    expect(await locator().locate(join(repo, 'src', 'deep', 'a.ts'))).toEqual({
      root: repo,
      path: 'src/deep/a.ts',
    });
  });

  it('names both the worktree and the repository it belongs to, by absolute or relative pointer', async () => {
    expect(await locator().locate(join(tree, 'src', 'b.ts'))).toEqual({
      root: tree,
      path: 'src/b.ts',
      mainRoot: repo,
    });
    expect(await locator().locate(join(relativeTree, 'c.ts'))).toEqual({
      root: relativeTree,
      path: 'c.ts',
      mainRoot: repo,
    });
  });

  it('locates a file whose directory is already gone, by the nearest directory that exists', async () => {
    expect(await locator().locate(join(repo, 'removed', 'deeper', 'd.ts'))).toEqual({
      root: repo,
      path: 'removed/deeper/d.ts',
    });
  });

  it('follows a symlinked directory to where it really is', async () => {
    expect(await locator().locate(join(me, 'shortcut', 'e.ts'))).toEqual({
      root: repo,
      path: 'src/e.ts',
    });
  });

  it('says null outside any repository, and for a relative path, rather than guessing', async () => {
    expect(await locator().locate(join(scratch, 'f.ts'))).toBeNull();
    expect(await locator().locate('src/f.ts')).toBeNull();
  });

  it('says null when the nearest .git is not a repository, instead of looking further up', async () => {
    const l = locator();
    expect(await l.locate(join(dangling, 'src', 'g.ts'))).toBeNull();
    expect(await l.locate(join(headless, 'g.ts'))).toBeNull();
    expect(await l.locate(join(linkedGit, 'g.ts'))).toBeNull();
    expect(await l.locate(join(badCommon, 'g.ts'))).toBeNull();
    // Only the first kilobyte of a pointer is read, so an overlong one names nothing.
    expect(await l.locate(join(oversized, 'g.ts'))).toBeNull();
  });

  it("never reports another user's home, whether the path or a pointer leads there", async () => {
    expect(await locator().locate(join(theirs, 'h.ts'))).toBeNull();
    expect(await locator().locate(join(borrowed, 'h.ts'))).toBeNull();
  });

  it('remembers directories for a while and then looks again', async () => {
    let now = 0;
    const l = new RepositoryLocator({ home: me, now: () => now });
    const fresh = join(me, 'dev', 'fresh');
    mkdirSync(fresh, { recursive: true });
    expect(await l.locate(join(fresh, 'i.ts'))).toBeNull();
    gitDir(join(fresh, '.git'));
    expect(await l.locate(join(fresh, 'i.ts'))).toBeNull();
    now = 61_000;
    expect(await l.locate(join(fresh, 'i.ts'))).toEqual({ root: fresh, path: 'i.ts' });
  });
});

describe('file locations for live sessions', () => {
  const NOW = Date.parse('2026-10-02T12:00:00.000Z');
  const quiet = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

  function harness() {
    let subscriber: ((sessionId: string, events: StoredEvent[]) => void) | undefined;
    const ingested: CanonicalEvent[] = [];
    const registry = {
      subscribeAll(sub: (sessionId: string, events: StoredEvent[]) => void) {
        subscriber = sub;
        return () => {};
      },
      ingest: (_sessionId: string, events: CanonicalEvent[]) => ingested.push(...events),
    } as unknown as SessionRegistry;
    const enricher = new FileLocationEnricher(registry, quiet, {
      now: () => NOW,
      locator: new RepositoryLocator({ home: me, now: () => NOW }),
    });
    enricher.start();
    let seq = 0;
    const change = (paths: string[], ts = new Date(NOW - 1000).toISOString()) =>
      subscriber?.('codex:t', [
        {
          id: `c${seq}`,
          sessionId: 'codex:t',
          ts,
          tsSource: 'provider',
          source: { provider: 'codex', channel: 'rollout' },
          seq: seq++,
          kind: 'tool.completed',
          callId: `call${seq}`,
          toolName: 'apply_patch',
          isError: false,
          result: {
            kind: 'fileChanges',
            changes: paths.map((path) => ({
              path,
              change: 'update' as const,
              linesAdded: 1,
              linesRemoved: 0,
              applied: true,
            })),
          },
        } as StoredEvent,
      ]);
    const located = () =>
      ingested.flatMap((e) => (e.kind === 'file.located' ? [e.files] : [])).flat();
    return { enricher, change, located, ingested };
  }

  it('reports each changed path once, and again only when its answer changes', async () => {
    const { enricher, change, located } = harness();
    change([join(tree, 'a.ts'), join(scratch, 'b.ts')]);
    change([join(tree, 'a.ts')]);
    await enricher.settled();
    expect(located()).toEqual([
      { path: join(tree, 'a.ts'), repository: { root: tree, path: 'a.ts', mainRoot: repo } },
      { path: join(scratch, 'b.ts'), repository: null },
    ]);
  });

  it('labels the event as Salidium’s own observation, beside the change that prompted it', async () => {
    const { enricher, change, ingested } = harness();
    change([join(repo, 'src', 'k.ts')]);
    await enricher.settled();
    expect(ingested[0]).toMatchObject({
      kind: 'file.located',
      tsSource: 'ingest',
      source: { provider: 'codex', channel: 'salidium' },
    });
  });

  it('never looks for a change read from history', async () => {
    const { enricher, change, located } = harness();
    change([join(repo, 'src', 'l.ts')], '2026-09-01T00:00:00.000Z');
    await enricher.settled();
    expect(located()).toEqual([]);
  });
});
