/*
 * A real, fully isolated Salidium daemon for testing a consumer of the read-only contract.
 *
 *   pnpm build && node scripts/consumer-test-daemon.mjs [--port N]
 *
 * It creates a temporary Salidium home and empty provider directories, so it never reads or writes
 * the person's own Salidium state, transcripts, or provider settings, installs no hooks, enables no
 * provider adapter, and starts no provider process. Its clock is fixed at the scenario's instant
 * (2026-09-20T16:20:00.000Z), so statuses and timestamps are the same on every run. It
 * seeds the synthetic sessions in `packages/daemon/src/consumer/scenario.ts` through the real ingest,
 * creates one consumer credential, and prints a single JSON line on stdout:
 *
 *   {"home": ..., "discovery": ..., "baseUrl": ..., "token": ..., "sessions": {...}}
 *
 * `sessions` holds the native identities to look up. Then it reads commands, one per line, on
 * stdin, so a test can drive each feed message deterministically:
 *
 *   message   append an agent message to the open Codex session (feed: session.changed)
 *   forget    delete the open Codex session (feed: session.removed)
 *   revoke    revoke the printed credential (feed: closing, then 401 on every request)
 *   stop      stop the daemon (feed: closing) and remove the temporary home
 *
 * Each command answers with one JSON line: {"ok": true, "command": ...}. Closing stdin or sending
 * SIGINT or SIGTERM also stops it. The token is a test credential for a throwaway home; it is
 * printed because it opens nothing else.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const portFlag = process.argv.indexOf('--port');
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 0;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('--port must be a whole number from 0 to 65535\n');
  process.exit(2);
}

const temporary = mkdtempSync(join(tmpdir(), 'salidium-consumer-test-'));
const providers = join(temporary, 'providers');
mkdirSync(providers, { recursive: true });
// Provider discovery reads these, not HOME, so both must point somewhere empty. SALIDIUM_HOME is
// what the daemon's own worker processes check their store path against.
const home = join(temporary, 'salidium');
process.env.CLAUDE_CONFIG_DIR = join(providers, '.claude');
process.env.CODEX_HOME = join(providers, '.codex');
process.env.SALIDIUM_HOME = home;

const daemonDist = join(root, 'packages', 'daemon', 'dist');
const { startDaemon, createConsumerCredential, revokeConsumerCredential, consumerDiscoveryPath } =
  await import(join(daemonDist, 'index.js'));
const scenario = await import(join(daemonDist, 'consumer', 'scenario.js'));

const daemon = await startDaemon({
  home,
  userHome: providers,
  port,
  // No provider adapters: nothing to discover in empty directories, and the Codex adapter would
  // start `codex app-server` from PATH to read hook trust.
  providers: [],
  // The scenario's clock, so every run reads the same statuses and timestamps.
  now: () => scenario.SCENARIO_CLOCK,
  gitEnrichment: false,
  historyDays: 0,
  logLevel: 'silent',
  alertSink: { publish: () => {} },
});
for (const { sessionId, events } of scenario.consumerScenario()) {
  daemon.registry.ingest(sessionId, events, { cwd: '/Users/dev/acme/checkout' });
  daemon.registry.flush(sessionId);
}
// Session summaries are debounced by 100 ms. Let the ones seeding produced fire before announcing
// readiness, so a feed opened after the ready line starts with resync and nothing left over.
await new Promise((resolve) => setTimeout(resolve, 500));
const { credential, token } = createConsumerCredential(home, 'consumer test daemon');
const { failing } = scenario.SCENARIO_SESSIONS;
const openSession = `${failing.provider}:${failing.sessionId}`;

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await daemon.stop();
  rmSync(temporary, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

process.stdout.write(
  `${JSON.stringify({
    home,
    discovery: consumerDiscoveryPath(home),
    baseUrl: `http://127.0.0.1:${daemon.port}/consumer/v1`,
    token,
    sessions: scenario.SCENARIO_SESSIONS,
  })}\n`,
);

let messages = 0;
const commands = {
  message() {
    messages += 1;
    daemon.registry.ingest(openSession, [
      {
        id: `${openSession}#test-message:${messages}`,
        sessionId: openSession,
        // The daemon's clock, so a run is reproducible to the byte.
        ts: new Date(scenario.SCENARIO_CLOCK).toISOString(),
        tsSource: 'provider',
        source: { provider: 'codex', channel: 'rollout' },
        kind: 'agent.message',
        text: `Still waiting for approval to push (${messages}).`,
      },
    ]);
    daemon.registry.flush(openSession);
  },
  forget() {
    daemon.registry.forget(openSession);
  },
  revoke() {
    revokeConsumerCredential(home, credential.id);
  },
};

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const command = line.trim();
  if (!command) return;
  if (command === 'stop') {
    process.stdout.write(`${JSON.stringify({ ok: true, command })}\n`);
    void stop();
    return;
  }
  const run = commands[command];
  if (!run) {
    process.stdout.write(`${JSON.stringify({ ok: false, command, error: 'unknown command' })}\n`);
    return;
  }
  run();
  process.stdout.write(`${JSON.stringify({ ok: true, command })}\n`);
});
input.on('close', () => void stop());
