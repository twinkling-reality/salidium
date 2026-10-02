import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProjectMapErrorSchema,
  ProjectMapSchema,
  type ProjectMapService,
  RepositoryListSchema,
} from '@salidium/project-map';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConsumerCredentialVerifier, createConsumerCredential } from '../consumer/credentials.ts';
import { type DaemonHandle, startDaemon } from '../daemon.ts';
import { scratchRepository } from './__fixtures__/scratchRepository.ts';
import { allowRepository, revokeRepository } from './optIn.ts';
import { createProjectMapRoutes } from './routes.ts';

const root = mkdtempSync(join(tmpdir(), 'salidium-map-routes-'));
const home = join(root, 'salidium');
const repo = scratchRepository();
let daemon: DaemonHandle;
let token: string;
let commit: string;

beforeAll(async () => {
  repo.write('package.json', JSON.stringify({ name: 'pkg' }));
  repo.write('src/a.ts', "import './b.ts';\n");
  repo.write('src/b.ts', 'export {};\n');
  commit = repo.commit();
  daemon = await startDaemon({
    home,
    userHome: join(root, 'providers'),
    port: 0,
    providers: [],
    gitEnrichment: false,
    historyDays: 0,
    logLevel: 'silent',
    alertSink: { publish: () => {} },
  });
  token = createConsumerCredential(home, 'map test').token;
});

afterAll(async () => {
  await daemon?.stop();
  repo.remove();
  rmSync(root, { recursive: true, force: true });
});

async function get(path: string, credential: string | null = token, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    ...init,
    headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as unknown,
  };
}

const mapPath = (repository: string, sha: string) =>
  `/project-map/v0/maps?repository=${encodeURIComponent(repository)}&commit=${sha}`;

const errorOf = (body: unknown) => ProjectMapErrorSchema.parse(body).error;

describe('/project-map/v0', () => {
  it('needs a consumer credential, and the owner token is not one', async () => {
    for (const credential of [null, daemon.token, 'salidium_consumer_000000000000_00'])
      for (const path of ['/project-map/v0/repositories', mapPath(repo.dir, commit)]) {
        const response = await get(path, credential);
        expect(response.status).toBe(401);
        expect(errorOf(response.body)).toBe('unauthorized');
      }
  });

  it('is read-only before authentication', async () => {
    const response = await get('/project-map/v0/repositories', null, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(errorOf(response.body)).toBe('method-not-allowed');
  });

  it('keeps the loopback Host and Origin checks and refuses in its own envelope', async () => {
    const cases: [Record<string, string>, number, string][] = [
      [{ Host: `evil.example:${daemon.port}` }, 421, 'host-not-allowed'],
      [{ Origin: 'http://evil.example' }, 403, 'origin-not-allowed'],
      [{ 'Sec-Fetch-Site': 'cross-site' }, 403, 'origin-not-allowed'],
    ];
    for (const [headers, status, error] of cases) {
      const response = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: daemon.port,
            path: '/project-map/v0/repositories',
            headers: { Authorization: `Bearer ${token}`, ...headers },
          },
          (res) => {
            let text = '';
            res.on('data', (chunk) => (text += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(response.status).toBe(status);
      expect(errorOf(response.body)).toBe(error);
    }
  });

  it('lists opted-in repositories and maps only those', async () => {
    const empty = await get('/project-map/v0/repositories');
    expect(RepositoryListSchema.parse(empty.body).repositories).toEqual([]);
    const refused = await get(mapPath(repo.dir, commit));
    expect(refused.status).toBe(404);
    expect(errorOf(refused.body)).toBe('not-opted-in');

    allowRepository(home, repo.dir, join(repo.dir, '.git'));
    const listed = RepositoryListSchema.parse((await get('/project-map/v0/repositories')).body);
    expect(listed.repositories.map((r) => r.root)).toEqual([repo.dir]);
    const served = await get(mapPath(repo.dir, commit));
    expect(served.status).toBe(200);
    // The producer is held to the declared shape: nothing undeclared is served.
    expect(ProjectMapSchema.parse(served.body)).toEqual(served.body);

    const unknown = await get(mapPath(repo.dir, 'e'.repeat(40)));
    expect([unknown.status, errorOf(unknown.body)]).toEqual([404, 'commit-unknown']);
    for (const bad of [
      mapPath('relative', commit),
      mapPath(repo.dir, 'HEAD'),
      '/project-map/v0/maps',
    ])
      expect(errorOf((await get(bad)).body)).toBe('bad-request');

    revokeRepository(home, repo.dir);
    const revoked = await get(mapPath(repo.dir, commit));
    expect([revoked.status, errorOf(revoked.body)]).toEqual([404, 'not-opted-in']);
  });

  it('answers unknown paths, including links when no view is mounted, with not-found', async () => {
    for (const path of [
      '/project-map',
      '/project-map/v1/maps',
      '/project-map/v0/sessions/x/links',
    ]) {
      const response = await get(path);
      expect([response.status, errorOf(response.body)]).toEqual([404, 'not-found']);
    }
  });
});

describe('the links slot', () => {
  let server: Server;
  let port: number;
  const seen: string[] = [];
  const credentialHome = mkdtempSync(join(tmpdir(), 'salidium-map-slot-'));
  const slotToken = createConsumerCredential(credentialHome, 'slot').token;

  beforeAll(async () => {
    const maps: ProjectMapService = {
      isOptedIn: () => false,
      repositories: () => [],
      commitExists: async () => ({ ok: true, exists: false }),
      getMap: async () => ({
        ok: false,
        refusal: { error: 'not-opted-in', message: 'no', bound: null },
      }),
    };
    const routes = createProjectMapRoutes({
      maps,
      credentials: new ConsumerCredentialVerifier(credentialHome),
      log: { info() {}, warn() {}, debug() {} },
      sessionLinks: async ({ sessionId }) => {
        seen.push(sessionId);
        if (sessionId === 'boom') throw new Error('handler failed');
        if (sessionId === 'missing')
          return { status: 404, error: 'not-found', message: 'no such session' };
        return { status: 200, body: { sessionId } };
      },
    });
    server = createServer((req, res) => {
      void routes.handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterAll(() => {
    server.close();
    rmSync(credentialHome, { recursive: true, force: true });
  });

  const call = async (path: string, credential: string | null = slotToken) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: credential ? { Authorization: `Bearer ${credential}` } : {},
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };

  it('authenticates before the handler runs and decodes one path segment', async () => {
    expect((await call('/project-map/v0/sessions/a/links', null)).status).toBe(401);
    expect(seen).toEqual([]);
    const ok = await call(
      `/project-map/v0/sessions/${encodeURIComponent('claude-code:a/b')}/links`,
    );
    expect(ok).toEqual({ status: 200, body: { sessionId: 'claude-code:a/b' } });
    const missing = await call('/project-map/v0/sessions/missing/links');
    expect([missing.status, errorOf(missing.body)]).toEqual([404, 'not-found']);
    const bad = await call('/project-map/v0/sessions/%E0%A4%A/links');
    expect([bad.status, errorOf(bad.body)]).toEqual([400, 'bad-request']);
    const failed = await call('/project-map/v0/sessions/boom/links');
    expect([failed.status, errorOf(failed.body)]).toEqual([500, 'internal']);
  });
});
