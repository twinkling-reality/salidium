import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { type ScratchRepository, scratchRepository } from './__fixtures__/scratchRepository.ts';
import { DEFAULT_BOUNDS } from './build.ts';
import { ProjectMapCache } from './cache.ts';
import { allowRepository, listOptedInRepositories, revokeRepository } from './optIn.ts';
import { DaemonProjectMapService } from './service.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(options: { objectFormat?: 'sha1' | 'sha256' } = {}) {
  const repo = scratchRepository(options);
  const home = mkdtempSync(join(tmpdir(), 'salidium-map-home-'));
  cleanups.push(() => {
    repo.remove();
    rmSync(home, { recursive: true, force: true });
  });
  return { repo, home };
}

function basicTree(repo: ScratchRepository): string {
  repo.write('package.json', JSON.stringify({ name: 'pkg' }));
  repo.write('src/a.ts', "import { b } from './b.ts';\n");
  repo.write('src/b.ts', 'export const b = 1;\n');
  return repo.commit();
}

describe('opt-in', () => {
  test('nothing is read for a repository that is not opted in', async () => {
    const { repo, home } = setup();
    const commit = basicTree(repo);
    let gitRequested = 0;
    const maps = new DaemonProjectMapService({
      home,
      git: () => {
        gitRequested += 1;
        return undefined;
      },
    });
    expect(maps.isOptedIn(repo.dir)).toBe(false);
    expect(await maps.getMap(repo.dir, commit)).toMatchObject({
      ok: false,
      refusal: { error: 'not-opted-in' },
    });
    expect(await maps.commitExists(repo.dir, commit)).toMatchObject({
      ok: false,
      refusal: { error: 'not-opted-in' },
    });
    expect(gitRequested).toBe(0);
    expect(existsSync(join(home, 'project-map'))).toBe(false);
  });

  test('roots are compared exactly, never resolved from the request', async () => {
    const { repo, home } = setup();
    const commit = basicTree(repo);
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const link = join(repo.parent, 'link');
    symlinkSync(repo.dir, link);
    const maps = new DaemonProjectMapService({ home });
    for (const root of [link, `${repo.dir}/`, `${repo.dir}/src`, `${repo.dir}/../repo`])
      expect((await maps.getMap(root, commit)).ok, root).toBe(false);
    expect((await maps.getMap(repo.dir, commit)).ok).toBe(true);
  });

  test('a revocation applies to the next request and its cache is unreachable', async () => {
    const { repo, home } = setup();
    const commit = basicTree(repo);
    const { repository } = allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const maps = new DaemonProjectMapService({ home });
    expect((await maps.getMap(repo.dir, commit)).ok).toBe(true);
    const cache = new ProjectMapCache(home);
    expect(readdirSync(cache.directoryFor(repository))).toHaveLength(1);
    expect(revokeRepository(home, repo.dir)).toBe(true);
    expect(await maps.getMap(repo.dir, commit)).toMatchObject({
      ok: false,
      refusal: { error: 'not-opted-in' },
    });
    // Allowed again, it starts from an empty cache directory rather than the old opt-in's.
    const again = allowRepository(
      home,
      repo.dir,
      join(repo.dir, '.git'),
      new Date(Date.now() + 1000),
    ).repository;
    expect(cache.directoryFor(again)).not.toBe(cache.directoryFor(repository));
    expect(cache.get(again, commit)).toBeUndefined();
  });

  test('an invalid opt-in file opts nothing in', async () => {
    const { repo, home } = setup();
    const commit = basicTree(repo);
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    writeFileSync(join(home, 'project-map-repositories.json'), '{"version":1,"repositories":[{');
    const warnings: string[] = [];
    const maps = new DaemonProjectMapService({
      home,
      log: { info() {}, debug() {}, warn: (message) => warnings.push(message) },
    });
    expect((await maps.getMap(repo.dir, commit)).ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(() => listOptedInRepositories(home)).toThrow();
  });

  test('allowing twice keeps one entry, and the file is owner-only', () => {
    const { repo, home } = setup();
    expect(allowRepository(home, repo.dir, join(repo.dir, '.git')).added).toBe(true);
    expect(allowRepository(home, repo.dir, join(repo.dir, '.git')).added).toBe(false);
    expect(listOptedInRepositories(home)).toHaveLength(1);
    expect(() => allowRepository(home, 'relative/path', '/x/.git')).toThrow();
  });
});

describe('building', () => {
  test('caches per commit and reports an unknown commit', async () => {
    const { repo, home } = setup();
    const commit = basicTree(repo);
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    let builds = 0;
    const maps = new DaemonProjectMapService({
      home,
      log: { info: () => (builds += 1), debug() {}, warn() {} },
    });
    const first = await maps.getMap(repo.dir, commit);
    const second = await maps.getMap(repo.dir, commit);
    expect(first).toEqual(second);
    expect(builds).toBe(1);
    expect(await maps.commitExists(repo.dir, commit)).toEqual({ ok: true, exists: true });
    const unknown = 'f'.repeat(40);
    expect(await maps.commitExists(repo.dir, unknown)).toEqual({ ok: true, exists: false });
    expect(await maps.getMap(repo.dir, unknown)).toMatchObject({
      ok: false,
      refusal: { error: 'commit-unknown' },
    });
    // A blob id is not a commit.
    const blob = repo.git(['rev-parse', `${commit}:src/a.ts`]);
    expect(await maps.getMap(repo.dir, blob)).toMatchObject({
      refusal: { error: 'commit-unknown' },
    });
    expect(await maps.getMap(repo.dir, 'HEAD')).toMatchObject({
      refusal: { error: 'bad-request' },
    });
  });

  test('builds are serialized and rate limited', async () => {
    const { repo, home } = setup();
    const commits = [basicTree(repo)];
    for (let i = 0; i < 3; i += 1) {
      repo.write(`src/c${i}.ts`, `export const c = ${i};\n`);
      commits.push(repo.commit());
    }
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const maps = new DaemonProjectMapService({ home, maxBuildsPerMinute: 2 });
    const results = await Promise.all(commits.map((c) => maps.getMap(repo.dir, c)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.refusal.error === 'busy')).toHaveLength(2);
    // Cached answers are not builds and are never refused.
    const firstCommit = commits[0] ?? '';
    expect((await maps.getMap(repo.dir, firstCommit)).ok).toBe(true);
  });

  test('commit checks share the queue bound, and recheck the opt-in inside the queue', async () => {
    const { repo, home } = setup();
    const commits = [basicTree(repo)];
    for (let i = 0; i < 3; i += 1) {
      repo.write(`src/q${i}.ts`, `export const q = ${i};\n`);
      commits.push(repo.commit());
    }
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const maps = new DaemonProjectMapService({ home });
    const builds = commits.map((c) => maps.getMap(repo.dir, c));
    const first = commits[0] ?? '';
    expect(await maps.commitExists(repo.dir, first)).toMatchObject({
      ok: false,
      refusal: { error: 'busy' },
    });
    await Promise.all(builds);
    const queued = maps.commitExists(repo.dir, first);
    revokeRepository(home, repo.dir);
    expect(await queued).toMatchObject({ ok: false, refusal: { error: 'not-opted-in' } });
  });

  test('a tree over the file bound is refused, not truncated', async () => {
    const { repo, home } = setup();
    for (let i = 0; i < 12; i += 1) repo.write(`f${i}.txt`, `${i}`);
    const commit = repo.commit();
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const maps = new DaemonProjectMapService({ home, bounds: { ...DEFAULT_BOUNDS, files: 10 } });
    expect(await maps.getMap(repo.dir, commit)).toMatchObject({
      ok: false,
      refusal: { error: 'over-bound', bound: 'files' },
    });
  });

  test('blob and total byte bounds are reported in coverage', async () => {
    const { repo, home } = setup();
    repo.write('big.ts', `export const big = '${'x'.repeat(5000)}';\n`);
    repo.write('a.ts', "import './b.ts';\n");
    repo.write('b.ts', "import './a.ts';\n");
    repo.write('c.ts', `// ${'y'.repeat(300)}\n`);
    const commit = repo.commit();
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const maps = new DaemonProjectMapService({
      home,
      bounds: { ...DEFAULT_BOUNDS, blobBytes: 1000, totalBytes: 100 },
    });
    const result = await maps.getMap(repo.dir, commit);
    if (!result.ok) throw new Error(result.refusal.message);
    const { coverage } = result.map;
    expect(coverage.complete).toBe(false);
    expect(coverage.boundsReached).toEqual(['blob-bytes', 'total-bytes']);
    expect(coverage.languages[0]).toMatchObject({
      language: 'typescript',
      files: 4,
      parsed: 2,
      notParsed: { tooLarge: 1, overBudget: 1 },
    });
    expect(result.map.nodes.filter((n) => n.kind === 'file')).toHaveLength(4);
  });
});

describe('crafted repositories', () => {
  test('a hostile config, hooks and promisor remote are never consulted', async () => {
    const { repo, home } = setup();
    const commit = basicTree(repo);
    const markers = join(repo.parent, 'markers');
    mkdirSync(markers);
    const touch = (name: string) => `touch ${join(markers, name)}`;
    mkdirSync(join(repo.dir, '.git', 'evil-hooks'));
    for (const hook of ['post-checkout', 'pre-auto-gc', 'reference-transaction']) {
      writeFileSync(join(repo.dir, '.git', 'evil-hooks', hook), `#!/bin/sh\n${touch(hook)}\n`, {
        mode: 0o755,
      });
    }
    writeFileSync(join(repo.parent, 'included.config'), `[core]\n\tpager = ${touch('included')}\n`);
    writeFileSync(
      join(repo.dir, '.git', 'config'),
      [
        '[core]',
        '\trepositoryformatversion = 1',
        `\tfsmonitor = ${touch('fsmonitor')}`,
        '\thooksPath = .git/evil-hooks',
        `\tpager = ${touch('pager')}`,
        `\tsshCommand = ${touch('ssh')}`,
        `\talternateRefsCommand = ${touch('alternate-refs')}`,
        '[extensions]',
        '\tpartialClone = origin',
        '[remote "origin"]',
        // `% ` is how ext:: escapes a space; plain git runs this, as the end of the test shows.
        `\turl = ext::sh -c touch% ${join(markers, 'ext')}`,
        '\tpromisor = true',
        '[protocol "ext"]',
        '\tallow = always',
        '[include]',
        `\tpath = ${join(repo.parent, 'included.config')}`,
        '',
      ].join('\n'),
    );
    // A missing blob is what would make git fetch from the promisor remote.
    const missing = repo.git(['rev-parse', `${commit}:src/b.ts`]);
    rmSync(repo.objectPath(missing));
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const result = await new DaemonProjectMapService({ home }).getMap(repo.dir, commit);
    if (!result.ok) throw new Error(result.refusal.message);
    expect(readdirSync(markers)).toEqual([]);
    const b = result.map.nodes.find((n) => n.kind === 'file' && n.path === 'src/b.ts');
    expect(b).toMatchObject({ bytes: null });
    expect(result.map.coverage.complete).toBe(false);
    expect(result.map.coverage.languages[0]?.notParsed.missing).toBe(1);
    // Negative control: git reading the repository's own directory does run the remote command.
    spawnSync('git', ['-C', repo.dir, 'cat-file', '--batch-check'], {
      input: `${missing}\n`,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    expect(readdirSync(markers)).toContain('ext');
  });

  test('symbolic links are listed with their own blob and never followed', async () => {
    const { repo, home } = setup();
    writeFileSync(join(repo.parent, 'outside.ts'), "import './secret-outside.ts';\n");
    repo.write('src/a.ts', 'export {};\n');
    symlinkSync('../../outside.ts', join(repo.dir, 'src', 'link.ts'));
    symlinkSync(repo.parent, join(repo.dir, 'linked-dir'));
    const commit = repo.commit();
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const result = await new DaemonProjectMapService({ home }).getMap(repo.dir, commit);
    if (!result.ok) throw new Error(result.refusal.message);
    const link = result.map.nodes.find((n) => n.kind === 'file' && n.path === 'src/link.ts');
    expect(link).toMatchObject({ entry: 'symlink' });
    expect(
      result.map.nodes.some((n) => n.kind === 'file' && n.path.startsWith('linked-dir/')),
    ).toBe(false);
    expect(JSON.stringify(result.map)).not.toContain('secret-outside');
    expect(result.map.coverage.languages[0]?.notParsed.symlink).toBe(1);
  });

  test('an object store reached through a pointer the opt-in never saw is refused', async () => {
    const secret = scratchRepository();
    cleanups.push(() => secret.remove());
    secret.write('src/topsecret.ts', 'export {};\n');
    const secretCommit = secret.commit();
    const secretGit = join(secret.dir, '.git');

    // A symbolic link for the object directory.
    const { repo: linked, home } = setup();
    basicTree(linked);
    rmSync(join(linked.dir, '.git', 'objects'), { recursive: true, force: true });
    symlinkSync(join(secretGit, 'objects'), join(linked.dir, '.git', 'objects'));
    allowRepository(home, linked.dir, join(linked.dir, '.git'));
    const maps = new DaemonProjectMapService({ home });
    expect(await maps.getMap(linked.dir, secretCommit)).toMatchObject({
      refusal: { error: 'repository-unsupported' },
    });

    // A commondir inside a .git directory.
    const { repo: common, home: commonHome } = setup();
    basicTree(common);
    writeFileSync(join(common.dir, '.git', 'commondir'), `${secretGit}\n`);
    allowRepository(commonHome, common.dir, join(common.dir, '.git'));
    expect(
      await new DaemonProjectMapService({ home: commonHome }).getMap(common.dir, secretCommit),
    ).toMatchObject({ refusal: { error: 'repository-unsupported' } });

    // A .git file redirected after the repository was allowed.
    const { repo: moved, home: movedHome } = setup();
    basicTree(moved);
    allowRepository(movedHome, moved.dir, join(moved.dir, '.git'));
    rmSync(join(moved.dir, '.git'), { recursive: true, force: true });
    writeFileSync(join(moved.dir, '.git'), `gitdir: ${secretGit}\n`);
    const result = await new DaemonProjectMapService({ home: movedHome }).getMap(
      moved.dir,
      secretCommit,
    );
    expect(result).toMatchObject({ refusal: { error: 'repository-unsupported' } });
    expect(JSON.stringify(result)).not.toContain('topsecret');
  });

  test('a pack directory holding anything but files is refused', async () => {
    const { repo, home } = setup();
    const commit = basicTree(repo);
    mkdirSync(join(repo.dir, '.git', 'objects', 'pack'), { recursive: true });
    execFileSync('mkfifo', [join(repo.dir, '.git', 'objects', 'pack', 'pack-x.pack')]);
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const started = performance.now();
    expect(await new DaemonProjectMapService({ home }).getMap(repo.dir, commit)).toMatchObject({
      refusal: { error: 'repository-unsupported' },
    });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test('a tree entry with an impossibly long name is refused without holding it', async () => {
    const { repo, home } = setup();
    const blob = repo.git(['hash-object', '-w', '--stdin'], 'x\n');
    const tree = repo.git(['mktree'], `100644 blob ${blob}\t${'n'.repeat(200_000)}\n`);
    const commit = repo.git(['commit-tree', tree, '-m', 'long']);
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    expect(await new DaemonProjectMapService({ home }).getMap(repo.dir, commit)).toMatchObject({
      refusal: { error: 'over-bound', bound: 'path-length' },
    });
  });

  test('a commit time no timestamp can carry is refused, not a server error', async () => {
    const { repo, home } = setup();
    const commit = basicTree(repo);
    const tree = repo.git(['rev-parse', `${commit}^{tree}`]);
    const crafted = repo.git(
      ['hash-object', '-t', 'commit', '-w', '--stdin', '--literally'],
      `tree ${tree}\nauthor A <a@b> 999999999999 +0000\ncommitter A <a@b> 999999999999 +0000\n\nfuture\n`,
    );
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    expect(await new DaemonProjectMapService({ home }).getMap(repo.dir, crafted)).toMatchObject({
      refusal: { error: 'repository-unsupported' },
    });
  });

  test('submodules are counted, not mapped', async () => {
    const { repo, home } = setup();
    basicTree(repo);
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/lib`]);
    repo.git(['commit', '-q', '-m', 'submodule']);
    const commit = repo.git(['rev-parse', 'HEAD']);
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const result = await new DaemonProjectMapService({ home }).getMap(repo.dir, commit);
    if (!result.ok) throw new Error(result.refusal.message);
    expect(result.map.coverage.submodules).toEqual({ count: 1, paths: ['vendor/lib'] });
    expect(result.map.nodes.some((n) => n.kind === 'file' && n.path === 'vendor/lib')).toBe(false);
  });

  test('paths only a crafted tree can hold are omitted and counted', async () => {
    const { repo, home } = setup();
    const blob = repo.git(['hash-object', '-w', '--stdin'], 'export {};\n');
    const tree = repo.git(
      ['mktree'],
      `100644 blob ${blob}\t..\n100644 blob ${blob}\ta\x01b.ts\n100644 blob ${blob}\tok.ts\n`,
    );
    const commit = repo.git(['commit-tree', tree, '-m', 'crafted']);
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const result = await new DaemonProjectMapService({ home }).getMap(repo.dir, commit);
    if (!result.ok) throw new Error(result.refusal.message);
    expect(result.map.nodes.flatMap((n) => (n.kind === 'file' ? [n.path] : []))).toEqual(['ok.ts']);
    expect(result.map.coverage.omittedFiles).toEqual([
      { reason: 'path-control-characters', count: 1 },
      { reason: 'path-not-canonical', count: 1 },
    ]);
  });

  test('a missing commit or tree is refused', async () => {
    const { repo, home } = setup();
    const commit = basicTree(repo);
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const tree = repo.git(['rev-parse', `${commit}^{tree}`]);
    rmSync(repo.objectPath(tree));
    expect(await new DaemonProjectMapService({ home }).getMap(repo.dir, commit)).toMatchObject({
      ok: false,
      refusal: { error: 'repository-unsupported' },
    });
    rmSync(repo.objectPath(commit));
    expect(await new DaemonProjectMapService({ home }).getMap(repo.dir, commit)).toMatchObject({
      refusal: { error: 'commit-unknown' },
    });
  });

  test('a repository that borrows objects through alternates is refused', async () => {
    const { repo, home } = setup();
    const commit = basicTree(repo);
    const other = scratchRepository();
    cleanups.push(() => other.remove());
    mkdirSync(join(repo.dir, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(
      join(repo.dir, '.git', 'objects', 'info', 'alternates'),
      `${join(other.dir, '.git', 'objects')}\n`,
    );
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    expect(await new DaemonProjectMapService({ home }).getMap(repo.dir, commit)).toMatchObject({
      ok: false,
      refusal: { error: 'repository-unsupported' },
    });
  });

  test('SHA-256 repositories are read with their own object format', async () => {
    const { repo, home } = setup({ objectFormat: 'sha256' });
    const commit = basicTree(repo);
    expect(commit).toHaveLength(64);
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const maps = new DaemonProjectMapService({ home });
    const result = await maps.getMap(repo.dir, commit);
    if (!result.ok) throw new Error(result.refusal.message);
    expect(result.map.repository.tree).toHaveLength(64);
    expect(result.map.coverage.internalFileEdges).toBe(1);
    expect(await maps.getMap(repo.dir, commit.slice(0, 40))).toMatchObject({
      refusal: { error: 'commit-unknown' },
    });
  });

  test('an unknown object format is refused rather than guessed', async () => {
    const { repo, home } = setup();
    const commit = basicTree(repo);
    writeFileSync(
      join(repo.dir, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha512\n',
    );
    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    expect(await new DaemonProjectMapService({ home }).getMap(repo.dir, commit)).toMatchObject({
      refusal: { error: 'repository-unsupported' },
    });
  });
});
