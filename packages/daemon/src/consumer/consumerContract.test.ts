import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONSUMER_TOKEN_PATTERN,
  ConsumerDiscoverySchema,
  ConsumerErrorSchema,
  type FeedMessage,
  readFeedMessage,
  SessionListSchema,
  SessionLookupSchema,
  SessionReportSchema,
} from '@salidium/consumer-contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type DaemonHandle, startDaemon } from '../daemon.ts';
import {
  consumerCredentialPath,
  createConsumerCredential,
  listConsumerCredentials,
  revokeConsumerCredential,
} from './credentials.ts';
import { consumerDiscovery, consumerDiscoveryPath, experimentalContracts } from './discovery.ts';
import {
  CONSUMER_CANARIES,
  CONSUMER_SECRET,
  consumerScenario,
  SCENARIO_CLOCK,
  SCENARIO_SESSIONS,
} from './scenario.ts';

const root = mkdtempSync(join(tmpdir(), 'salidium-consumer-'));
const home = join(root, 'salidium');
const providers = join(root, 'providers');
let daemon: DaemonHandle;
let token: string;

const CHECKOUT = '/Users/dev/acme/checkout';
const LANE = '/Users/dev/acme/checkout-refunds';
/** The scenario's scratch repository, whose name holds the secret, as it crosses: redacted. */
const SCRATCH = '/Users/dev/scratch-ghp_[GITHUB_TOKEN#1]';
const VERIFIED_ID = `claude-code:${SCENARIO_SESSIONS.verified.sessionId}`;
const WORKING_ID = `claude-code:${SCENARIO_SESSIONS.working.sessionId}`;
const FAILING_ID = `codex:${SCENARIO_SESSIONS.failing.sessionId}`;
const INTERNAL_ID = `claude-code:${SCENARIO_SESSIONS.internal.sessionId}`;

async function start(): Promise<DaemonHandle> {
  return startDaemon({
    home,
    userHome: providers,
    port: 0,
    // No adapters: the Codex one would start `codex app-server` from PATH to read hook trust.
    providers: [],
    gitEnrichment: false,
    historyDays: 0,
    logLevel: 'silent',
    alertSink: { publish: () => {} },
    now: () => SCENARIO_CLOCK,
  });
}

function seed(handle: DaemonHandle): void {
  for (const { sessionId, events } of consumerScenario()) {
    handle.registry.ingest(sessionId, events, { cwd: '/Users/dev/acme/checkout' });
    handle.registry.flush(sessionId);
  }
}

function url(path: string, handle = daemon): string {
  return `http://127.0.0.1:${handle.port}${path}`;
}

/** `null` sends no credential; omitting it sends the test's own. */
async function get(path: string, credential: string | null = token, init: RequestInit = {}) {
  const response = await fetch(url(path), {
    ...init,
    headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: JSON.parse(text) as unknown };
}

/**
 * Parsing with the contract's schema drops any property it does not declare. A document equal to
 * its own parse therefore has every declared property and nothing else: the producer is held to the
 * closed form even though the published JSON Schema leaves objects open for consumers.
 */
function exactly<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.parse(value);
  expect(parsed).toEqual(value);
  matchesReleased(value);
  return parsed;
}

/*
 * What this daemon serves today must still be accepted by every published minor version's JSON
 * Schema, copied unchanged into `schema/v1/released/<major.minor>/`: that is what lets a consumer
 * built against an older minor keep reading a newer Salidium.
 */
const releasedRoot = new URL('../../../consumer-contract/schema/v1/released/', import.meta.url);
const releasedValidators = new Map<string, z.ZodType>();
function matchesReleased(value: unknown): void {
  const format = (value as { format?: unknown }).format;
  if (typeof format !== 'string') throw new Error('a consumer document always names its format');
  const name = format.replace(/^salidium\./, '');
  const versions = readdirSync(releasedRoot);
  expect(versions).toContain('1.0');
  for (const version of versions) {
    const key = `${version}/${name}`;
    let validator = releasedValidators.get(key);
    if (!validator) {
      const file = new URL(`${version}/${name}.schema.json`, releasedRoot);
      validator = z.fromJSONSchema(JSON.parse(readFileSync(file, 'utf8')));
      releasedValidators.set(key, validator);
    }
    expect(validator.safeParse(value).success, `${name} under released ${version}`).toBe(true);
  }
}

beforeAll(async () => {
  mkdirSync(providers, { recursive: true });
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(providers, '.claude'));
  vi.stubEnv('CODEX_HOME', join(providers, '.codex'));
  vi.stubEnv('SALIDIUM_HOME', home);
  daemon = await start();
  seed(daemon);
  token = createConsumerCredential(home, 'contract test').token;
});

afterAll(async () => {
  await daemon?.stop();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('consumer discovery', () => {
  it('publishes the port and contract version in a file that holds no secret', async () => {
    const file = readFileSync(consumerDiscoveryPath(home), 'utf8');
    const discovery = exactly(ConsumerDiscoverySchema, JSON.parse(file));
    expect(discovery.contracts).toEqual([
      {
        name: 'salidium.consumer',
        major: 1,
        minor: 1,
        baseUrl: `http://127.0.0.1:${daemon.port}/consumer/v1`,
      },
    ]);
    expect(file).not.toContain(daemon.token);
    expect(file).not.toMatch(/token"\s*:/);
  });

  it('answers without a credential, with the same instance the file names', async () => {
    const response = await get('/consumer/v1/discovery', null);
    expect(response.status).toBe(200);
    const served = exactly(ConsumerDiscoverySchema, response.body);
    const file = ConsumerDiscoverySchema.parse(
      JSON.parse(readFileSync(consumerDiscoveryPath(home), 'utf8')),
    );
    expect(served.instanceId).toBe(file.instanceId);
    expect(served.pid).toBe(process.pid);
    expect(served.providers).toEqual(file.providers);
  });

  it('lists exactly the providers the instance launched with, which here is none', async () => {
    const served = exactly(
      ConsumerDiscoverySchema,
      (await get('/consumer/v1/discovery', null)).body,
    );
    expect(served.providers).toEqual([]);
  });

  it('keeps listing what it observes when enabled providers change until it restarts', async () => {
    const owner = (path: string, init: RequestInit = {}) =>
      fetch(url(path), {
        ...init,
        headers: { Authorization: `Bearer ${daemon.token}`, ...(init.headers ?? {}) },
      });
    const before = (await (await owner('/api/operations')).json()) as {
      config: { revision: number };
    };
    const changed = await owner('/api/operations/config', {
      method: 'PUT',
      headers: { 'If-Match': String(before.config.revision) },
      body: JSON.stringify({ providers: { enabled: ['claude-code'] } }),
    });
    expect(changed.status).toBe(200);
    const effective = (await changed.json()) as { revision: number; restartRequired: string[] };
    expect(effective.restartRequired).toContain('providers.enabled');
    const served = exactly(
      ConsumerDiscoverySchema,
      (await get('/consumer/v1/discovery', null)).body,
    );
    expect(served.providers).toEqual([]);
    const restored = await owner('/api/operations/config?key=providers.enabled', {
      method: 'DELETE',
      headers: { 'If-Match': String(effective.revision) },
    });
    expect(restored.status).toBe(200);
  });

  it('lists no experimental contract unless the embedder supplies one', async () => {
    const served = exactly(
      ConsumerDiscoverySchema,
      (await get('/consumer/v1/discovery', null)).body,
    );
    expect(served.experimental).toEqual([]);
  });

  it('lists supplied experimental contracts once each, sorted, valid, and at most eight', () => {
    const entry = (name: string, path = 'map') => ({
      name,
      major: 0,
      minor: 1,
      baseUrl: `http://127.0.0.1:47822/${path}/v0`,
    });
    const reasons: string[] = [];
    const listed = experimentalContracts(
      () => [
        entry('salidium.project-map'),
        entry('salidium.another'),
        entry('salidium.project-map'),
        { ...entry('salidium.remote'), baseUrl: 'http://example.com:47822/x/v0' },
        { ...entry('salidium.negative'), major: -1 },
        { ...entry('salidium.elsewhere'), baseUrl: 'http://127.0.0.1:9/map/v0' },
        { ...entry('salidium.no-such-port'), baseUrl: 'http://127.0.0.1:99999/map/v0' },
        'not an entry',
        ...Array.from({ length: 9 }, (_, i) => entry(`salidium.z${i}`)),
      ],
      47822,
      (reason) => reasons.push(reason),
    );
    expect(listed.map((e) => e.name)).toEqual([
      'salidium.another',
      'salidium.project-map',
      'salidium.z0',
      'salidium.z1',
      'salidium.z2',
      'salidium.z3',
      'salidium.z4',
      'salidium.z5',
    ]);
    expect(reasons).toHaveLength(7);
    // A supplier that fails or returns something else lists nothing and does not stop the daemon.
    const failures: string[] = [];
    expect(
      experimentalContracts(
        () => {
          throw new Error('broken supplier');
        },
        47822,
        (reason) => failures.push(reason),
      ),
    ).toEqual([]);
    expect(
      experimentalContracts(
        () => ({ not: 'a list' }),
        47822,
        (r) => failures.push(r),
      ),
    ).toEqual([]);
    expect(failures).toHaveLength(2);
  });

  it('serves the same experimental list in the file and at the endpoint, asked once', async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'salidium-experimental-'));
    let calls = 0;
    const other = await startDaemon({
      home: join(otherRoot, 'salidium'),
      userHome: join(otherRoot, 'providers'),
      port: 0,
      providers: [],
      gitEnrichment: false,
      historyDays: 0,
      logLevel: 'silent',
      alertSink: { publish: () => {} },
      experimentalContracts: ({ port }) => {
        calls += 1;
        return [
          {
            name: 'salidium.project-map',
            major: 0,
            minor: 0,
            baseUrl: `http://127.0.0.1:${port}/project-map/v0`,
          },
        ];
      },
    });
    try {
      const file = ConsumerDiscoverySchema.parse(
        JSON.parse(readFileSync(consumerDiscoveryPath(join(otherRoot, 'salidium')), 'utf8')),
      );
      const response = await fetch(`http://127.0.0.1:${other.port}/consumer/v1/discovery`);
      const served = exactly(ConsumerDiscoverySchema, await response.json());
      expect(served.experimental).toEqual([
        {
          name: 'salidium.project-map',
          major: 0,
          minor: 0,
          baseUrl: `http://127.0.0.1:${other.port}/project-map/v0`,
        },
      ]);
      expect(file.experimental).toEqual(served.experimental);
      expect(calls).toBe(1);
    } finally {
      await other.stop();
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('names each provider once, sorted, by the id lookup takes', () => {
    const discovery = consumerDiscovery({
      port: 47822,
      providers: ['salidium/opencode', 'codex', 'claude-code', 'codex'],
      pid: 1,
      instanceId: '0'.repeat(32),
      startedAt: '2026-10-02T00:00:00.000Z',
      version: '0.0.0',
      now: 0,
    });
    expect(exactly(ConsumerDiscoverySchema, discovery).providers).toEqual([
      { id: 'claude-code' },
      { id: 'codex' },
      { id: 'salidium/opencode' },
    ]);
  });
});

describe('consumer credential boundary', () => {
  it('creates tokens in the published shape and never stores the secret', () => {
    expect(token).toMatch(CONSUMER_TOKEN_PATTERN);
    const stored = readFileSync(consumerCredentialPath(home), 'utf8');
    expect(stored).not.toContain(token.slice(-64));
    expect(listConsumerCredentials(home)).toEqual([
      expect.objectContaining({ label: 'contract test', scopes: ['reports:read'] }),
    ]);
  });

  it('refuses a request with no credential, a malformed one, or a guessed one', async () => {
    const guessed = token.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    for (const credential of [null, 'nope', guessed, `${token}0`, token.toUpperCase()]) {
      const response = await get('/consumer/v1/sessions', credential);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
      exactly(ConsumerErrorSchema, response.body);
    }
  });

  it('does not accept the owner token, which stays the owner token', async () => {
    const response = await get('/consumer/v1/sessions', daemon.token);
    expect(response.status).toBe(401);
    const owner = await fetch(url('/api/sessions'), {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    expect(owner.status).toBe(200);
  });

  it('opens nothing outside the consumer contract', async () => {
    const attempts: Array<[string, string]> = [
      ['GET', '/api/info'],
      ['GET', '/api/sessions'],
      ['GET', `/api/sessions/${encodeURIComponent(VERIFIED_ID)}/snapshot`],
      ['GET', `/api/sessions/${encodeURIComponent(VERIFIED_ID)}/raw/x`],
      ['GET', '/api/stream'],
      ['DELETE', `/api/sessions/${encodeURIComponent(VERIFIED_ID)}`],
      ['PUT', '/api/operations/config'],
      ['PUT', '/api/settings/explainer'],
      ['PUT', '/api/collection'],
      ['POST', `/api/sessions/${encodeURIComponent(VERIFIED_ID)}/personalized-presentation`],
      ['POST', '/api/operations/maintenance/drain'],
      ['POST', '/hooks/claude-code'],
    ];
    for (const [method, path] of attempts) {
      const response = await fetch(url(path), {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    expect(daemon.registry.summaryOf(VERIFIED_ID)).toBeDefined();
  });

  it('refuses every method but GET, even with a valid credential', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(url('/consumer/v1/sessions'), {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET');
    }
  });

  it('keeps the loopback Host and Origin checks, and refuses in the contract envelope', async () => {
    const { request } = await import('node:http');
    const refused = (path: string, headers: Record<string, string>) =>
      new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const req = request(
          url(path),
          { headers: { Authorization: `Bearer ${token}`, ...headers } },
          (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    const cases: Array<[Record<string, string>, number, string]> = [
      [{ Host: `evil.example:${daemon.port}` }, 421, 'host-not-allowed'],
      [{ Origin: 'https://evil.example' }, 403, 'origin-not-allowed'],
      [{ 'Sec-Fetch-Site': 'cross-site' }, 403, 'origin-not-allowed'],
    ];
    for (const [headers, status, error] of cases) {
      const consumer = await refused('/consumer/v1/sessions', headers);
      expect(consumer.status).toBe(status);
      expect(exactly(ConsumerErrorSchema, consumer.body).error).toBe(error);
      // The same guard still answers the owner routes as it always has.
      const owner = await refused('/api/info', headers);
      expect(owner.status).toBe(status);
      expect(owner.body).not.toHaveProperty('format');
    }
  });
});

describe('consumer documents', () => {
  it('lists user sessions by native identity, newest first, never Salidium’s own', async () => {
    const response = await get('/consumer/v1/sessions');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const list = exactly(SessionListSchema, response.body);
    expect(list.sessions.map((session) => session.id)).toEqual([
      WORKING_ID,
      FAILING_ID,
      VERIFIED_ID,
    ]);
    expect(list.sessions.map((session) => session.native)).toEqual([
      SCENARIO_SESSIONS.working,
      SCENARIO_SESSIONS.failing,
      SCENARIO_SESSIONS.verified,
    ]);
    expect(list.total).toBe(3);
    expect(JSON.stringify(list)).not.toContain(INTERNAL_ID);
  });

  it('bounds the list and says when it did', async () => {
    const list = exactly(SessionListSchema, (await get('/consumer/v1/sessions?limit=1')).body);
    expect(list.sessions).toHaveLength(1);
    expect(list).toMatchObject({ total: 3, truncated: true });
    for (const bad of ['0', '-1', '1.5', 'x', '2001'])
      expect((await get(`/consumer/v1/sessions?limit=${bad}`)).status).toBe(400);
  });

  it('looks a session up by the identity the launching tool already has', async () => {
    const { provider, sessionId } = SCENARIO_SESSIONS.failing;
    const found = await get(
      `/consumer/v1/sessions/lookup?provider=${provider}&sessionId=${encodeURIComponent(sessionId)}`,
    );
    expect(found.status).toBe(200);
    const lookup = exactly(SessionLookupSchema, found.body);
    expect(lookup.session).toMatchObject({ id: FAILING_ID, status: 'waiting' });

    const missing = await get(
      '/consumer/v1/sessions/lookup?provider=codex&sessionId=not-yet-reported',
    );
    expect(missing.status).toBe(404);
    expect(exactly(ConsumerErrorSchema, missing.body).error).toBe('session-not-observed');

    const internal = await get(
      `/consumer/v1/sessions/lookup?provider=claude-code&sessionId=${SCENARIO_SESSIONS.internal.sessionId}`,
    );
    expect(internal.status).toBe(404);

    for (const query of ['provider=codex', 'sessionId=x', 'provider=Codex&sessionId=x'])
      expect((await get(`/consumer/v1/sessions/lookup?${query}`)).status).toBe(400);
  });

  it('serves a report of findings with provenance, and none of the session’s content', async () => {
    const response = await get(`/consumer/v1/sessions/${encodeURIComponent(VERIFIED_ID)}/report`);
    expect(response.status).toBe(200);
    const report = exactly(SessionReportSchema, response.body);
    const serialized = JSON.stringify(report);
    for (const canary of Object.values(CONSUMER_CANARIES)) expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(CONSUMER_SECRET);
    expect(serialized).toContain('ghp_[GITHUB_TOKEN#');

    expect(report.session.native).toEqual(SCENARIO_SESSIONS.verified);
    expect(report.session.title).toBe('Fix double charge on retry');
    expect(report.session.repositoryRoot).toBe('/Users/dev/acme/checkout');
    expect(report.latestStatement).toMatchObject({
      text: 'Fixed the double charge with one idempotency key per order.',
      provenance: 'reported',
      author: 'agent',
    });
    const destructive = report.review.groups.find((group) => group.rule === 'destructive:rm-rf');
    expect(destructive?.items[0]?.instance).toBe('rm -rf node_modules/.cache');
    expect(report.verdict).toMatchObject({ tone: 'attention', provenance: 'observed' });
    expect(report.changes.files.map((file) => file.path)).toEqual([
      `${SCRATCH}/notes.md`,
      `${LANE}/src/payments/refunds.ts`,
      `${CHECKOUT}/src/payments/ChargeService.test.ts`,
      `${CHECKOUT}/src/checkout/RetryWorker.ts`,
      `${CHECKOUT}/src/payments/ChargeService.ts`,
    ]);
    // Edited by a subagent: the interface's reason for it is the delegation brief, a tool input.
    const delegated = report.changes.files.find(
      (file) => file.path === `${CHECKOUT}/src/payments/ChargeService.test.ts`,
    );
    expect(delegated?.reason).toBeNull();
    const [, refunds, retry] = report.changes.files;
    expect(refunds?.coverage).toEqual({ verifiedAfter: false, by: null, provenance: 'inferred' });
    expect(retry?.coverage).toMatchObject({ verifiedAfter: true, provenance: 'inferred' });
    expect(report.verification.runs[0]).toMatchObject({
      method: 'test',
      outcome: 'pass',
      counts: { passed: 118, failed: null, skipped: null, total: 118 },
    });
    expect(report.verification.unverifiedFiles).toEqual([
      `${SCRATCH}/notes.md`,
      `${LANE}/src/payments/refunds.ts`,
    ]);
    // 1.1: where the work started and stands, and where each file lives. The agent wrote one file
    // in a linked worktree of the session's repository, which session.repositoryRoot cannot say.
    expect(report.revision).toEqual({
      atStart: {
        root: CHECKOUT,
        head: '3f9a2c1d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b',
        branch: 'fix/double-charge',
        at: expect.any(String),
        provenance: 'observed',
      },
      atLatestTurnEnd: {
        root: CHECKOUT,
        head: '8b1e4d7a2c9f6b3e0d5a8c1f4b7e2d9a6c3f0b5e',
        // The branch name holds the secret, so it is not carried rather than carried altered.
        branch: null,
        at: expect.any(String),
        provenance: 'observed',
      },
    });
    expect(report.changes.files.map((file) => file.repository)).toEqual([
      // The scratch repository's name holds the secret: its location is not carried at all.
      null,
      { root: LANE, path: 'src/payments/refunds.ts', mainRoot: CHECKOUT, provenance: 'observed' },
      {
        root: CHECKOUT,
        path: 'src/payments/ChargeService.test.ts',
        mainRoot: null,
        provenance: 'observed',
      },
      {
        root: CHECKOUT,
        path: 'src/checkout/RetryWorker.ts',
        mainRoot: null,
        provenance: 'observed',
      },
      {
        root: CHECKOUT,
        path: 'src/payments/ChargeService.ts',
        mainRoot: null,
        provenance: 'observed',
      },
    ]);
    expect(report.review.groups.map((group) => group.rule)).toContain('destructive:rm-rf');
    expect(report.remaining.items).toEqual([
      expect.objectContaining({ text: 'Document refund behaviour for support', source: 'plan' }),
    ]);
    expect(report.explanation).toMatchObject({
      status: 'generated',
      provenance: 'explained',
      current: true,
      model: 'claude-opus-5',
    });
    expect(report.explanation.content?.how.root).toBe('ChargeService.ts');
    expect(report.usage).toBeNull();
  });

  it('describes a working session in its own words, not the command line or the prompt', async () => {
    const response = await get(`/consumer/v1/sessions/${encodeURIComponent(WORKING_ID)}/report`);
    const report = exactly(SessionReportSchema, response.body);
    const serialized = JSON.stringify(report);
    for (const canary of Object.values(CONSUMER_CANARIES)) expect(serialized).not.toContain(canary);
    expect(report.session.status).toBe('working');
    expect(report.verdict).toMatchObject({
      headline: 'Running a command',
      tone: 'working',
      provenance: 'observed',
    });
    // The interface would say "Working on: <prompt>" here. That is the user's text.
    expect(report.latestStatement).toBeNull();
  });

  it('says what is unknown with null rather than leaving it out', async () => {
    const response = await get(`/consumer/v1/sessions/${encodeURIComponent(FAILING_ID)}/report`);
    const report = exactly(SessionReportSchema, response.body);
    // Codex gave no title, and the prompt-derived fallback is not carried.
    expect(report.session.title).toBeNull();
    expect(report.session.repositoryRoot).toBeNull();
    // Nothing watched this session's boundaries or located its files: null, never a guess.
    expect(report.revision).toEqual({ atStart: null, atLatestTurnEnd: null });
    expect(report.changes.files.map((file) => file.repository)).toEqual([null]);
    expect(report.session.endedAt).toBeNull();
    expect(report.explanation).toEqual({
      status: 'disabled',
      provenance: 'explained',
      current: false,
      basedOnSeq: null,
      generatedAt: null,
      model: null,
      content: null,
    });
    expect(report.waiting).toMatchObject({ kind: 'permission' });
    expect(report.waiting).toMatchObject({ kind: 'permission', provenance: 'observed' });
    expect(report.verdict).toMatchObject({
      tone: 'attention',
      headline: 'Waiting for you',
      provenance: 'observed',
    });
    expect(report.verification.runs[0]).toMatchObject({
      outcome: 'fail',
      exit: { code: 1, observation: 'explicit' },
      provenance: 'observed',
    });
  });

  it('does not serve Salidium’s own sessions or unknown ones', async () => {
    for (const segment of [encodeURIComponent(INTERNAL_ID), encodeURIComponent('codex:unknown')])
      expect((await get(`/consumer/v1/sessions/${segment}/report`)).status).toBe(404);
  });

  it('answers a long session id or one with control characters in the contract’s own codes', async () => {
    for (const id of [
      `claude-code:${'a'.repeat(600)}`,
      'a'.repeat(513),
      'claude-code:a\u0001b',
      'claude-code:a\u0000b',
      'a\u007fb',
      'claude-code:a\nb',
    ]) {
      const report = await get(`/consumer/v1/sessions/${encodeURIComponent(id)}/report`);
      expect(report.status, JSON.stringify(id)).toBe(404);
      expect(exactly(ConsumerErrorSchema, report.body).error).toBe('not-found');
      const native = id.replace(/^claude-code:/, '');
      const lookup = await get(
        `/consumer/v1/sessions/lookup?provider=claude-code&sessionId=${encodeURIComponent(native)}`,
      );
      expect(lookup.status, JSON.stringify(id)).toBe(400);
      expect(exactly(ConsumerErrorSchema, lookup.body).error).toBe('bad-request');
    }
  });

  it('answers a session id with malformed percent-encoding as a bad request, not a failure', async () => {
    for (const segment of ['%E0%A4%A', '%', 'claude-code%3A%ZZ']) {
      const { status, headers, body } = await get(`/consumer/v1/sessions/${segment}/report`);
      expect(status, segment).toBe(400);
      expect(headers.get('cache-control')).toBe('no-store');
      expect(exactly(ConsumerErrorSchema, body).error).toBe('bad-request');
    }
  });
});

describe('consumer reads have no side effects', () => {
  it('reads a stored session without loading it, and the credential survives a restart', async () => {
    await daemon.stop();
    expect(existsSync(consumerDiscoveryPath(home))).toBe(false);
    daemon = await start();
    expect(existsSync(consumerDiscoveryPath(home))).toBe(true);
    expect(daemon.registry.peek(VERIFIED_ID)).toBeUndefined();

    const report = await get(`/consumer/v1/sessions/${encodeURIComponent(VERIFIED_ID)}/report`);
    expect(report.status).toBe(200);
    exactly(SessionReportSchema, report.body);
    const list = await get('/consumer/v1/sessions');
    expect(exactly(SessionListSchema, list.body).total).toBe(3);
    // Loaded sessions are exempt from retention, so a read that loaded one would let a polling
    // tool decide what retention may remove.
    expect(daemon.registry.peek(VERIFIED_ID)).toBeUndefined();
    expect(daemon.registry.peek(FAILING_ID)).toBeUndefined();
  });
});

async function openFeed(credential: string) {
  const controller = new AbortController();
  const response = await fetch(url('/consumer/v1/feed'), {
    headers: { Authorization: `Bearer ${credential}` },
    signal: controller.signal,
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('no feed body');
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (): Promise<FeedMessage | 'ended'> => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n');
        if (!data) continue;
        const message = readFeedMessage(data);
        if (message) {
          matchesReleased(message);
          return message;
        }
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return 'ended';
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return { response, next, close: () => controller.abort() };
}

describe('consumer change feed', () => {
  it('starts with resync, then says which report changed and how to recognize the new one', async () => {
    const feed = await openFeed(token);
    expect(feed.response.headers.get('content-type')).toContain('text/event-stream');
    expect(await feed.next()).toMatchObject({ type: 'resync', reason: 'connected' });

    const before = daemon.registry.summaryOf(FAILING_ID)?.latestSeq ?? -1;
    daemon.registry.ingest(FAILING_ID, [
      {
        id: `${FAILING_ID}#late-message`,
        sessionId: FAILING_ID,
        ts: '2026-09-20T16:12:00.000Z',
        tsSource: 'provider',
        source: { provider: 'codex', channel: 'rollout' },
        kind: 'agent.message',
        text: 'Still waiting for approval to push.',
      },
    ]);
    daemon.registry.flush(FAILING_ID);
    const changed = await feed.next();
    expect(changed).toMatchObject({
      type: 'session.changed',
      sessionId: FAILING_ID,
      native: SCENARIO_SESSIONS.failing,
    });
    expect(changed !== 'ended' && changed.type === 'session.changed' && changed.evidenceSeq).toBe(
      before + 1,
    );
    feed.close();
  });

  it('closes an open feed when its credential is revoked, and refuses the next request', async () => {
    const { credential, token: doomed } = createConsumerCredential(home, 'to revoke');
    const feed = await openFeed(doomed);
    expect(await feed.next()).toMatchObject({ type: 'resync' });
    expect(revokeConsumerCredential(home, credential.id)).toBe(true);
    expect((await get('/consumer/v1/sessions', doomed)).status).toBe(401);
    let message = await feed.next();
    while (message !== 'ended' && message.type === 'heartbeat') message = await feed.next();
    expect(message).toMatchObject({ type: 'closing', reason: 'credential-revoked' });
    expect(await feed.next()).toBe('ended');
    expect((await get('/consumer/v1/sessions')).status).toBe(200);
  });

  it('reports a removed session', async () => {
    const feed = await openFeed(token);
    await feed.next();
    daemon.registry.forget(FAILING_ID);
    let message = await feed.next();
    while (message !== 'ended' && message.type !== 'session.removed') message = await feed.next();
    expect(message).toMatchObject({
      type: 'session.removed',
      sessionId: FAILING_ID,
      native: SCENARIO_SESSIONS.failing,
    });
    feed.close();
  });
});

/*
 * The store keeps whatever id a provider wrote, but the contract's native identity is bounded: at
 * most 512 characters and no control characters. A stored session outside that cannot be named in
 * a valid document, so it is left out rather than allowed to make the whole list, or the feed a
 * consumer reads with `readFeedMessage`, fail validation.
 */
describe('sessions the contract cannot identify', () => {
  const UNREPRESENTABLE = [
    `codex:${'x'.repeat(600)}`,
    'codex:bad\u0001id',
    'codex:bad\u007fid',
    'codex:bad\nid',
  ];
  const NEIGHBOUR = 'codex:representable-neighbour';
  const message = (sessionId: string) => ({
    id: `${sessionId}#m1`,
    sessionId,
    ts: '2026-09-20T16:13:00.000Z',
    tsSource: 'provider' as const,
    source: { provider: 'codex' as const, channel: 'rollout' as const },
    kind: 'agent.message' as const,
    text: 'Checked the migration.',
  });

  it('leaves them out of the list and the feed, and does not report them', async () => {
    const before = exactly(SessionListSchema, (await get('/consumer/v1/sessions?limit=2000')).body);
    const feed = await openFeed(token);
    expect(await feed.next()).toMatchObject({ type: 'resync' });
    try {
      for (const id of [...UNREPRESENTABLE, NEIGHBOUR]) {
        daemon.registry.ingest(id, [message(id)], { cwd: CHECKOUT });
        daemon.registry.flush(id);
      }
      for (const id of UNREPRESENTABLE)
        expect(daemon.registry.summaryOf(id), 'stored as the provider wrote it').toBeDefined();

      // The first message after resync is the neighbour: nothing was sent for the others.
      expect(await feed.next()).toMatchObject({ type: 'session.changed', sessionId: NEIGHBOUR });

      const after = exactly(
        SessionListSchema,
        (await get('/consumer/v1/sessions?limit=2000')).body,
      );
      expect(after.total).toBe(before.total + 1);
      expect(after.sessions.map((s) => s.id)).toContain(NEIGHBOUR);
      for (const id of UNREPRESENTABLE) expect(after.sessions.map((s) => s.id)).not.toContain(id);
      const bounded = exactly(SessionListSchema, (await get('/consumer/v1/sessions?limit=1')).body);
      expect(bounded.total).toBe(after.total);

      for (const id of UNREPRESENTABLE) {
        const report = await get(`/consumer/v1/sessions/${encodeURIComponent(id)}/report`);
        expect(report.status, JSON.stringify(id)).toBe(404);
        expect(exactly(ConsumerErrorSchema, report.body).error).toBe('not-found');
      }
    } finally {
      feed.close();
      for (const id of [...UNREPRESENTABLE, NEIGHBOUR]) daemon.registry.forget(id);
    }
  });
});

describe('consumer contract edges', () => {
  it('names the repository each revision anchor read, when the session moved into a clone', async () => {
    const { applyEvent, createInitialState, createRedactor, projectSession, summarizeSession } =
      await import('@salidium/core');
    const { EventBuilder } = await import('@salidium/core/testing');
    const { consumerText, toSessionReport } = await import('./report.ts');
    const b = new EventBuilder('claude-code:moved', '2026-09-20T16:00:00.000Z');
    const state = createInitialState({
      sessionId: 'claude-code:moved',
      provider: 'claude-code',
      providerSessionId: 'moved',
      cwd: '/work/a',
    });
    const head = 'c'.repeat(40);
    const snapshot = (id: string, repoRoot: string, trigger: 'session.started' | 'turn.ended') =>
      b.raw({ id, kind: 'git.snapshot', repoRoot, head, branch: 'main', trigger } as never);
    for (const event of [
      b.sessionStarted('/work/a'),
      snapshot('git:a', '/work/a', 'session.started'),
      b.turnStarted('Work in the clone'),
      b.raw({ id: 'moved', kind: 'session.updated', cwd: '/work/b' } as never),
      b.turnEnded('Done.'),
      snapshot('git:b', '/work/b', 'turn.ended'),
    ])
      applyEvent(state, event);
    const at = Date.parse('2026-09-20T16:01:00.000Z');
    const report = exactly(
      SessionReportSchema,
      toSessionReport(
        state,
        projectSession(state, at),
        summarizeSession(state, at),
        at,
        consumerText(createRedactor()),
      ),
    );
    expect(report.session.repositoryRoot).toBe('/work/a');
    expect(report.revision.atStart).toMatchObject({ root: '/work/a', head });
    expect(report.revision.atLatestTurnEnd).toMatchObject({ root: '/work/b', head });
  });

  it('says a removed line count is a floor when a provider did not record what it replaced', async () => {
    const { applyEvent, createInitialState, createRedactor, projectSession, summarizeSession } =
      await import('@salidium/core');
    const { EventBuilder } = await import('@salidium/core/testing');
    const { consumerText, toSessionReport } = await import('./report.ts');
    const b = new EventBuilder('claude-code:overwrite', '2026-09-20T16:00:00.000Z');
    const state = createInitialState({
      sessionId: 'claude-code:overwrite',
      provider: 'claude-code',
      providerSessionId: 'overwrite',
      cwd: '/repo',
    });
    for (const event of [
      b.sessionStarted('/repo'),
      b.turnStarted('Rewrite the config'),
      ...b.edit('e1', '/repo/exact.ts', 2, 1),
      b.toolCalled('w1', 'write', { kind: 'fileWrite', path: '/repo/config.ts' }),
      b.toolCompleted('w1', 'write', {
        kind: 'fileChanges',
        changes: [
          {
            path: '/repo/config.ts',
            change: 'update',
            linesAdded: 9,
            linesRemoved: 0,
            linesRemovedUnknown: true,
            applied: true,
          },
        ],
      }),
    ])
      applyEvent(state, event);
    const at = Date.parse('2026-09-20T16:01:00.000Z');
    const report = exactly(
      SessionReportSchema,
      toSessionReport(
        state,
        projectSession(state, at),
        summarizeSession(state, at),
        at,
        consumerText(createRedactor()),
      ),
    );
    expect(report.session.counts).toMatchObject({ linesRemoved: 1, linesRemovedExact: false });
    expect(
      Object.fromEntries(
        report.changes.files.map((f) => [f.path, [f.linesRemoved, f.linesRemovedExact]]),
      ),
    ).toEqual({ '/repo/exact.ts': [1, true], '/repo/config.ts': [0, false] });
  });

  it('describes a running code cell in Salidium’s words, never its script', async () => {
    const { applyEvent, createInitialState, createRedactor, projectSession, summarizeSession } =
      await import('@salidium/core');
    const { codexAdapter } = await import('@salidium/adapter-codex');
    const { consumerText, toSessionReport } = await import('./report.ts');
    const thread = '01a00001-0000-7000-8000-00000000c0de';
    const script = `const r = await tools.exec_command({"cmd":"npm test ${CONSUMER_CANARIES.command}"});\ntext("${CONSUMER_CANARIES.output}");\n`;
    const records = (cliVersion: string | undefined) => [
      {
        timestamp: '2026-09-20T16:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: thread,
          cwd: '/repo',
          originator: 'codex_work_desktop',
          cli_version: cliVersion,
        },
      },
      {
        timestamp: '2026-09-20T16:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      },
      {
        timestamp: '2026-09-20T16:00:02.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call', call_id: 'call_cell', name: 'exec', input: script },
      },
    ];
    // A current build's cell is a step; an unversioned one's is still the command. Neither crosses.
    for (const [cliVersion, headline] of [
      ['0.158.0-alpha.2.1', 'Working'],
      [undefined, 'Running a command'],
    ] as const) {
      const parser = codexAdapter.createRecordParser({
        sessionId: `codex:${thread}`,
        providerSessionId: thread,
        path: '/tmp/rollout.jsonl',
        observedAt: '2026-09-20T16:00:00.000Z',
      });
      const state = createInitialState({
        sessionId: `codex:${thread}`,
        provider: 'codex',
        providerSessionId: thread,
        cwd: '/repo',
      });
      let seq = 0;
      records(cliVersion).forEach((record, line) => {
        for (const event of parser.parseRecord(JSON.stringify(record), line))
          applyEvent(state, { ...event, seq: seq++ } as never);
      });
      const at = Date.parse('2026-09-20T16:01:00.000Z');
      const report = exactly(
        SessionReportSchema,
        toSessionReport(
          state,
          projectSession(state, at),
          summarizeSession(state, at),
          at,
          consumerText(createRedactor()),
        ),
      );
      expect(report.verdict).toMatchObject({ tone: 'working', headline });
      const serialized = JSON.stringify(report);
      for (const canary of Object.values(CONSUMER_CANARIES))
        expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain('tools.exec_command');
    }
  });

  it('labels a question read from the agent’s message as reported, and the verdict follows', async () => {
    const { applyEvent, createInitialState, projectSession } = await import('@salidium/core');
    const { EventBuilder } = await import('@salidium/core/testing');
    const { consumerText, toSessionReport } = await import('./report.ts');
    const { createRedactor, summarizeSession } = await import('@salidium/core');
    const b = new EventBuilder('claude-code:asks', '2026-09-20T16:00:00.000Z');
    const state = createInitialState({
      sessionId: 'claude-code:asks',
      provider: 'claude-code',
      providerSessionId: 'asks',
      cwd: '/repo',
    });
    for (const event of [
      b.sessionStarted('/repo'),
      b.turnStarted('Rename the flag'),
      b.turnEnded('Renamed it everywhere. Should I also update the migration guide?'),
    ])
      applyEvent(state, event);
    const at = Date.parse('2026-09-20T16:01:00.000Z');
    const report = toSessionReport(
      state,
      projectSession(state, at),
      summarizeSession(state, at),
      at,
      consumerText(createRedactor()),
    );
    exactly(SessionReportSchema, report);
    expect(report.waiting).toMatchObject({ kind: 'question', provenance: 'reported' });
    expect(report.verdict).toMatchObject({ headline: 'Waiting for you', provenance: 'reported' });
  });

  it('answers a failure inside a handler with a contract error, not the owner API shape', async () => {
    const { createServer } = await import('node:http');
    const { createConsumerRoutes } = await import('./routes.ts');
    const { ConsumerCredentialVerifier } = await import('./credentials.ts');
    const errorHome = mkdtempSync(join(tmpdir(), 'salidium-consumer-error-'));
    const { token: errorToken } = createConsumerCredential(errorHome, 'error test');
    const routes = createConsumerRoutes({
      registry: {
        listSessions: () => {
          throw new Error('store unavailable');
        },
      } as never,
      credentials: new ConsumerCredentialVerifier(errorHome),
      discovery: () => ({}) as never,
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    });
    const server = createServer((req, res) =>
      routes.handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1')),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/consumer/v1/sessions`, {
      headers: { Authorization: `Bearer ${errorToken}` },
    });
    expect(response.status).toBe(500);
    const body = exactly(ConsumerErrorSchema, await response.json());
    expect(body.error).toBe('internal');
    expect(body.message).not.toContain('store unavailable');
    routes.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(errorHome, { recursive: true, force: true });
  });
});

describe('identifiers at the boundary', () => {
  it('redacts a located path like any text that crosses, and never clips or reflows it', async () => {
    const { createRedactor } = await import('@salidium/core');
    const { consumerText, repository } = await import('./report.ts');
    const text = consumerText(createRedactor());
    const spaced = '/Users/dev/My  Project';
    expect(repository({ root: spaced, path: 'a  b.ts' }, text)).toEqual({
      root: spaced,
      path: 'a  b.ts',
      mainRoot: null,
      provenance: 'observed',
    });
    // One the redactor would change is not carried altered, which would name another path: null.
    expect(repository({ root: `/tmp/${CONSUMER_SECRET}`, path: 'x.ts' }, text)).toBeNull();
    expect(
      repository({ root: '/tmp/repo', path: 'x.ts', mainRoot: `/srv/${CONSUMER_SECRET}` }, text),
    ).toBeNull();
    // Too long to carry whole: the whole location is null, because a clipped path names something
    // else.
    expect(repository({ root: `/${'d'.repeat(4096)}`, path: 'x.ts' }, text)).toBeNull();
    expect(repository(null, text)).toBeNull();
    expect(repository(undefined, text)).toBeNull();
  });
});

describe('retained fixtures', () => {
  it('carry none of the planted content, because they are what other products copy', async () => {
    const dir = new URL('../../../consumer-contract/fixtures/v1/', import.meta.url);
    // Every minor version's set: 1.0 at the top, later minors in their own directories.
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((file) =>
      file.endsWith('.json'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      for (const canary of Object.values(CONSUMER_CANARIES)) expect(text).not.toContain(canary);
      expect(text).not.toContain(CONSUMER_SECRET);
    }
  });
});
