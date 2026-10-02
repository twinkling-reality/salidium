import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ExecutionLinks,
  ExecutionLinksSchema,
  ProjectMapErrorSchema,
} from '@salidium/project-map';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createConsumerCredential } from '../consumer/credentials.ts';
import { type DaemonHandle, startDaemon } from '../daemon.ts';
import { allowRepository, revokeRepository } from '../projectMap/optIn.ts';
import { type LinksScenario, linksScenario } from './__fixtures__/linksScenario.ts';

/**
 * End to end, in one daemon: live events go through ingest, the real git snapshot and file
 * location enrichers observe a scratch repository and its linked worktree, the person opts the
 * repository in through the opt-in file, and the interface's route builds the map from committed
 * objects and links the session to it. No provider adapter runs and no model is called.
 */
let scenario: LinksScenario;
let daemon: DaemonHandle;
let root: string;

async function links(): Promise<{ status: number; body: ExecutionLinks }> {
  const res = await fetch(
    `http://127.0.0.1:${daemon.port}/api/sessions/${encodeURIComponent(scenario.sessionId)}/links`,
    { headers: { Authorization: `Bearer ${daemon.token}` } },
  );
  const body = await res.json();
  return { status: res.status, body: ExecutionLinksSchema.parse(body) };
}

/** Until the enrichers have written the turn-end anchor and every location. */
async function observed(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = daemon.registry.readSession(scenario.sessionId)?.state;
    if (state?.git.atTurnEnd && Object.keys(state.fileLocations).length >= 5) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the enrichers did not observe the session in time');
}

beforeAll(async () => {
  scenario = linksScenario();
  root = mkdtempSync(join(tmpdir(), 'salidium-links-e2e-'));
  daemon = await startDaemon({
    home: join(root, 'salidium'),
    userHome: join(root, 'providers'),
    port: 0,
    providers: [],
    gitEnrichment: true,
    historyDays: 0,
    logLevel: 'silent',
    alertSink: { publish: () => {} },
  });
  daemon.registry.ingest(scenario.sessionId, scenario.events(), { cwd: scenario.repo.dir });
  await observed();
});

afterAll(async () => {
  await daemon?.stop();
  scenario?.remove();
  rmSync(root, { recursive: true, force: true });
});

describe('execution links end to end', () => {
  test('before opt-in, the repository is named and not read', async () => {
    const { status, body } = await links();
    expect(status).toBe(200);
    expect(body.repositories).toEqual([
      expect.objectContaining({ root: scenario.repo.dir, status: 'not-opted-in', commit: null }),
    ]);
    expect(body.files.some((f) => f.status === 'linked')).toBe(false);
  });

  test('after opt-in, files link at the turn-end commit, worktree included', async () => {
    allowRepository(daemon.config.home, scenario.repo.dir);
    const { body } = await links();
    expect(body.anchors.repository).toBe(scenario.repo.dir);
    expect(body.anchors.atLatestTurnEnd?.head).toBe(scenario.head);
    expect(body.repositories[0]).toMatchObject({
      root: scenario.repo.dir,
      status: 'mapped',
      commit: { id: scenario.head, chosen: 'latest-turn-end', provenance: 'observed' },
      mapComplete: true,
    });
    expect(body.repositories[0]?.worktrees).toEqual(
      expect.arrayContaining([scenario.repo.dir, scenario.lane]),
    );

    const by = (relative: string) => body.files.find((f) => f.relativePath === relative);
    const pay = by('packages/core/src/pay.ts');
    expect(pay).toMatchObject({ status: 'linked', worktree: scenario.repo.dir });
    expect(pay?.modules.map((m) => m.module.name)).toEqual(['@acme/core']);
    expect(
      pay?.neighbours.map((n) => [n.direction, n.path ?? n.name, n.changed, n.role?.value ?? null]),
    ).toEqual([
      ['imports', 'packages/core/src/money.ts', true, null],
      ['imports', 'zod', false, null],
      ['imported-by', 'packages/app/src/checkout.ts', false, null],
      ['imported-by', 'packages/core/src/pay.test.ts', false, 'test'],
    ]);

    // Written in the linked worktree, placed in the main repository's map.
    expect(by('packages/core/src/money.ts')).toMatchObject({
      status: 'linked',
      repository: scenario.repo.dir,
      worktree: scenario.lane,
    });
    expect(by('packages/core/src/fees.ts')?.status).toBe('not-in-map');
    expect(by('README.md')).toMatchObject({ status: 'linked', neighboursTotal: 0 });
    expect(body.files.find((f) => f.path.endsWith('/scratch/notes.md'))?.status).toBe(
      'outside-repository',
    );

    expect(
      body.modules.map((m) => [
        m.module.name,
        m.changedFiles,
        m.dependents.map((d) => d.module.name),
      ]),
    ).toEqual([
      // The core package is what the app depends on; the root manifest governs the README.
      ['@acme/core', ['packages/core/src/money.ts', 'packages/core/src/pay.ts'], ['@acme/app']],
      ['acme', ['README.md'], []],
    ]);
  });

  test('consumers read the same document through the map routes, and only with their credential', async () => {
    const path = `/project-map/v0/sessions/${encodeURIComponent(scenario.sessionId)}/links`;
    const url = `http://127.0.0.1:${daemon.port}${path}`;
    const { token } = createConsumerCredential(daemon.config.home, 'links e2e');
    const consumer = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    expect(consumer.status).toBe(200);
    const fromConsumer = ExecutionLinksSchema.parse(await consumer.json());
    const { body: fromOwner } = await links();
    expect({ ...fromConsumer, generatedAt: '' }).toEqual({ ...fromOwner, generatedAt: '' });
    // The owner token does not open the consumer surface, and nothing opens it without a credential.
    for (const headers of [{ Authorization: `Bearer ${daemon.token}` }, {}]) {
      const refused = await fetch(url, { headers });
      expect(refused.status).toBe(401);
    }
  });

  test('an unusual but well-encoded session id is not found on the consumer route', async () => {
    const { token } = createConsumerCredential(daemon.config.home, 'links ids');
    for (const id of [
      `claude-code:${'a'.repeat(600)}`,
      'a'.repeat(513),
      'claude-code:a\u0001b',
      'claude-code:a\u0000b',
      'a\u007fb',
      'claude-code:a\nb',
    ]) {
      const res = await fetch(
        `http://127.0.0.1:${daemon.port}/project-map/v0/sessions/${encodeURIComponent(id)}/links`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status, JSON.stringify(id)).toBe(404);
      expect(ProjectMapErrorSchema.parse(await res.json()).error, JSON.stringify(id)).toBe(
        'not-found',
      );
    }
  });

  test('a revoked repository is not read again', async () => {
    revokeRepository(daemon.config.home, scenario.repo.dir);
    const { body } = await links();
    expect(body.repositories[0]?.status).toBe('not-opted-in');
    expect(body.files.some((f) => f.status === 'linked')).toBe(false);
  });
});
