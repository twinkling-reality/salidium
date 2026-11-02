import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { formatBytes } from '@salidium/core';
import {
  resumeCollection as clearCollectionPause,
  createHealthSnapshot,
  type DaemonJson,
  daemonPaths,
  defaultUiDist,
  effectiveCadence,
  evaluateLocalAlerts,
  getExplainerStatus,
  inspectBuiltInHooks,
  inspectCodexHookTrust,
  inspectQueue,
  inspectStoreLayout,
  observeCollectionStatus,
  oldestWaitingAt,
  readDaemonJson,
  readMaintenanceState,
  readSettings,
  resolveOperationalConfig,
  rotateLogFile,
  SCHEMA_VERSION,
  SqliteStore,
  validateSalidiumHistoryDays,
  pauseCollection as writeCollectionPause,
} from '@salidium/daemon';
import {
  type CollectionStatus,
  CollectionStatusSchema,
  type EffectiveOperationalConfig,
  EffectiveOperationalConfigSchema,
  type ExplainerCadence,
  type ExplainerSettings,
  ExplainerSettingsSchema,
  type OperationsOverview,
  OperationsOverviewSchema,
  PROTOCOL_VERSION,
} from '@salidium/protocol';
import { explanationMode } from '../explanationMode.ts';
import { explanationWriter } from '../explanationWriter.ts';
import type { IntegrationContext, IntegrationValidation } from '../integrations.ts';
import { providerIntegrations } from '../integrations.ts';
import { inspectMacOSService, kickstartManagedDaemon } from '../macosService.ts';
import { resolveBrowserLaunch, validateSalidiumPort } from '../runtime.ts';

const require = createRequire(import.meta.url);

export const VERSION: string = (() => {
  for (const path of ['../../package.json', '../package.json', './package.json']) {
    try {
      return (require(path) as { version: string }).version;
    } catch {
      // The published package keeps metadata above bundle/; always-on mode copies it beside us.
    }
  }
  return '0.0.0';
})();

export const userHome = homedir();
export const salidiumHome = process.env.SALIDIUM_HOME ?? join(userHome, '.salidium');

export interface ProviderObservation {
  id: 'claude-code' | 'codex';
  name: string;
  detected: boolean;
  liveHooksSupported: boolean;
  hookStatus: 'configured' | 'not-configured' | 'partial' | 'invalid' | null;
  missingEvents: string[];
  hookTrust: 'trusted' | 'untrusted' | 'modified' | 'managed' | 'unknown' | null;
  hookTrustIssue: string | null;
}

export async function observeProviders(): Promise<ProviderObservation[]> {
  const context: IntegrationContext = { userHome, salidiumHome };
  return Promise.all(
    providerIntegrations.map(async (provider) => {
      const detection = provider.detect(context);
      const inspection =
        detection.detected && provider.liveHooksSupported(context)
          ? provider.inspect(context)
          : undefined;
      const trust =
        provider.id === 'codex' && detection.detected && inspection?.status !== 'not-configured'
          ? await inspectCodexHookTrust(process.cwd(), process.env, 3_000, undefined, VERSION)
          : undefined;
      return {
        id: provider.id,
        name: provider.name,
        detected: detection.detected,
        liveHooksSupported: provider.liveHooksSupported(context),
        hookStatus: inspection?.status ?? null,
        missingEvents: [...(inspection?.missingEvents ?? [])],
        hookTrust: trust?.trust ?? null,
        hookTrustIssue: trust?.issue ?? null,
      };
    }),
  );
}

export function localRetention(): CollectionStatus['store']['retention'] {
  const db = daemonPaths(salidiumHome).db;
  if (!existsSync(db)) return null;
  try {
    const store = new SqliteStore(db, { readOnly: true });
    try {
      return store.retentionPolicy();
    } finally {
      store.close();
    }
  } catch {
    return null;
  }
}

export async function readEffectiveOperationalConfig(
  daemon: DaemonJson | undefined,
  presence: Presence,
): Promise<EffectiveOperationalConfig> {
  if (daemon && presence === 'reachable') {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/api/operations/config`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (response.ok) return EffectiveOperationalConfigSchema.parse(await response.json());
  }
  return resolveOperationalConfig(salidiumHome, {
    migrate: true,
    retentionFallback: localRetention() ?? undefined,
  });
}

export function synchronizeOfflineRetention(): void {
  const db = daemonPaths(salidiumHome).db;
  if (!existsSync(db)) return;
  const effective = resolveOperationalConfig(salidiumHome, {
    migrate: true,
    retentionFallback: localRetention() ?? undefined,
  });
  const store = new SqliteStore(db);
  try {
    if (store.retentionPolicy() !== effective.values.retention.days.value)
      store.setRetentionPolicy(effective.values.retention.days.value);
  } finally {
    store.close();
  }
}

export async function readOperationsOverview(
  daemon: DaemonJson | undefined,
  presence: Presence,
  providers: ProviderObservation[],
): Promise<OperationsOverview> {
  if (daemon && presence === 'reachable') {
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/operations`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const overview = OperationsOverviewSchema.parse(await response.json());
        overview.health.hooks = providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          detected: provider.detected,
          configuration:
            provider.hookStatus ?? (provider.detected ? 'unavailable' : 'not-configured'),
          trust: provider.id === 'codex' ? (provider.hookTrust ?? 'unknown') : 'not-applicable',
        }));
        return overview;
      }
    } catch {
      // The direct local observation below remains useful if the daemon disappeared mid-read.
    }
  }
  const config = await readEffectiveOperationalConfig(daemon, presence);
  const queue = inspectQueue(salidiumHome, { entryLimit: 1 });
  const collection = await collectionStatus(
    daemon,
    presence,
    providers.some(
      (provider) => provider.hookStatus !== null && provider.hookStatus !== 'not-configured',
    ),
    {
      files: queue.totalFiles ?? 0,
      bytes: queue.totalBytes ?? 0,
      oldestAt: oldestWaitingAt(queue),
    },
  );
  const db = daemonPaths(salidiumHome).db;
  let schemaVersion: number | null = null;
  let layoutVersion: number | null = null;
  let history: Parameters<typeof createHealthSnapshot>[0]['history'] = [];
  if (existsSync(db)) {
    try {
      const layout = inspectStoreLayout(db);
      schemaVersion = layout.schemaVersion;
      layoutVersion = layout.layoutVersion;
      const store = new SqliteStore(db, { readOnly: true });
      try {
        const cutoff = new Date(
          Date.now() - config.values.health.historyMinutes.value * 60_000,
        ).toISOString();
        history = store.healthSamples(cutoff, 17_280);
      } finally {
        store.close();
      }
    } catch {
      /* Older or damaged stores are represented as unavailable, not opened for migration here. */
    }
  }
  const health = createHealthSnapshot({
    home: salidiumHome,
    queue,
    collection,
    daemon: {
      state:
        presence === 'reachable'
          ? 'running'
          : presence === 'unresponsive'
            ? 'unresponsive'
            : 'stopped',
      pid: daemon && presence !== 'absent' ? daemon.pid : null,
      startedAt: daemon && presence !== 'absent' ? daemon.startedAt : null,
      version: daemon && presence !== 'absent' ? daemon.version : null,
    },
    hooks: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      detected: provider.detected,
      configuration: provider.hookStatus ?? (provider.detected ? 'unavailable' : 'not-configured'),
      trust: provider.id === 'codex' ? (provider.hookTrust ?? 'unknown') : 'not-applicable',
    })),
    maintenance: readMaintenanceState(salidiumHome),
    config,
    history,
    schemaVersion,
    layoutVersion,
  });
  return {
    contractVersion: 1,
    config,
    health,
    alerts: await evaluateLocalAlerts(salidiumHome, health, config),
  };
}

export function queueLabel(status: CollectionStatus): string {
  return `${status.queue.files.toLocaleString()} file${status.queue.files === 1 ? '' : 's'}, ${formatBytes(status.queue.bytes)}`;
}

export function retentionLabel(retention: CollectionStatus['store']['retention']): string {
  if (retention === null) return 'Unavailable';
  return retention === 'forever' ? 'Forever' : `${retention} days`;
}

export function collectionStatusLabel(status: CollectionStatus): string {
  if (!status.pause) return status.state === 'paused' ? 'Paused; lease unreadable' : 'Active';
  return `Paused until ${status.pause.expiresAt}`;
}

export function hookStatusLabel(status: string | null): string {
  if (status === 'configured') return 'Connected';
  if (status === 'partial') return 'Incomplete';
  if (status === 'invalid') return 'Configuration needs repair';
  return 'Not connected';
}

export function hookTrustLabel(trust: string | null): string {
  if (trust === 'trusted') return 'Approved';
  if (trust === 'managed') return 'Managed';
  if (trust === 'untrusted') return 'Approval required';
  if (trust === 'modified') return 'Changed since approval';
  return 'Unavailable';
}

export async function setCollectionState(
  action: 'pause' | 'resume',
  reason: 'manual' | 'stop' = 'manual',
): Promise<CollectionStatus> {
  const daemon = readDaemonJson(salidiumHome);
  const presence = await presenceOf(daemon);
  if (daemon && presence === 'reachable') {
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/collection`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action, reason }),
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return CollectionStatusSchema.parse(await response.json());
    } catch {
      /* The marker fallback still controls the relay if the daemon disappeared after presence. */
    }
  }
  if (action === 'pause') writeCollectionPause(salidiumHome, reason);
  else clearCollectionPause(salidiumHome);
  return collectionStatus(daemon, presence, configuredHookPresent());
}

export async function implicitlyResumeCollection(): Promise<void> {
  if (!existsSync(daemonPaths(salidiumHome).pauseFile)) return;
  const daemon = readDaemonJson(salidiumHome);
  if (daemon && (await presenceOf(daemon)) === 'reachable') {
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/collection`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'resume' }),
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      /* Fall through to the marker operation if the daemon disappeared during the request. */
    }
  }
  clearCollectionPause(salidiumHome);
}

export async function collectionStatus(
  daemon: DaemonJson | undefined,
  presence: Presence,
  anyHooksConfigured: boolean,
  queue?: CollectionStatus['queue'],
): Promise<CollectionStatus> {
  let observedPresence = presence;
  if (daemon && presence === 'reachable' && queue === undefined) {
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/collection`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return CollectionStatusSchema.parse(await response.json());
    } catch {
      /* The direct observation below still reports the queue and store file. */
    }
    observedPresence = await presenceOf(daemon);
  }
  let retention: CollectionStatus['store']['retention'] = null;
  let lastIngestAt: string | undefined;
  const db = daemonPaths(salidiumHome).db;
  if (observedPresence === 'absent' && existsSync(db)) {
    try {
      const store = new SqliteStore(db, { readOnly: true });
      try {
        retention = store.retentionPolicy();
        const latest = store.listSessions(1)[0];
        lastIngestAt = latest?.lastEventAt ?? latest?.startedAt;
      } finally {
        store.close();
      }
    } catch {
      /* Unavailable is more accurate than a default policy or timestamp. */
    }
  }
  return observeCollectionStatus({
    home: salidiumHome,
    retention,
    lastIngestAt,
    daemonReachable: observedPresence === 'reachable',
    anyHooksConfigured,
    ...(queue ? { queue } : {}),
  });
}

export function configuredHookPresent(): boolean {
  return (['claude-code', 'codex'] as const).some(
    (provider) => inspectBuiltInHooks(provider, userHome, salidiumHome).status !== 'not-configured',
  );
}

export function uiUrl(d: DaemonJson, target?: 'storage' | 'operations'): string {
  const prefix = target ? `/${target}&` : '';
  return `http://127.0.0.1:${d.port}/#${prefix}token=${d.token}`;
}

export interface ExplanationState {
  stored: ExplainerCadence;
  effective: ExplainerCadence;
  envOff: boolean;
  /** Which writer the daemon will use, when a running daemon could say. */
  writer?: string;
}

export function explanationStateFromApi(settings: ExplainerSettings): ExplanationState {
  const writer = explanationWriter(settings);
  return {
    stored: settings.cadence,
    effective: settings.envOff ? 'off' : settings.cadence,
    envOff: settings.envOff,
    ...(writer ? { writer } : {}),
  };
}

export function localExplanationState(): ExplanationState {
  const stored = readSettings(salidiumHome).explainerCadence;
  const effective = effectiveCadence(stored);
  return { stored, effective, envOff: effective !== stored };
}

export async function currentExplanationState(
  daemon: DaemonJson | undefined,
  presence: Presence,
): Promise<ExplanationState> {
  if (daemon && presence === 'reachable') {
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/api/settings/explainer`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok)
        return explanationStateFromApi(ExplainerSettingsSchema.parse(await response.json()));
    } catch {
      /* A pre-settings daemon still has the stored file as a safe local answer. */
    }
  }
  return localExplanationState();
}

export function explanationStateLabel(state: ExplanationState): string {
  const mode = explanationMode(state.effective);
  return `${mode.label}${state.envOff && state.stored !== 'off' ? ' (forced by environment)' : ''} · ${mode.detail}`;
}

export async function alive(d: DaemonJson): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${d.port}/api/info`, {
      headers: { Authorization: `Bearer ${d.token}` },
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const info = (await res.json()) as { pid?: unknown };
    return info.pid === d.pid;
  } catch {
    return false;
  }
}

/**
 * What `daemon.json` describes, as three states rather than two.
 *
 * `alive` answers one question, whether the tokened endpoint confirms this PID, and inside that
 * answer a timeout is indistinguishable from an absence. The probe allows a second; a daemon
 * importing a history does not reply inside it. So every caller that read `false` as "there is
 * nothing there" was wrong for exactly the stretch a first run occupies: `doctor` reported no
 * daemon while one was listening on the port it had just named, and the offline-maintenance guards
 * would have let a store be rewritten under a live writer.
 *
 * Signal 0 separates the two. A PID that is gone is an absence. A PID that is present and silent
 * is a daemon that has not answered yet, which is a different sentence and a different decision.
 *
 * `unresponsive` is deliberately not proof of identity: after a crash and a PID reuse it may name
 * something else entirely. Nothing signals or replaces on the strength of it. `stopDaemon` still
 * requires the tokened endpoint before it touches a process, which is why this sits beside `alive`
 * rather than replacing it.
 */
export type Presence = 'reachable' | 'unresponsive' | 'absent';

export async function presenceOf(d: DaemonJson | undefined): Promise<Presence> {
  if (!d) return 'absent';
  if (await alive(d)) return 'reachable';
  return gone(d.pid) ? 'absent' : 'unresponsive';
}

/**
 * Whether the store already has a writer that offline maintenance must not join.
 *
 * Silence counts. The question here is not who is there, it is whether this process may take the
 * store for itself, and the only safe reading of an unanswered probe is that it may not.
 */
export async function storeHasWriter(d: DaemonJson | undefined): Promise<boolean> {
  return (await presenceOf(d)) !== 'absent';
}

/**
 * Ask the running daemon to stop, and wait until its process is actually gone.
 *
 * `undefined` if there was nothing running. Otherwise the pid, whether it was safely signaled, and
 * whether it left. A PID is not identity: it is signaled only after the tokened endpoint confirms
 * that the same PID belongs to the daemon described by daemon.json.
 */
export async function stopDaemon(): Promise<
  { pid: number; exited: boolean; signaled: boolean } | undefined
> {
  const d = readDaemonJson(salidiumHome);
  if (!d || gone(d.pid)) return undefined;
  // A stale daemon.json must never turn an arbitrary live PID into a signal target. The tokened
  // endpoint identifies both the daemon secret and its PID; if either check fails, fail closed.
  if (!(await alive(d))) return { pid: d.pid, exited: false, signaled: false };
  process.kill(d.pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    if (gone(d.pid)) return { pid: d.pid, exited: true, signaled: true };
    await sleep(100);
  }
  return { pid: d.pid, exited: gone(d.pid), signaled: true };
}

/** Signal 0 checks for the process without touching it; it throws ESRCH once there is none. */
export function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export async function liveStoreWriteBlocked(action: string): Promise<boolean> {
  const daemon = readDaemonJson(salidiumHome);
  if (!(await storeHasWriter(daemon))) return false;
  process.stderr.write(
    `stop Salidium before you ${action}; offline maintenance will not migrate or rewrite a store under a running daemon\n`,
  );
  return true;
}

export async function ensureDaemon(): Promise<DaemonJson> {
  let existing = readDaemonJson(salidiumHome);
  let presence = await presenceOf(existing);
  /*
   * A present but silent daemon is usually a busy one, and the probe's second is shorter than a
   * large import. Waiting briefly is what stops a first run from spawning a replacement into the
   * port the busy daemon is already holding, which surfaced as `daemon did not start`.
   *
   * Bounded, and it falls through unchanged when the silence outlasts it: a `daemon.json` left by
   * a crash can name a PID that now belongs to something else, and starting a fresh daemon is the
   * recovery from that. Waiting forever would turn a stale file into a product that will not run.
   */
  for (let i = 0; presence === 'unresponsive' && i < 3; i++) {
    await sleep(300);
    existing = readDaemonJson(salidiumHome);
    presence = await presenceOf(existing);
  }
  if (existing && presence === 'reachable') {
    const runtimeCompatible =
      existing.version === VERSION &&
      existing.protocolVersion === PROTOCOL_VERSION &&
      existing.storeSchemaVersion === SCHEMA_VERSION;
    if (runtimeCompatible) return existing;
    const service = inspectMacOSService({ home: salidiumHome, userHome });
    if (
      service.installed &&
      service.enabled &&
      service.installedVersion !== null &&
      service.installedVersion !== VERSION
    )
      throw new Error(
        `the always-on runtime is ${service.installedVersion}, but this CLI is ${VERSION}; run \`salidium service install\` to update it before restarting`,
      );
    const oldVersion = existing.version || 'unknown';
    const ordering = compareSemver(oldVersion, VERSION);
    if (ordering === undefined)
      throw new Error(
        `daemon version ${oldVersion} cannot be compared with this CLI (${VERSION}); run \`npx salidium@latest restart\``,
      );
    if (ordering > 0)
      throw new Error(
        `daemon ${oldVersion} is newer than this CLI (${VERSION}); run \`npx salidium@latest\``,
      );
    const stopped = await stopDaemon();
    if (!stopped?.signaled)
      throw new Error(
        `daemon ${oldVersion} is older than this CLI (${VERSION}) and could not be authenticated for restart`,
      );
    if (!stopped.exited)
      throw new Error(
        `daemon ${oldVersion} is older than this CLI (${VERSION}) and did not stop; run \`salidium restart\``,
      );
    const reason =
      oldVersion !== VERSION
        ? `${oldVersion} to ${VERSION}`
        : `runtime protocol ${existing.protocolVersion ?? 'unknown'} / store ${existing.storeSchemaVersion ?? 'unknown'} to ${PROTOCOL_VERSION} / ${SCHEMA_VERSION}`;
    process.stdout.write(`updating daemon ${reason}\n`);
  }
  validateDaemonEnvironment();
  const managed = kickstartManagedDaemon({ home: salidiumHome, userHome, version: VERSION });
  if (managed.kind === 'failed') throw new Error(managed.message);
  if (managed.kind === 'started') {
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      const launched = readDaemonJson(salidiumHome);
      if (launched && (await alive(launched))) return launched;
    }
    throw new Error(
      `the supervised daemon did not become ready; see ${daemonPaths(salidiumHome).startupLogFile}`,
    );
  }
  const script = process.argv[1] ?? '';
  const paths = daemonPaths(salidiumHome);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  // The inherited descriptor is only a small launcher/crash stream. Structured daemon logging
  // owns daemon.log separately and can rotate/reopen it safely without renaming under this fd.
  rotateLogFile(paths.startupLogFile, 256 * 1024, 1);
  const log = openSync(paths.startupLogFile, 'a', 0o600);
  chmodSync(paths.startupLogFile, 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [...process.execArgv, script, 'daemon'], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, SALIDIUM_LOG_FILE: paths.logFile },
    });
  } finally {
    closeSync(log);
  }
  let childFailure: string | undefined;
  child.once('error', (error) => {
    childFailure = error.message;
  });
  child.once('exit', (code, signal) => {
    childFailure = `exited ${code === null ? `from signal ${signal ?? 'unknown'}` : `with code ${code}`}`;
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (childFailure)
      throw new Error(
        `daemon ${childFailure} before it became ready: ${startupFailureReason(paths.startupLogFile)}`,
      );
    const d = readDaemonJson(salidiumHome);
    if (d && d.pid === child.pid && (await alive(d))) return d;
  }
  throw new Error(`daemon did not start: ${startupFailureReason(paths.startupLogFile)}`);
}

/*
 * Why the daemon would not start, in the words it used, rather than the path to where it said them.
 *
 * A start that fails writes the reason to the startup log and then this reported only the file
 * name, so the whole message was an instruction to go and read something. In the menu bar that is
 * worse than useless: the alert cannot be copied out easily and the reader is holding a modal that
 * names an absolute path in a state directory. The last line of that log is the reason, and it is
 * one line, so it belongs in the sentence. The path stays for the cases the last line does not
 * settle.
 */
export function startupFailureReason(logFile: string): string {
  try {
    const lines = readFileSync(logFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const last = lines.at(-1);
    if (last) return `${last.slice(0, 200)} (see ${logFile})`;
  } catch {
    /* An unreadable or absent log is itself unremarkable; the path is still worth naming. */
  }
  return `see ${logFile}`;
}

/** Compares ordinary semver versions without adding a runtime dependency to the bundled CLI. */
export function compareSemver(left: string, right: string): -1 | 0 | 1 | undefined {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match?.[1] || !match[2] || !match[3]) return undefined;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split('.'),
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] === b.core[i]) continue;
    return (a.core[i] ?? 0) < (b.core[i] ?? 0) ? -1 : 1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const av = a.prerelease[i];
    const bv = b.prerelease[i];
    if (av === bv) continue;
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const an = /^\d+$/.test(av) ? Number(av) : undefined;
    const bn = /^\d+$/.test(bv) ? Number(bv) : undefined;
    if (an !== undefined && bn !== undefined) return an < bn ? -1 : 1;
    if (an !== undefined) return -1;
    if (bn !== undefined) return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

export function openBrowser(url: string): void {
  const launch = resolveBrowserLaunch(url);
  if (!launch) return;
  try {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: 'ignore',
      env: launch.environment,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* printing the URL is enough */
  }
}

export function essentialValidations(): IntegrationValidation[] {
  const validations: IntegrationValidation[] = [];
  const [major] = process.versions.node.split('.').map(Number);
  validations.push({
    level: major !== undefined && major >= 24 ? 'ok' : 'attention',
    message:
      major !== undefined && major >= 24
        ? `Node ${process.versions.node} is supported`
        : `Node ${process.versions.node} needs version 24 or newer`,
  });

  try {
    validateSalidiumHistoryDays(process.env.SALIDIUM_HISTORY_DAYS);
  } catch (error) {
    validations.push({
      level: 'attention',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const explainer = getExplainerStatus();
  if (explainer.mode === 'invalid') {
    validations.push({
      level: 'attention',
      message: 'SALIDIUM_EXPLAINER must be auto, claude, codex, or off',
    });
  } else if (explainer.mode === 'off') {
    validations.push({ level: 'info', message: 'Visual explanations are off' });
  } else if (explainer.available.length === 0) {
    validations.push({
      level: 'info',
      message: 'Visual explanations are unavailable until a claude or codex command is on PATH',
    });
  } else {
    validations.push({ level: 'ok', message: `Visual explainer is available` });
  }

  validations.push({
    level: defaultUiDist() ? 'ok' : 'attention',
    message: defaultUiDist() ? 'Interface build is available' : 'Interface build is missing',
  });
  return validations;
}

export function validateDaemonEnvironment(): void {
  validateSalidiumPort(process.env.SALIDIUM_PORT);
  validateSalidiumHistoryDays(process.env.SALIDIUM_HISTORY_DAYS);
}
