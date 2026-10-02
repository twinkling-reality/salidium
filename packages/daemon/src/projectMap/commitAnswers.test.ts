import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { scratchRepository } from './__fixtures__/scratchRepository.ts';
import { allowRepository, revokeRepository } from './optIn.ts';
import { COMMIT_ABSENT_MS, DaemonProjectMapService, trustedGit } from './service.ts';

/**
 * Commit checks are the one repository read a links request makes every time it is asked, so their
 * answers are remembered under the grant they were read with, and the reads that do reach the
 * object store are rate limited on their own.
 */
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(options: { checksPerMinute?: number } = {}) {
  const repo = scratchRepository();
  const home = mkdtempSync(join(tmpdir(), 'salidium-map-home-'));
  cleanups.push(() => {
    repo.remove();
    rmSync(home, { recursive: true, force: true });
  });
  repo.write('a.ts', 'export const a = 1;\n');
  const commit = repo.commit();
  allowRepository(home, repo.dir, join(repo.dir, '.git'), new Date('2026-10-02T10:00:00.000Z'));
  let clock = Date.parse('2026-10-02T12:00:00.000Z');
  const reads = { count: 0 };
  const maps = new DaemonProjectMapService({
    home,
    now: () => clock,
    git: (root) => {
      reads.count += 1;
      return trustedGit(root);
    },
    ...(options.checksPerMinute === undefined
      ? {}
      : { maxCommitChecksPerMinute: options.checksPerMinute }),
  });
  return {
    repo,
    home,
    commit,
    maps,
    reads,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const MISSING = 'f'.repeat(40);

describe('commit answers', () => {
  test('a commit found is not read for again under the same grant', async () => {
    const { repo, commit, maps, reads } = setup();
    expect(await maps.commitExists(repo.dir, commit)).toEqual({ ok: true, exists: true });
    expect(await maps.commitExists(repo.dir, commit)).toEqual({ ok: true, exists: true });
    expect(reads.count).toBe(1);
  });

  test('a missing commit is believed briefly, then asked about again', async () => {
    const { repo, maps, reads, advance } = setup();
    expect(await maps.commitExists(repo.dir, MISSING)).toEqual({ ok: true, exists: false });
    advance(COMMIT_ABSENT_MS - 1);
    expect(await maps.commitExists(repo.dir, MISSING)).toEqual({ ok: true, exists: false });
    expect(reads.count).toBe(1);
    advance(2);
    expect(await maps.commitExists(repo.dir, MISSING)).toEqual({ ok: true, exists: false });
    expect(reads.count).toBe(2);
  });

  test('a new grant asks again, and a revoked one is refused before any answer', async () => {
    const { repo, home, commit, maps, reads } = setup();
    await maps.commitExists(repo.dir, commit);
    revokeRepository(home, repo.dir);
    expect(await maps.commitExists(repo.dir, commit)).toMatchObject({
      ok: false,
      refusal: { error: 'not-opted-in' },
    });
    allowRepository(home, repo.dir, join(repo.dir, '.git'), new Date('2026-10-02T11:00:00.000Z'));
    expect(await maps.commitExists(repo.dir, commit)).toEqual({ ok: true, exists: true });
    expect(reads.count).toBe(2);
  });

  test('reads of the object store are rate limited; remembered answers are not counted', async () => {
    const { repo, commit, maps, reads, advance } = setup({ checksPerMinute: 2 });
    await maps.commitExists(repo.dir, commit);
    await maps.commitExists(repo.dir, MISSING);
    // Both remembered: answered without counting.
    for (let i = 0; i < 5; i++) await maps.commitExists(repo.dir, commit);
    expect(await maps.commitExists(repo.dir, 'e'.repeat(40))).toMatchObject({
      ok: false,
      refusal: { error: 'busy' },
    });
    expect(reads.count).toBe(2);
    advance(60_001);
    expect(await maps.commitExists(repo.dir, 'e'.repeat(40))).toEqual({ ok: true, exists: false });
  });

  test('a commit that vanished under its grant is remembered as missing once a build finds it gone', async () => {
    const { repo, commit, maps, reads } = setup();
    expect(await maps.commitExists(repo.dir, commit)).toEqual({ ok: true, exists: true });
    unlinkSync(repo.objectPath(commit));
    expect(await maps.getMap(repo.dir, commit)).toMatchObject({
      ok: false,
      refusal: { error: 'commit-unknown' },
    });
    const before = reads.count;
    expect(await maps.commitExists(repo.dir, commit)).toEqual({ ok: true, exists: false });
    expect(reads.count).toBe(before);
  });
});
