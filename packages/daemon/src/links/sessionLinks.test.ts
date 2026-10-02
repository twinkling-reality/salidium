import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBuilder } from '@salidium/core/testing';
import {
  type ExecutionLinks,
  ExecutionLinksSchema,
  type MapEdge,
  type MapNode,
  type ProjectMap,
  type ProjectMapService,
} from '@salidium/project-map';
import type { CanonicalEvent, DaemonInfo, StoredEvent } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { HookIngress } from '../ingest/hookIngress.ts';
import { createHttpServer } from '../server/httpServer.ts';
import { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { SqliteStore } from '../storage/sqliteStore.ts';
import { createSessionLinks } from './sessionLinks.ts';

/**
 * The document the interface and consumers read, derived from real ingested events through the
 * real reducer: the anchors and locations come from `git.snapshot` and `file.located` exactly as
 * the enrichers write them. Every path and id is invented.
 */
const TOKEN = 'owner-token-for-tests';
const REPO = '/work/acme';
const LANE = '/work/acme-lane';
const OTHER = '/work/elsewhere';
const START = '1'.repeat(40);
const END = '2'.repeat(40);
const SECRET = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;

const LIVE = 'claude-code:live-session';
const LANE_ROOT = 'claude-code:lane-root-session';
const IMPORTED = 'claude-code:imported-session';
const LANE_UNSEEN = 'claude-code:lane-unseen-session';
const MOVED = 'claude-code:moved-session';
const INTERNAL = 'claude-code:internal-session';

const edgeId = (from: string, kind: string, to: string) =>
  `e:${createHash('sha256').update(`${from}\0${kind}\0${to}`).digest('hex').slice(0, 16)}`;

function fileNode(path: string): MapNode {
  return {
    id: `file:${path}`,
    kind: 'file',
    path,
    entry: 'file',
    language: 'typescript',
    bytes: 1,
    blob: 'a'.repeat(40),
    role: null,
  };
}

function mapAt(commit: string): ProjectMap {
  const edges: MapEdge[] = [
    ['module:package.json:.', 'contains', 'file:src/pay.ts', 'nearest package.json'],
    ['module:package.json:.', 'contains', 'file:src/retry.ts', 'nearest package.json'],
    ['file:src/retry.ts', 'imports', 'file:src/pay.ts', 'probe'],
  ].map(([from, kind, to, rule]) => ({
    id: edgeId(from as string, kind as string, to as string),
    from: from as string,
    to: to as string,
    kind: kind as MapEdge['kind'],
    provenance: 'observed',
    rule: rule as string,
    evidence: [],
    count: 1,
  }));
  return {
    format: 'salidium.project-map',
    version: 0,
    experimental: true,
    generatedAt: '2026-10-02T12:00:00.000Z',
    indexer: { name: 'salidium-project-map', version: '0.1.0' },
    repository: {
      root: REPO,
      commit,
      tree: 'c'.repeat(40),
      commitTime: '2026-10-01T00:00:00.000Z',
    },
    coverage: {
      complete: true,
      bounds: { files: 1, blobBytes: 1, totalBytes: 1, nodes: 1, edges: 1 },
      boundsReached: [],
      files: 2,
      bytes: 2,
      omittedFiles: [],
      submodules: { count: 0, paths: [] },
      languages: [],
      specifierKinds: {
        import: 1,
        importType: 0,
        sideEffect: 0,
        exportFrom: 0,
        exportTypeFrom: 0,
        dynamic: 0,
        require: 0,
      },
      dynamicImportsWithoutLiteral: 0,
      internalFileEdges: 1,
      unresolved: { total: 0, byReason: [], items: [], truncated: false },
      manifestErrors: { count: 0, paths: [] },
      notAnalyzed: [{ subject: 'CSS imports', reason: 'not read in version 0' }],
    },
    nodes: [
      {
        id: 'module:package.json:.',
        kind: 'module',
        manifest: 'package.json',
        name: 'acme',
        ecosystem: 'npm',
      },
      fileNode('src/pay.ts'),
      fileNode('src/retry.ts'),
    ],
    edges,
  };
}

/** A map service that knows two commits of REPO and records every repository it was asked about. */
function service(optedIn: string[]): ProjectMapService & { touched: string[] } {
  const touched: string[] = [];
  const allowed = new Set(optedIn);
  return {
    touched,
    isOptedIn: (root) => allowed.has(root),
    repositories: () => [],
    commitExists: async (root, commit) => {
      touched.push(root);
      return { ok: true, exists: root === REPO && (commit === START || commit === END) };
    },
    getMap: async (root, commit) => {
      touched.push(root);
      return { ok: true, map: mapAt(commit) };
    },
  };
}

function snapshot(b: EventBuilder, id: string, root: string, head: string, trigger: string) {
  return b.raw({
    id,
    kind: 'git.snapshot',
    repoRoot: root,
    head,
    branch: 'main',
    dirty: [],
    trigger,
  } as never);
}

function provider(events: StoredEvent[]): CanonicalEvent[] {
  return events.map(({ seq: _seq, ...event }) => event) as CanonicalEvent[];
}

/** Live: started in REPO, wrote in REPO, in a linked worktree of it, in another repository and in /tmp. */
function liveSession(): CanonicalEvent[] {
  const b = new EventBuilder(LIVE, '2026-10-02T10:00:00.000Z');
  return provider([
    b.sessionStarted(REPO, 'model'),
    snapshot(b, 'git:1', REPO, START, 'session.started'),
    b.turnStarted('Fix the retry'),
    ...b.edit('c1', `${REPO}/src/pay.ts`, 3, 1),
    ...b.edit('c2', `${LANE}/src/retry.ts`, 2, 0),
    ...b.edit('c3', `${OTHER}/index.ts`, 1, 0),
    ...b.edit('c4', `/tmp/scratch/${SECRET}.md`, 1, 0),
    ...b.edit('c5', `${REPO}/src/new.ts`, 9, 0),
    b.raw({
      id: 'located:1',
      kind: 'file.located',
      files: [
        { path: `${REPO}/src/pay.ts`, repository: { root: REPO, path: 'src/pay.ts' } },
        {
          path: `${LANE}/src/retry.ts`,
          repository: { root: LANE, path: 'src/retry.ts', mainRoot: REPO },
        },
        { path: `${OTHER}/index.ts`, repository: { root: OTHER, path: 'index.ts' } },
        { path: `/tmp/scratch/${SECRET}.md`, repository: null },
        { path: `${REPO}/src/new.ts`, repository: { root: REPO, path: 'src/new.ts' } },
      ],
    } as never),
    b.turnEnded('Done.'),
    snapshot(b, 'git:2', REPO, END, 'turn.ended'),
  ]);
}

/**
 * Live, started in a linked worktree. With `inLane`, a file changed in the worktree itself, so
 * Salidium observed which repository the worktree belongs to; without it, it never did.
 */
function laneRootSession(id: string, inLane: boolean): CanonicalEvent[] {
  const b = new EventBuilder(id, '2026-10-02T10:00:00.000Z');
  return provider([
    b.sessionStarted(LANE, 'model'),
    snapshot(b, 'git:1', LANE, START, 'session.started'),
    b.turnStarted('Touch pay'),
    ...b.edit('c1', `${REPO}/src/pay.ts`, 1, 1),
    ...(inLane ? b.edit('c2', `${LANE}/src/retry.ts`, 1, 1) : []),
    b.raw({
      id: 'located:1',
      kind: 'file.located',
      files: [
        { path: `${REPO}/src/pay.ts`, repository: { root: REPO, path: 'src/pay.ts' } },
        ...(inLane
          ? [
              {
                path: `${LANE}/src/retry.ts`,
                repository: { root: LANE, path: 'src/retry.ts', mainRoot: REPO },
              },
            ]
          : []),
      ],
    } as never),
    b.turnEnded('Done.'),
  ]);
}

/**
 * Live, started in REPO, then its directory moved to another repository before the turn ended, so
 * the turn-end snapshot read that other repository's HEAD.
 */
function movedSession(): CanonicalEvent[] {
  const b = new EventBuilder(MOVED, '2026-10-02T10:00:00.000Z');
  return provider([
    b.sessionStarted(REPO, 'model'),
    snapshot(b, 'git:1', REPO, START, 'session.started'),
    b.turnStarted('Wander'),
    ...b.edit('c1', `${REPO}/src/pay.ts`, 1, 1),
    b.raw({
      id: 'located:1',
      kind: 'file.located',
      files: [{ path: `${REPO}/src/pay.ts`, repository: { root: REPO, path: 'src/pay.ts' } }],
    } as never),
    b.raw({ id: 'moved', kind: 'session.updated', cwd: OTHER } as never),
    b.turnEnded('Done.'),
    // In the fake service END exists in REPO too, as it would in a clone: the guard must still hold.
    snapshot(b, 'git:2', OTHER, END, 'turn.ended'),
  ]);
}

/** Imported from history: no snapshots, no locations. */
function importedSession(): CanonicalEvent[] {
  const b = new EventBuilder(IMPORTED, '2026-09-01T10:00:00.000Z');
  return provider([
    b.sessionStarted(REPO, 'model'),
    b.turnStarted('Old work'),
    ...b.edit('c1', `${REPO}/src/pay.ts`, 1, 1),
    b.turnEnded('Done.'),
  ]);
}

let dir: string;
let store: SqliteStore;
let registry: SessionRegistry;
let server: Server;
let base: string;
let maps: ReturnType<typeof service>;
const log = { info: () => {}, warn: () => {}, debug: () => {} };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'salidium-links-'));
  store = new SqliteStore(join(dir, 'test.db'));
  registry = new SessionRegistry(store);
  for (const [id, events] of [
    [LIVE, liveSession()],
    [LANE_ROOT, laneRootSession(LANE_ROOT, true)],
    [LANE_UNSEEN, laneRootSession(LANE_UNSEEN, false)],
    [MOVED, movedSession()],
    [IMPORTED, importedSession()],
  ] as const) {
    registry.ingest(id, events, { cwd: REPO });
    registry.flush(id);
  }
  const internal = new EventBuilder(INTERNAL, '2026-10-02T10:00:00.000Z');
  registry.ingest(
    INTERNAL,
    provider([
      internal.sessionStarted(REPO, 'model'),
      internal.turnStarted('[salidium-explainer] x'),
    ]),
    { cwd: REPO },
  );
  registry.flush(INTERNAL);

  maps = service([REPO]);
  const links = createSessionLinks({
    registry,
    log,
    now: () => Date.parse('2026-10-02T12:00:00.000Z'),
  });
  server = createHttpServer({
    registry,
    hooks: { handle: () => 0 } as unknown as HookIngress,
    token: TOKEN,
    port: () => (server.address() as AddressInfo).port,
    info: () => ({}) as unknown as DaemonInfo,
    sessionLinks: links.handler({ maps }),
    log,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  registry.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function links(sessionId: string): Promise<ExecutionLinks> {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/links`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const body = await res.json();
  expect(ExecutionLinksSchema.parse(body)).toEqual(body);
  return body as ExecutionLinks;
}

describe('execution links from ingested sessions', () => {
  test('anchors to the latest turn end and places every changed file', async () => {
    const doc = await links(LIVE);
    expect(doc.anchors).toMatchObject({
      repository: REPO,
      atStart: { head: START, branch: 'main', provenance: 'observed' },
      atLatestTurnEnd: { head: END, branch: 'main', provenance: 'observed' },
    });
    const byPath = Object.fromEntries(doc.files.map((f) => [f.path, f]));
    expect(byPath[`${REPO}/src/pay.ts`]).toMatchObject({
      status: 'linked',
      node: 'file:src/pay.ts',
    });
    // Written in a linked worktree, mapped through its main repository.
    expect(byPath[`${LANE}/src/retry.ts`]).toMatchObject({
      status: 'linked',
      repository: REPO,
      worktree: LANE,
      node: 'file:src/retry.ts',
    });
    expect(byPath[`${REPO}/src/new.ts`]?.status).toBe('not-in-map');
    expect(byPath[`${OTHER}/index.ts`]?.status).toBe('repository-not-mapped');
    expect(doc.repositories.map((r) => [r.root, r.status, r.commit?.id ?? null])).toEqual([
      [REPO, 'mapped', END],
      [OTHER, 'not-opted-in', null],
    ]);
    expect(doc.repositories[0]?.worktrees).toEqual(expect.arrayContaining([REPO, LANE]));
    // The pay file's importer is the retry file, which this session also changed.
    expect(byPath[`${REPO}/src/pay.ts`]?.neighbours).toMatchObject([
      { direction: 'imported-by', path: 'src/retry.ts', rule: 'probe', changed: true },
    ]);
    expect(doc.modules.map((m) => [m.module.name, m.changedFiles])).toEqual([
      ['acme', ['src/pay.ts', 'src/retry.ts']],
    ]);
  });

  test('never reads a repository that is not opted in', async () => {
    maps.touched.length = 0;
    await links(LIVE);
    expect(new Set(maps.touched)).toEqual(new Set([REPO]));
  });

  test('withholds a path the redactor would change, and counts it', async () => {
    const doc = await links(LIVE);
    expect(JSON.stringify(doc)).not.toContain(SECRET);
    expect(JSON.stringify(doc)).not.toContain('/tmp/scratch/');
    expect(doc.filesTotal).toBe(5);
    expect(doc.filesOmitted).toBe(1);
    expect(doc.files).toHaveLength(4);
  });

  test('a session started in a linked worktree anchors its main repository, as observed', async () => {
    const doc = await links(LANE_ROOT);
    expect(doc.anchors.repository).toBe(REPO);
    // Only a start HEAD was observed, and it exists.
    expect(doc.repositories).toMatchObject([
      { root: REPO, status: 'mapped', commit: { id: START, chosen: 'session-start' } },
    ]);
    expect(doc.files.map((f) => f.status)).toEqual(['linked', 'linked']);
  });

  test('without an observed location in the worktree, its anchors are not lent to the repository', async () => {
    const doc = await links(LANE_UNSEEN);
    expect(doc.anchors.repository).toBe(LANE);
    expect(doc.repositories).toMatchObject([{ root: REPO, status: 'no-revision', commit: null }]);
  });

  test('a turn-end HEAD read after the directory left the repository is not used', async () => {
    const doc = await links(MOVED);
    expect(doc.anchors.atLatestTurnEnd).toBeNull();
    expect(doc.repositories).toMatchObject([
      { root: REPO, status: 'mapped', commit: { id: START, chosen: 'session-start' } },
    ]);
  });

  test('a history import has no anchors and no locations, and claims neither', async () => {
    const doc = await links(IMPORTED);
    expect(doc.anchors).toEqual({ repository: null, atStart: null, atLatestTurnEnd: null });
    expect(doc.files.map((f) => f.status)).toEqual(['repository-unknown']);
    expect(doc.repositories).toEqual([]);
  });
});

describe('the owner route', () => {
  test('requires the owner token', async () => {
    const none = await fetch(`${base}/api/sessions/${encodeURIComponent(LIVE)}/links`);
    expect(none.status).toBe(401);
    const wrong = await fetch(`${base}/api/sessions/${encodeURIComponent(LIVE)}/links`, {
      headers: { Authorization: 'Bearer slm_c_not-the-owner' },
    });
    expect(wrong.status).toBe(401);
  });

  test('is read-only', async () => {
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(LIVE)}/links`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
  });

  test('answers 404 for an unknown session and for Salidium’s own sessions', async () => {
    for (const id of ['claude-code:nope', INTERNAL]) {
      const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/links`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(404);
    }
  });

  test('refuses a cross-site request before anything else', async () => {
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(LIVE)}/links`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});
