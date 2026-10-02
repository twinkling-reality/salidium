/*
 * Writes the consumer contract's JSON Schema files and, while a version is being prepared, its
 * retained fixtures.
 *
 *   pnpm build && node scripts/write-consumer-contract.mjs --schema
 *   pnpm build && node scripts/write-consumer-contract.mjs --fixtures
 *
 * `--schema` regenerates `packages/consumer-contract/schema/v1/*.schema.json` from the zod source
 * of truth. A test fails whenever the committed files and the source disagree, so run it after
 * every schema change and review the diff: within major version 1 it may only add.
 *
 * `--fixtures` boots a real daemon on a temporary home, seeds the synthetic sessions in
 * `packages/daemon/src/consumer/scenario.ts` through the real ingest, and records what the consumer
 * endpoints actually return, into the directory for the contract's current minor version:
 * `fixtures/v1/` for 1.0, which was published there, and `fixtures/v1/<major.minor>/` for every
 * later minor. Fixtures are write-once: they are evidence about a released version, so this
 * refuses to write into a directory that already holds any. Removing them to regenerate is
 * legitimate only before that version is first published; see docs/releasing.md.
 *
 * Nothing here reads the person's own Salidium state or provider homes.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const contractDir = join(root, 'packages', 'consumer-contract');
const contract = await import(join(contractDir, 'dist', 'index.js'));
const mode = process.argv[2];

function write(path, value) {
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  process.stdout.write(`wrote ${path.slice(root.length)}\n`);
}

if (mode === '--schema') {
  const dir = join(contractDir, 'schema', 'v1');
  mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(contract.CONSUMER_DOCUMENTS))
    write(join(dir, `${name}.schema.json`), contract.consumerJsonSchemaText(name));
} else if (mode === '--fixtures') {
  const { major, minor } = contract.CONSUMER_CONTRACT;
  const base = join(contractDir, 'fixtures', `v${major}`);
  const dir = minor === 0 ? base : join(base, `${major}.${minor}`);
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).some((file) => file.endsWith('.json'))) {
    process.stderr.write(
      `${dir} already holds fixtures. They are write-once; see docs/releasing.md before removing them.\n`,
    );
    process.exit(1);
  }
  await writeFixtures(dir);
} else {
  process.stderr.write('usage: node scripts/write-consumer-contract.mjs --schema | --fixtures\n');
  process.exit(2);
}

async function writeFixtures(dir) {
  const temporary = mkdtempSync(join(tmpdir(), 'salidium-consumer-fixtures-'));
  // Provider discovery reads these, not HOME, so both must point somewhere empty.
  process.env.CLAUDE_CONFIG_DIR = join(temporary, 'providers', '.claude');
  process.env.CODEX_HOME = join(temporary, 'providers', '.codex');
  process.env.SALIDIUM_HOME = join(temporary, 'salidium');
  process.env.SALIDIUM_EXPLAINER = 'off';
  // The daemon looks for a `codex` executable to read hook trust when codex is enabled. The
  // providers here are inert stand-ins, and no provider tool may run while fixtures are captured.
  const { withoutProviderExecutables } = await import(
    join(root, 'packages', 'adapter-kit', 'dist', 'testing', 'providerIsolation.js')
  );
  process.env.PATH = withoutProviderExecutables(process.env.PATH);
  const { startDaemon, createConsumerCredential, revokeConsumerCredential } = await import(
    join(root, 'packages', 'daemon', 'dist', 'index.js')
  );
  const scenario = await import(
    join(root, 'packages', 'daemon', 'dist', 'consumer', 'scenario.js')
  );
  const home = join(temporary, 'salidium');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const daemon = await startDaemon({
    version,
    home,
    userHome: join(temporary, 'providers'),
    port: 0,
    // Enabled, so discovery lists them, but inert: nothing reads provider state.
    providers: ['claude-code', 'codex'],
    providerDescriptors: scenario.inertProviderDescriptors(['claude-code', 'codex']),
    gitEnrichment: false,
    historyDays: 0,
    logLevel: 'silent',
    alertSink: { publish: () => {} },
    now: () => scenario.SCENARIO_CLOCK,
  });
  try {
    for (const { sessionId, events } of scenario.consumerScenario()) {
      daemon.registry.ingest(sessionId, events, { cwd: '/Users/dev/acme/checkout' });
      daemon.registry.flush(sessionId);
    }
    const { credential, token } = createConsumerCredential(home, 'fixture capture');
    const base = `http://127.0.0.1:${daemon.port}/consumer/v1`;
    const get = async (path, withToken = true) => {
      const response = await fetch(`${base}${path}`, {
        headers: withToken ? { Authorization: `Bearer ${token}` } : {},
      });
      return response.json();
    };
    const { verified, failing } = scenario.SCENARIO_SESSIONS;

    // The only values that differ between runs: which port, process, and instance answered.
    const discovery = await get('/discovery', false);
    write(join(dir, 'consumer-discovery.json'), {
      ...discovery,
      contracts: discovery.contracts.map((entry) => ({
        ...entry,
        baseUrl: entry.baseUrl.replace(/:\d+\//, ':47822/'),
      })),
      instanceId: '5f0e2b7c9a1d4e3f8b6a0c2d4e6f8a1b',
      pid: 48213,
      startedAt: '2026-09-20T16:00:00.000Z',
    });
    write(join(dir, 'session-list.json'), await get('/sessions'));
    write(
      join(dir, 'session-lookup.json'),
      await get(`/sessions/lookup?provider=${failing.provider}&sessionId=${failing.sessionId}`),
    );
    write(
      join(dir, 'session-report-verified.json'),
      await get(
        `/sessions/${encodeURIComponent(`${verified.provider}:${verified.sessionId}`)}/report`,
      ),
    );
    const { working } = scenario.SCENARIO_SESSIONS;
    write(
      join(dir, 'session-report-working.json'),
      await get(
        `/sessions/${encodeURIComponent(`${working.provider}:${working.sessionId}`)}/report`,
      ),
    );
    write(
      join(dir, 'session-report-failing.json'),
      await get(
        `/sessions/${encodeURIComponent(`${failing.provider}:${failing.sessionId}`)}/report`,
      ),
    );
    write(join(dir, 'consumer-error-unauthorized.json'), await get('/sessions', false));
    write(
      join(dir, 'consumer-error-session-not-observed.json'),
      await get('/sessions/lookup?provider=codex&sessionId=not-yet-reported'),
    );

    const feed = await openFeed(`${base}/feed`, token);
    write(join(dir, 'session-feed-resync.json'), await feed.next('resync'));
    const failingId = `${failing.provider}:${failing.sessionId}`;
    daemon.registry.ingest(failingId, [
      {
        id: `${failingId}#late-message`,
        sessionId: failingId,
        ts: '2026-09-20T16:12:00.000Z',
        tsSource: 'provider',
        source: { provider: 'codex', channel: 'rollout' },
        kind: 'agent.message',
        text: 'Still waiting for approval to push.',
      },
    ]);
    daemon.registry.flush(failingId);
    write(join(dir, 'session-feed-session-changed.json'), await feed.next('session.changed'));
    process.stdout.write('waiting for a heartbeat (15 s)\n');
    write(join(dir, 'session-feed-heartbeat.json'), await feed.next('heartbeat'));
    daemon.registry.forget(failingId);
    write(join(dir, 'session-feed-session-removed.json'), await feed.next('session.removed'));
    revokeConsumerCredential(home, credential.id);
    write(join(dir, 'session-feed-closing.json'), await feed.next('closing'));
  } finally {
    await daemon.stop();
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function openFeed(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(type) {
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
          if (data && JSON.parse(data).type === type) return JSON.parse(data);
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`feed ended before a ${type} message`);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}
