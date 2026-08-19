import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCodeProvider } from '@salidium/adapter-claude-code';
import { codexProvider } from '@salidium/adapter-codex';
import {
  type ProviderDescriptor,
  ProviderRegistry,
  trustedPathEntries,
} from '@salidium/adapter-kit';
import {
  type DaemonInfo,
  type ExplainerCadence,
  type ExplainerSettings,
  PROTOCOL_VERSION,
} from '@salidium/protocol';
import { type DaemonConfig, daemonPaths, resolveDaemonConfig } from './config/daemonConfig.ts';
import { configuredExplainerMode } from './enrich/explainerBackends.ts';
import { GitSnapshotEnricher } from './enrichers/gitSnapshot.ts';
import { HookIngress } from './ingest/hookIngress.ts';
import {
  MAX_HOOK_DAILY_SPOOL_BYTES,
  MAX_INGEST_PAYLOAD_BYTES,
  TRUNCATED_HOOK_PAYLOAD_KEY,
} from './ingest/limits.ts';
import { TranscriptTailer } from './ingest/transcriptTailer.ts';
import { createLogger } from './logging/logger.ts';
import { createHttpServer } from './server/httpServer.ts';
import { effectiveCadence } from './sessions/sessionCoordinator.ts';
import { SessionRegistry } from './sessions/sessionRegistry.ts';
import type { SalidiumStoreFactory } from './storage/salidiumStore.ts';
import { createSqliteStore, SCHEMA_VERSION } from './storage/sqliteStore.ts';

export interface DaemonHandle {
  config: DaemonConfig;
  port: number;
  token: string;
  registry: SessionRegistry;
  hooks: HookIngress;
  tailer: TranscriptTailer;
  stop(): Promise<void>;
}

export interface DaemonJson {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  version: string;
  /** Absent on old daemon records; callers must restart before using a mismatched runtime. */
  protocolVersion?: string;
  storeSchemaVersion?: number;
}

export type StartDaemonOptions = Partial<DaemonConfig> & {
  version?: string;
  /**
   * Explicit adapter set for an embedding application. Salidium never searches a project or
   * node_modules for executable plug-ins; callers must load and pass reviewed descriptors.
   */
  providerDescriptors?: readonly ProviderDescriptor[];
  /** Internal persistence seam; SQLite is the production authority and default. */
  storeFactory?: SalidiumStoreFactory;
  /** Test/embedding seam. Production retention sweeps run once per hour. */
  retentionSweepIntervalMs?: number;
};

const BUILT_IN_PROVIDERS: readonly ProviderDescriptor[] = [claudeCodeProvider, codexProvider];
const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000;

const require = createRequire(import.meta.url);
const VERSION: string = (() => {
  try {
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

/**
 * The choices that outlive a restart, in `settings.json` beside `daemon.json`.
 *
 * A separate file from `daemon.json` on purpose: that one is written fresh on every start and is
 * how the CLI and the hook relay find a running daemon, so anything the reader chose would be
 * destroyed by the next `salidium restart`. This one is only ever written when a choice is made.
 *
 * Not in `daemon.json`'s directory config either. `DaemonConfig` is resolved from flags and the
 * environment on each start — it describes how this process was launched, and a stop the reader
 * picked in a browser is not that.
 */
export interface StoredSettings {
  explainerCadence: ExplainerCadence;
}

/** The stop that shipped: a fresh explanation at every turn end. */
const DEFAULT_SETTINGS: StoredSettings = { explainerCadence: 'turn' };

function settingsPath(home: string): string {
  return join(home, 'settings.json');
}

/**
 * Reads the stored choices. A missing file gets the shipped default; an existing invalid file
 * fails closed so corruption can never silently resume optional provider calls.
 *
 * A settings file that cannot be parsed must not stop the daemon: it holds preferences, and the
 * product is complete without them. It is validated field by field rather than trusted, because a
 * cadence of `"maybe"` would otherwise reach the coordinator as one.
 */
export function readSettings(home: string, onInvalid?: (reason: string) => void): StoredSettings {
  const path = settingsPath(home);
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const cadence = (raw as { explainerCadence?: unknown } | null)?.explainerCadence;
    if (cadence === 'off' || cadence === 'session' || cadence === 'turn') {
      return { explainerCadence: cadence };
    }
    onInvalid?.('explainerCadence is missing or unknown');
  } catch (err) {
    onInvalid?.(err instanceof Error ? err.message : String(err));
  }
  return { explainerCadence: 'off' };
}

export function writeSettings(home: string, settings: StoredSettings): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = settingsPath(home);
  const temporary = join(home, `.settings-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (err) {
    try {
      unlinkSync(temporary);
    } catch {
      /* never hide the original write/replace error */
    }
    throw err;
  }
}

export function readDaemonJson(home: string): DaemonJson | undefined {
  const p = daemonPaths(home).daemonJson;
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as DaemonJson;
  } catch {
    return undefined;
  }
}

/** Locates the built UI (packages/ui/dist) relative to this package, if present. */
/**
 * Where the built UI is, in both layouts this code runs in.
 *
 * Published, everything is one bundled script with `ui/` beside it. In the workspace the daemon
 * runs from its own `dist/` (or `src/`) and the UI is a sibling package. The bundle's own layout
 * is checked first: in a workspace *both* resolve, and if the sibling wins there the published
 * arrangement is never exercised until a user hits a 404 that no test would have caught.
 */
export function defaultUiDist(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, 'ui'),
    join(here, '..', 'ui'),
    join(here, '..', '..', 'ui', 'dist'),
    join(here, '..', '..', '..', 'ui', 'dist'),
  ]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return undefined;
}

export async function startDaemon(overrides: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const runtimeVersion = overrides.version ?? VERSION;
  const config = resolveDaemonConfig(overrides);
  const paths = daemonPaths(config.home);
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.spoolDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.hooksDir, { recursive: true, mode: 0o700 });
  // mkdir's mode applies only on creation. Repair permissive directories from older installs on
  // every start before any token, hook payload or session record is written beneath them.
  chmodSync(config.home, 0o700);
  chmodSync(paths.spoolDir, 0o700);
  chmodSync(paths.hooksDir, 0o700);
  const log = createLogger(config.logLevel, process.env.SALIDIUM_LOG_FILE ?? undefined);
  const providerRegistry = new ProviderRegistry(
    overrides.providerDescriptors ?? BUILT_IN_PROVIDERS,
  );
  const adapters = providerRegistry.adaptersFor(config.providers);

  const store = (overrides.storeFactory ?? createSqliteStore)(paths.db);
  /*
   * The stop is read once, here, and the environment is folded into it once, here. Everything
   * downstream is handed a single answer to "when does the explainer run", so there is no second
   * place that can decide differently — which is how the env escape and a stored preference would
   * otherwise drift apart.
   */
  const stored = readSettings(config.home, (reason) =>
    log.warn('settings invalid; optional explanations disabled', { reason }),
  );
  const envOff = configuredExplainerMode(process.env) === 'off';
  const registry = new SessionRegistry(store, {
    explainerCadence: effectiveCadence(stored.explainerCadence),
  });
  const explainerSettings = (): ExplainerSettings => {
    const usage = registry.explainerUsage();
    // Spread rather than `usage: undefined`: the field is absent when nothing was observed, and an
    // explicit undefined would serialise the same but read as a value that happens to be missing.
    return { cadence: stored.explainerCadence, envOff, ...(usage ? { usage } : {}) };
  };
  registry.onPersistError = (sessionId, err) =>
    log.warn('persist failed; will retry', { sessionId, err: String(err) });
  const tailer = new TranscriptTailer({ adapters, registry, store, log });
  const hooks = new HookIngress({
    adapters,
    registry,
    tailer,
    spoolDir: paths.spoolDir,
    userHome: config.userHome,
    log,
  });
  const git = new GitSnapshotEnricher(registry, log);
  const token = randomBytes(32).toString('hex');
  const startedAt = new Date().toISOString();

  const descriptorsById = new Map(
    providerRegistry.list().map((descriptor) => [descriptor.adapter.id, descriptor] as const),
  );
  const info = (): DaemonInfo => ({
    name: 'salidium',
    version: runtimeVersion,
    pid: process.pid,
    startedAt,
    home: config.home,
    providers: adapters.map((a) => ({
      id: a.id,
      displayName: descriptorsById.get(a.id)?.displayName ?? a.id,
      hooksInstalled: false,
      sourcesWatched: tailer.countForProvider(a.id),
    })),
  });

  let port = config.port;
  const server = createHttpServer({
    registry,
    hooks,
    token,
    port: () => port,
    uiDist: config.uiDist ?? defaultUiDist(),
    info,
    settings: {
      explainer: explainerSettings,
      setExplainerCadence: (cadence) => {
        writeSettings(config.home, { explainerCadence: cadence });
        stored.explainerCadence = cadence;
        // The environment still outranks the choice; it is the choice that was stored, not the
        // effect. A reader who unsets the variable and restarts gets the stop they picked.
        registry.setExplainerCadence(effectiveCadence(cadence));
        log.info('explainer cadence set', { cadence, inForce: effectiveCadence(cadence) });
        return explainerSettings();
      },
    },
    log,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : config.port;
  writeRelayScript(paths.hooksDir, config.home);
  const daemonJson: DaemonJson = {
    pid: process.pid,
    port,
    token,
    startedAt,
    version: runtimeVersion,
    protocolVersion: PROTOCOL_VERSION,
    storeSchemaVersion: SCHEMA_VERSION,
  };
  writeFileSync(paths.daemonJson, JSON.stringify(daemonJson, null, 2), { mode: 0o600 });
  chmodSync(paths.daemonJson, 0o600);

  if (config.gitEnrichment) git.start();
  hooks.startSpoolWatcher();
  const initialBackfill = tailer.start(config.userHome, config.historyDays);
  log.info('salidium daemon listening', {
    port,
    home: config.home,
    providers: adapters.map((a) => a.id),
  });

  // Retention is deliberately opt-in and session-granular. Run the first bounded pass only after
  // startup discovery has loaded every currently active transcript. The registry, rather than the
  // store directly, excludes all loaded coordinators and broadcasts removals to connected clients.
  const retentionSweepIntervalMs =
    overrides.retentionSweepIntervalMs ?? DEFAULT_RETENTION_SWEEP_INTERVAL_MS;
  const retentionEnabled = store.retentionPolicy() !== 'forever';
  let stopped = false;
  const applyRetention = () => {
    if (stopped || !retentionEnabled) return;
    try {
      const removed = registry.applyRetention();
      if (removed.sessions.length > 0) {
        log.info('retention sweep removed inactive sessions', {
          policy: removed.policy,
          sessions: removed.sessions.length,
          events: removed.eventCount,
          bytes: removed.bytes,
        });
      }
    } catch (err) {
      log.warn('retention sweep failed; will retry', { err: String(err) });
    }
  };
  void initialBackfill.then(applyRetention).catch((err) => {
    if (!stopped) log.warn('initial backfill failed; retention deferred', { err: String(err) });
  });
  const retentionTimer = retentionEnabled
    ? setInterval(applyRetention, retentionSweepIntervalMs)
    : undefined;
  retentionTimer?.unref();

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (retentionTimer) clearInterval(retentionTimer);
    tailer.stop();
    hooks.stop();
    git.stop();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // The UI keeps long-lived SSE connections open. `server.close()` stops new requests but waits
    // for those streams forever, which made `salidium stop` hang whenever its browser tab was
    // still open. Stop accepting first, then terminate the authenticated loopback connections.
    server.closeAllConnections();
    await closed;
    registry.close();
    store.close();
    try {
      const current = readDaemonJson(config.home);
      if (current?.pid === process.pid) unlinkSync(paths.daemonJson);
    } catch {
      /* ignore */
    }
  };
  return { config, port, token, registry, hooks, tailer, stop };
}

/**
 * The hook relay: a tiny POSIX shell script Claude Code / Codex run as an async command hook.
 * It POSTs the hook's stdin JSON to the daemon and, if the daemon is unreachable, atomically
 * publishes the unique pending payload as a ready spool file the daemon drains on its next start.
 * It always exits 0 so it can never surface an error in the agent's session.
 */
function shellQuote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Shell values must not contain newlines');
  return value.replace(/'/g, `'\\''`);
}

export function writeRelayScript(
  hooksDir: string,
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  const path = join(hooksDir, 'relay.sh');
  const relayPath =
    trustedPathEntries({ environment }).join(':') || '/usr/bin:/bin:/usr/sbin:/sbin';
  const truncatedPayload = JSON.stringify({
    [TRUNCATED_HOOK_PAYLOAD_KEY]: true,
    limitBytes: MAX_INGEST_PAYLOAD_BYTES,
  });
  const script = `#!/bin/sh
# Salidium hook relay — installed by \`salidium install-hooks\`. Safe to delete; hooks then no-op.
# Reads the hook JSON from stdin, then hands off to a detached child so the agent's process
# teardown (e.g. \`claude -p\`) can never cut the delivery short. Always exits 0.
umask 077
# Package runners prepend project-owned node_modules bins. Relay commands run only from the
# absolute, sanitized installation PATH captured when this script is written.
PATH='${shellQuote(relayPath)}'; export PATH
# Salidium's own explainer invokes a local agent CLI. That call can fire hooks like any other
# session, so without this guard the daemon would ingest its enrichment and explain the explanation.
# The variable is set only by the explainer.
[ -n "$SALIDIUM_INTERNAL" ] && exit 0
HOME_DIR='${shellQuote(home)}'
if [ "$1" = "--send" ]; then
  PROVIDER="$2"; FILE="$3"
  # Bound old/external pending files too, not just stdin captured by this version of the relay.
  PAYLOAD_SIZE=$(wc -c < "$FILE" 2>/dev/null | tr -d ' ')
  case "$PAYLOAD_SIZE" in ''|*[!0-9]*) PAYLOAD_SIZE=0;; esac
  if [ "$PAYLOAD_SIZE" -gt ${MAX_INGEST_PAYLOAD_BYTES} ]; then
    printf '%s' '${shellQuote(truncatedPayload)}' > "$FILE" 2>/dev/null || exit 0
    PAYLOAD_SIZE=$(wc -c < "$FILE" 2>/dev/null | tr -d ' ')
  fi
  DAEMON_JSON="$HOME_DIR/daemon.json"; SPOOL_DIR="$HOME_DIR/spool"; PENDING="$SPOOL_DIR/pending"
  if [ -r "$DAEMON_JSON" ]; then
    PORT=$(sed -n 's/.*"port": *\\([0-9]*\\).*/\\1/p' "$DAEMON_JSON" | head -n1)
    TOKEN=$(sed -n 's/.*"token": *"\\([0-9a-f]*\\)".*/\\1/p' "$DAEMON_JSON" | head -n1)
    if [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
      # The token travels to curl via a config on stdin, never on the command line (argv is public).
      printf 'header = "Authorization: Bearer %s"\\n' "$TOKEN" | curl -fsS -m 3 -K - -o /dev/null -X POST \\
        -H "Content-Type: application/json" --data-binary "@$FILE" "http://127.0.0.1:$PORT/hooks/$PROVIDER" \\
        && rm -f "$FILE" && exit 0
    fi
  fi
  mkdir -p "$PENDING" 2>/dev/null && chmod 700 "$SPOOL_DIR" "$PENDING" 2>/dev/null
  # Every sender owns one file. Publishing it with a same-directory rename is atomic, so a drain
  # can never observe interleaved or partially-written envelopes from concurrent hooks.
  READY="\${FILE%.json}.ready.json"
  # Keep the previous best-effort offline ceiling. Concurrent senders may overshoot it by at most
  # their individually-bounded payloads, but never corrupt one another's records.
  SIZE=0
  for ITEM in "$PENDING"/*.ready.json "$PENDING"/*.ready.json.processing; do
    [ -f "$ITEM" ] || continue
    ITEM_SIZE=$(wc -c < "$ITEM" 2>/dev/null | tr -d ' ')
    case "$ITEM_SIZE" in ''|*[!0-9]*) ITEM_SIZE=0;; esac
    SIZE=$((SIZE + ITEM_SIZE))
  done
  if [ $((SIZE + PAYLOAD_SIZE)) -le ${MAX_HOOK_DAILY_SPOOL_BYTES} ]; then
    mv "$FILE" "$READY" 2>/dev/null && exit 0
  fi
  rm -f "$FILE"
  exit 0
fi
PROVIDER="\${1:-claude-code}"
# Provider ids can contain the namespacing slash, but a slash in FILE creates an unintended
# directory and makes the hook silently discard its stdin. Tilde and underscore cannot occur in a valid
# provider id, so this is an injective, filename-safe encoding with an unambiguous separator.
PROVIDER_FILE=$(printf '%s' "$PROVIDER" | tr '/' '~')
PENDING="$HOME_DIR/spool/pending"
mkdir -p "$PENDING" 2>/dev/null && chmod 700 "$HOME_DIR/spool" "$PENDING" 2>/dev/null
FILE="$PENDING/\${PROVIDER_FILE}_$(date -u +%s)-$$-$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \\n').json"
# Read at most limit + one byte and replace an oversized record with a small valid marker. Closing
# stdin with the relay bounds work too; an attacker cannot make this hook drain an arbitrary body.
head -c ${MAX_INGEST_PAYLOAD_BYTES + 1} > "$FILE" 2>/dev/null || exit 0
PAYLOAD_SIZE=$(wc -c < "$FILE" 2>/dev/null | tr -d ' ')
case "$PAYLOAD_SIZE" in ''|*[!0-9]*) PAYLOAD_SIZE=0;; esac
if [ "$PAYLOAD_SIZE" -gt ${MAX_INGEST_PAYLOAD_BYTES} ]; then
  printf '%s' '${shellQuote(truncatedPayload)}' > "$FILE" 2>/dev/null || exit 0
fi
[ -s "$FILE" ] || { rm -f "$FILE"; exit 0; }
# Detach into a new session so the agent's teardown (which kills the hook's process group) cannot
# interrupt delivery. If detaching is unavailable the daemon still drains the pending file later.
if command -v setsid >/dev/null 2>&1; then
  setsid sh "$0" --send "$PROVIDER" "$FILE" >/dev/null 2>&1 </dev/null &
elif command -v perl >/dev/null 2>&1; then
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- sh "$0" --send "$PROVIDER" "$FILE" >/dev/null 2>&1 </dev/null &
else
  nohup sh "$0" --send "$PROVIDER" "$FILE" >/dev/null 2>&1 </dev/null &
fi
exit 0
`;
  writeFileSync(path, script, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
