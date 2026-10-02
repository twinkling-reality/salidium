import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRedactor } from '@salidium/core';
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
const BACK = 'claude-code:moved-and-back-session';
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
function movedSession(id = MOVED, comeBack = false): CanonicalEvent[] {
  const b = new EventBuilder(id, '2026-10-02T10:00:00.000Z');
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
    // In the fake service END exists in REPO too, as it would in a clone: the rule must still hold.
    snapshot(b, 'git:2', OTHER, END, 'turn.ended'),
    // Back in REPO with no turn ending there since: its latest turn-end anchor is still OTHER's.
    ...(comeBack ? [b.raw({ id: 'back', kind: 'session.updated', cwd: REPO } as never)] : []),
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
    [BACK, movedSession(BACK, true)],
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
      atStart: {
        root: REPO,
        repository: REPO,
        head: START,
        branch: 'main',
        provenance: 'observed',
      },
      atLatestTurnEnd: {
        root: REPO,
        repository: REPO,
        head: END,
        branch: 'main',
        provenance: 'observed',
      },
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
    // A fresh instance, so the document is computed rather than served again.
    maps.touched.length = 0;
    await createSessionLinks({ registry, log }).document(maps, LIVE);
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
    expect(doc.anchors.atStart).toMatchObject({ root: LANE, repository: REPO });
    // Only a start HEAD was observed, and it exists.
    expect(doc.repositories).toMatchObject([
      { root: REPO, status: 'mapped', commit: { id: START, chosen: 'session-start' } },
    ]);
    expect(doc.files.map((f) => f.status)).toEqual(['linked', 'linked']);
  });

  test('without an observed location in the worktree, its anchors are not lent to the repository', async () => {
    const doc = await links(LANE_UNSEEN);
    expect(doc.anchors.atStart).toMatchObject({ root: LANE, repository: LANE });
    expect(doc.repositories).toMatchObject([{ root: REPO, status: 'no-revision', commit: null }]);
  });

  test('a turn-end HEAD read in another repository is not offered to this one', async () => {
    for (const id of [MOVED, BACK]) {
      const doc = await links(id);
      // Recorded as what it was: observed, in the other repository.
      expect(doc.anchors.atLatestTurnEnd, id).toMatchObject({
        root: OTHER,
        repository: OTHER,
        head: END,
      });
      // Its commit exists in REPO too, as in a clone, and still is not REPO's revision.
      expect(doc.repositories, id).toMatchObject([
        { root: REPO, status: 'mapped', commit: { id: START, chosen: 'session-start' } },
      ]);
    }
  });

  test('a history import has no anchors and no locations, and claims neither', async () => {
    const doc = await links(IMPORTED);
    expect(doc.anchors).toEqual({ atStart: null, atLatestTurnEnd: null });
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

  /*
   * The same six shapes main pins on every other session route. An unknown one is simply not
   * found; a stored session whose id the document cannot carry is not found here either, rather
   * than a failure.
   */
  test('answers an unusual but well-encoded session id as not found', async () => {
    const ids = [
      `claude-code:${'a'.repeat(600)}`,
      'a'.repeat(513),
      'claude-code:a\u0001b',
      'claude-code:a\u0000b',
      'a\u007fb',
      'claude-code:a\nb',
    ];
    for (const id of ids) {
      const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/links`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status, JSON.stringify(id)).toBe(404);
      expect(await res.json(), JSON.stringify(id)).toEqual({ error: 'unknown session' });
    }
    const stored = `claude-code:${'b'.repeat(600)}`;
    const b = new EventBuilder(stored, '2026-10-02T10:00:00.000Z');
    registry.ingest(
      stored,
      provider([
        b.sessionStarted(REPO, 'model'),
        b.turnStarted('Long id'),
        ...b.edit('c1', `${REPO}/src/pay.ts`, 1, 0),
      ]),
      { cwd: REPO },
    );
    registry.flush(stored);
    expect(registry.readSession(stored)).toBeDefined();
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(stored)}/links`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test('refuses a cross-site request before anything else', async () => {
    const res = await fetch(`${base}/api/sessions/${encodeURIComponent(LIVE)}/links`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});

/** A map service that keeps each map as one object, as the daemon's memory cache does. */
function steadyService(map: (commit: string) => ProjectMap = mapAt) {
  const maps = new Map<string, ProjectMap>();
  let grants = [{ root: REPO, allowedAt: '2026-10-02T09:00:00.000Z' }];
  const calls: string[] = [];
  const service: ProjectMapService = {
    isOptedIn: (root) => grants.some((g) => g.root === root),
    repositories: () => grants,
    commitExists: async (root, commit) => {
      calls.push('commitExists');
      return { ok: true, exists: root === REPO && (commit === START || commit === END) };
    },
    getMap: async (root, commit) => {
      calls.push('getMap');
      let kept = maps.get(`${root} ${commit}`);
      if (!kept) {
        kept = map(commit);
        maps.set(`${root} ${commit}`, kept);
      }
      return { ok: true, map: kept };
    },
  };
  return {
    service,
    calls,
    regrant: (allowedAt: string) => {
      grants = [{ root: REPO, allowedAt }];
    },
  };
}

/** A redactor that records every string it is asked about. */
function countingRedactor() {
  const seen: string[] = [];
  const factory = () => {
    const inner = createRedactor();
    return {
      ...inner,
      redact: (text: string) => {
        seen.push(text);
        return inner.redact(text);
      },
    } as ReturnType<typeof createRedactor>;
  };
  return { seen, factory };
}

describe('carried whole or withheld', () => {
  test('map text the redactor would alter is withheld from what the document carries', async () => {
    const secretPath = `src/${SECRET}.ts`;
    const withSecret = (commit: string) => {
      const map = mapAt(commit);
      map.nodes.push(fileNode(secretPath));
      map.edges.push({
        id: edgeId(`file:${secretPath}`, 'imports', 'file:src/pay.ts'),
        from: `file:${secretPath}`,
        to: 'file:src/pay.ts',
        kind: 'imports',
        provenance: 'observed',
        rule: 'probe',
        evidence: [{ path: secretPath, line: 1 }],
        count: 1,
      });
      return map;
    };
    const { service } = steadyService(withSecret);
    const doc = await createSessionLinks({ registry, log }).document(service, LIVE);
    expect(JSON.stringify(doc)).not.toContain(SECRET);
    expect(doc?.mapElementsWithheld).toBe(1);
    const pay = doc?.files.find((f) => f.relativePath === 'src/pay.ts');
    // Its other importer is still shown, and the total counts only what is carried.
    expect(pay?.neighbours.map((n) => n.path)).toEqual(['src/retry.ts']);
    expect(pay?.neighboursTotal).toBe(1);
  });

  test('a second request on an unchanged session does no redactor work over the map', async () => {
    const { service, calls } = steadyService();
    const { seen, factory } = countingRedactor();
    const links = createSessionLinks({ registry, log, redactor: factory });
    const first = await links.document(service, LIVE);
    expect(seen.length).toBeGreaterThan(0);
    // Map-derived text was checked: an importer's path, a module name, a rule.
    expect(seen).toEqual(expect.arrayContaining(['src/retry.ts', 'acme', 'probe']));

    seen.length = 0;
    calls.length = 0;
    expect(await links.document(service, LIVE)).toBe(first);
    expect(seen).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('when the session moves on, only its own identifiers are checked again', async () => {
    const { service } = steadyService();
    const { seen, factory } = countingRedactor();
    const links = createSessionLinks({ registry, log, redactor: factory });
    await links.document(service, LANE_ROOT);
    const b = new EventBuilder(LANE_ROOT, '2026-10-02T10:30:00.000Z');
    registry.ingest(LANE_ROOT, provider([b.message('Still here.')]), { cwd: REPO });
    registry.flush(LANE_ROOT);
    seen.length = 0;
    const again = await links.document(service, LANE_ROOT);
    expect(again?.files.map((f) => f.status)).toEqual(['linked', 'linked']);
    // Same map object: its text answers are remembered, so no map-only string is asked about.
    for (const mapOnly of ['acme', 'nearest package.json', 'probe', 'module:package.json:.'])
      expect(seen, mapOnly).not.toContain(mapOnly);
  });

  test('a change to the opt-in file is a new document', async () => {
    const { service, calls, regrant } = steadyService();
    const links = createSessionLinks({ registry, log });
    await links.document(service, LIVE);
    calls.length = 0;
    regrant('2026-10-02T11:00:00.000Z');
    await links.document(service, LIVE);
    expect(calls).toContain('getMap');
  });

  test('links never serves a session the consumer contract leaves out', async () => {
    const { service } = steadyService();
    const links = createSessionLinks({ registry, log, represents: () => false });
    expect(await links.document(service, LIVE)).toBeUndefined();
    const result = await links.handler({ maps: service })({
      sessionId: LIVE,
      query: new URLSearchParams(),
    });
    expect(result.status).toBe(404);
  });

  test('a changed file whose repository root cannot be printed is withheld, not a failure', async () => {
    // Built from char codes so no formatter can turn the escapes into the characters themselves.
    const bidi = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(7);
    const id = 'claude-code:unprintable-root-session';
    const b = new EventBuilder(id, '2026-10-02T10:00:00.000Z');
    registry.ingest(
      id,
      provider([
        b.sessionStarted(REPO, 'model'),
        b.turnStarted('Odd roots'),
        ...b.edit('c1', `${REPO}/src/pay.ts`, 1, 0),
        ...b.edit('c2', `/work/odd${bidi}repo/a.ts`, 1, 0),
        ...b.edit('c3', `/work/bell/a.ts`, 1, 0),
        b.raw({
          id: 'located:1',
          kind: 'file.located',
          files: [
            { path: `${REPO}/src/pay.ts`, repository: { root: REPO, path: 'src/pay.ts' } },
            {
              path: `/work/odd${bidi}repo/a.ts`,
              repository: { root: `/work/odd${bidi}repo`, path: 'a.ts' },
            },
            {
              path: '/work/bell/a.ts',
              repository: { root: '/work/bell', path: 'a.ts', mainRoot: `/work/be${bell}ll` },
            },
          ],
        } as never),
      ]),
      { cwd: REPO },
    );
    registry.flush(id);
    const { service } = steadyService();
    const doc = await createSessionLinks({ registry, log }).document(service, id);
    expect(doc?.filesTotal).toBe(3);
    expect(doc?.filesOmitted).toBe(2);
    expect(doc?.repositories.map((r) => r.root)).toEqual([REPO]);
  });
});
