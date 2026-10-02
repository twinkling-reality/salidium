#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statfsSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { arch, homedir, platform, release } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parentPort } from 'node:worker_threads';
import { formatBytes, basename as pathBasename } from '@salidium/core';
import {
  acknowledgeLocalAlert,
  resumeCollection as clearCollectionPause,
  collectionStatusFromHealth,
  createDiagnosticBundle,
  createHealthSnapshot,
  type DaemonJson,
  DEFAULT_PORT,
  daemonPaths,
  defaultUiDist,
  diagnosticManifest,
  effectiveCadence,
  evaluateLocalAlerts,
  getExplainerStatus,
  inspectBuiltInHooks,
  inspectCodexHookTrust,
  inspectQueue,
  inspectStoreLayout,
  isOperationalConfigKey,
  OPERATIONAL_CONFIG_KEYS,
  observeCollectionStatus,
  oldestWaitingAt,
  readDaemonJson,
  readMaintenanceState,
  readSettings,
  resetOperationalConfig,
  resolveOperationalConfig,
  rotateLogFile,
  runRetentionCompactionMaintenance,
  runStorageOptimizationMaintenance,
  SCHEMA_VERSION,
  SqliteStore,
  setOperationalConfigValue,
  startDaemon,
  storageOptimizationPreflight,
  validateSalidiumHistoryDays,
  pauseCollection as writeCollectionPause,
  writeSettings,
} from '@salidium/daemon';
import {
  type CollectionStatus,
  CollectionStatusSchema,
  type DaemonInfo,
  type EffectiveOperationalConfig,
  EffectiveOperationalConfigSchema,
  type ExplainerCadence,
  type ExplainerSettings,
  ExplainerSettingsSchema,
  type LocalAlertState,
  type OperationsHealthSnapshot,
  type OperationsOverview,
  OperationsOverviewSchema,
  PROTOCOL_VERSION,
  type QueueInspection,
} from '@salidium/protocol';
import { auditClaims, renderAudit } from './auditClaims.ts';
import { runConsumerCommand } from './consumerCommand.ts';
import { explanationMode, parseExplanationMode } from './explanationMode.ts';
import { explanationWriter } from './explanationWriter.ts';
import type { IntegrationContext, IntegrationValidation } from './integrations.ts';
import { integrationById, providerIntegrations } from './integrations.ts';
import {
  activateMacOSService,
  describeMacOSService,
  disableMacOSService,
  inspectMacOSService,
  kickstartManagedDaemon,
  prepareMacOSService,
  uninstallMacOSService,
} from './macosService.ts';
import { runFirstRunOnboarding } from './onboarding.ts';
import { clearsPauseOnRun } from './pauseOnRun.ts';
import { renderReport } from './render.ts';
import { resolveBrowserLaunch, validateSalidiumPort } from './runtime.ts';
import { providerDisplayName, sessionSearchQuery } from './showSession.ts';
import {
  consentKeyResult,
  selectionKeyResult,
  supportsTerminalColor,
  TerminalUi,
} from './terminalUi.ts';

const HELP = `salidium: turn a Claude Code or Codex run into a visual report, not a transcript to scroll.

Usage:
  salidium                      Connect detected agents on first run, then start and open Salidium
  salidium start                Start the daemon in the background
  salidium daemon               Run the daemon in the foreground
  salidium stop                 Stop the background daemon
  salidium pause                Pause all new collection for up to 24 hours
  salidium resume               Resume collection immediately
  salidium restart              Stop it, start it again, and open the UI (--no-open to skip)
  salidium status               Show one operational snapshot; exact values may be unavailable
  salidium status --watch       Refresh health and clearly label derived rates
  salidium service install      Start at login with a native macOS menu-bar control
  salidium service status       Show whether the login service and menu bar are loaded
  salidium service enable       Re-enable a previously installed always-on service
  salidium service disable      Stop and turn off always-on mode without deleting data
  salidium service uninstall    Remove the login service and menu bar; keep all data
  salidium config show          Show effective settings and whether each came from defaults,
                                the stored configuration, or the environment
  salidium config set KEY VALUE Set one supported policy value
  salidium config reset [KEY]   Reset one setting, or every stored setting, to inheritance
  salidium maintenance queue    Inspect queued file metadata without reading payloads
  salidium maintenance drain    Drain toward empty through bounded daemon passes (default 30 s)
  salidium maintenance optimize Preview or run coordinated verified storage optimization
  salidium maintenance status   Show durable maintenance completion, failure, or recovery state
  salidium maintenance acknowledge ALERT_ID
                                Acknowledge one local alert episode until it recovers
  salidium explanations         Show whether written explanations can call a model
  salidium explanations off|when-done|each-reply
                                Change model-call frequency without stopping local reports
  salidium open                 Open the UI in your browser
  salidium show [session]       Print the report for a session as text (default: most recent)
                                --detail=summary|detail|source, --width=N
  salidium install-hooks [claude-code|codex|all]    Register Salidium hooks (default: all present)
  salidium uninstall-hooks [claude-code|codex|all]
  salidium doctor               Check the local setup and collection health
  salidium doctor --bundle      Preview and write a redacted local diagnostic bundle
                                --dry-run previews only; --output=PATH selects the destination
  salidium --version            Print the installed version
  salidium reingest [session]   Re-read session files (--all, --status, --verbose)
  salidium retention            Show the current history policy and a cleanup preview
  salidium retention forever|30|90|365
                                Set automatic session retention (default: forever)
  salidium retention apply      Apply one cleanup batch now (daemon must be stopped)
  salidium retention compact    Return reusable SQLite pages to the OS (daemon must be stopped)
  salidium storage              Show the lossless storage layout and page size
  salidium storage composition  Measure what is using the space, by part and by project
  salidium storage optimize     Coordinate, copy, verify, and install the compact layout
  salidium pin [session]        Exempt a session from automatic retention
  salidium unpin [session]      Remove the retention exemption
  salidium forget [session]     Immediately forget one whole session (--yes)
  salidium consumer create LABEL
                                Create a read-only credential a local tool uses to read reports;
                                the token is printed once
  salidium consumer list        Show consumer credentials (never their secrets)
  salidium consumer revoke ID   Revoke one consumer credential immediately
  salidium audit-claims         Measure the claim classifier against every session in your store
                                --sample=N (default 8), --only=rule, --seed=N, --limit=N, --json

First-run options:
  --yes, -y                    Approve detected provider configuration without a prompt
  --no-open                    Start Salidium without opening a browser

Environment:
  SALIDIUM_HOME          State directory (default ~/.salidium)
  SALIDIUM_PORT          Loopback port (default ${DEFAULT_PORT})
  SALIDIUM_HISTORY_DAYS  Whole days of transcript history to import, 0 or greater (default 7)
  SALIDIUM_NO_GIT=1      Disable read-only git snapshots and changed-file locations
  SALIDIUM_EXPLAINER     Visual explainer: auto, claude, codex, ollama, or off (default auto)
  SALIDIUM_EXPLAIN_MODEL Optional model override for the selected explainer

Native Windows imports transcript history but does not install the POSIX live-hook relay.
Ordinary commands resume an expired or manual pause. pause, stop, service commands, and coordinated
storage optimize do not; resume changes collection state explicitly. Add --no-resume to any command
to leave a pause in place, for a caller that has already seen the daemon answer and so cannot be
recovering a marker its dead owner left behind.
`;

const require = createRequire(import.meta.url);
const VERSION: string = (() => {
  for (const path of ['../package.json', './package.json']) {
    try {
      return (require(path) as { version: string }).version;
    } catch {
      // The published package keeps metadata above bundle/; always-on mode copies it beside us.
    }
  }
  return '0.0.0';
})();

const userHome = homedir();
const salidiumHome = process.env.SALIDIUM_HOME ?? join(userHome, '.salidium');

async function main(argv: string[]): Promise<number> {
  const assumeYes = argv.includes('--yes') || argv.includes('-y');
  const noOpen = argv.includes('--no-open');
  const jsonOutput = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const positional = argv.filter(
    (value) => !['--yes', '-y', '--no-open', '--json', '--quiet', '--no-resume'].includes(value),
  );
  const [cmd = 'up', arg, ...args] = positional;
  if (clearsPauseOnRun(cmd, arg, argv)) await implicitlyResumeCollection();
  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'daemon': {
      validateDaemonEnvironment();
      const handle = await startDaemon({ home: salidiumHome, version: VERSION });
      const shutdown = () => void handle.stop().then(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.stdout.write(
        `salidium daemon on http://127.0.0.1:${handle.port} (home ${handle.config.home})\n`,
      );
      await new Promise(() => {});
      return 0;
    }
    // Private worker entrypoint. The daemon runs this same reviewed bundle on a separate event
    // loop so archive reconstruction can never occupy the loop serving health and control.
    case '__usage-backfill': {
      if (!arg || !resolve(arg).startsWith(`${resolve(salidiumHome)}${sep}`))
        throw new Error('usage backfill store must be inside the Salidium state directory');
      const store = new SqliteStore(resolve(arg), { concurrentWriter: true });
      try {
        for (;;) {
          const progress = store.advanceUsageBackfill(100);
          if (progress.complete) return 0;
          await sleep(10);
        }
      } finally {
        store.close();
      }
    }
    /*
     * The other private worker entrypoint. Measuring what the store is made of reads the header of
     * every stored event, which is ten seconds on a three gigabyte store, and `node:sqlite` is
     * synchronous: run on the daemon's loop that is ten seconds of hooks going unanswered and
     * spooling to disk. It runs here instead, on its own event loop and its own connection, and
     * posts one message back.
     */
    case '__storage-composition': {
      if (!arg || !resolve(arg).startsWith(`${resolve(salidiumHome)}${sep}`))
        throw new Error('storage composition store must be inside the Salidium state directory');
      const store = new SqliteStore(resolve(arg), { concurrentWriter: true });
      try {
        parentPort?.postMessage(store.storageComposition());
        return 0;
      } finally {
        store.close();
      }
    }
    case 'start': {
      const running = await ensureDaemon();
      const explanations = await currentExplanationState(running, 'reachable');
      process.stdout.write(
        `daemon running on http://127.0.0.1:${running.port} (pid ${running.pid})\nExplanations: ${explanationStateLabel(explanations)}\n`,
      );
      return 0;
    }
    case 'up': {
      const context: IntegrationContext = { userHome, salidiumHome };
      const color = supportsTerminalColor(Boolean(process.stdout.isTTY));
      const firstRun = !existsSync(daemonPaths(salidiumHome).db);
      const onboarding = await runFirstRunOnboarding(
        context,
        {
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          color,
          confirm: (question) => confirmSetup(question, color),
          select: (question, options, selectedIndex) =>
            selectTerminalOption(question, options, selectedIndex, color),
          write: (text) => process.stdout.write(text),
        },
        {
          assumeYes,
          firstRun,
        },
      );
      if (onboarding.explainerCadence) {
        writeSettings(salidiumHome, {
          ...readSettings(salidiumHome),
          explainerCadence: onboarding.explainerCadence,
        });
      }
      const systemAttention = essentialValidations().filter(
        (validation) => validation.level === 'attention',
      );
      if (systemAttention.length > 0 && onboarding.presented) {
        const ui = new TerminalUi(color);
        process.stdout.write(ui.section('System'));
        for (const validation of systemAttention.slice(0, -1))
          process.stdout.write(ui.item('!', validation.message, 'warn'));
        const last = systemAttention.at(-1);
        if (last) process.stdout.write(ui.close('!', last.message, 'warn'));
      } else {
        for (const validation of systemAttention)
          process.stdout.write(`Needs attention: ${validation.message}.\n`);
      }
      const running = await ensureDaemon();
      if (!noOpen && process.stdout.isTTY) openBrowser(uiUrl(running));
      const url = uiUrl(running);
      const ui = new TerminalUi(color);
      const state = await currentExplanationState(running, 'reachable');
      if (onboarding.presented) {
        process.stdout.write(
          ui.open(url, !noOpen && Boolean(process.stdout.isTTY), Boolean(firstRun)),
        );
      } else if (process.stdout.isTTY) {
        const mode = explanationMode(state.effective);
        process.stdout.write(ui.running(mode.label, mode.detail));
        process.stdout.write(ui.open(url, !noOpen));
      } else {
        process.stdout.write(`${url}\n`);
      }
      return 0;
    }
    case 'open': {
      const running = await ensureDaemon();
      openBrowser(uiUrl(running));
      return 0;
    }
    case 'show': {
      const d = readDaemonJson(salidiumHome);
      const presence = await presenceOf(d);
      if (!d || presence !== 'reachable') {
        process.stderr.write(
          d && presence === 'unresponsive'
            ? `daemon pid ${d.pid} is running but did not answer; try again once it has caught up\n`
            : 'daemon is not running; start it with `salidium start`\n',
        );
        return 1;
      }
      const flag = (name: string) =>
        argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? undefined;
      const api = async <T>(path: string): Promise<T> => {
        const res = await fetch(`http://127.0.0.1:${d.port}${path}`, {
          headers: { Authorization: `Bearer ${d.token}` },
        });
        if (!res.ok) throw new Error(`${path}: ${res.status}`);
        return (await res.json()) as T;
      };
      type Summary = {
        id: string;
        cwd: string;
        provider: string;
        status: string;
        lastEventAt?: string;
      };
      /** `/api/sessions/search`: the newest matching rows, and what they are a window of. */
      type SessionList = { sessions: Summary[]; matched: number; total: number };
      const wanted = arg && !arg.startsWith('--') ? arg : undefined;
      /*
       * Matching is the daemon's job, not this process's. `/api/sessions` is one capped page, so a
       * filter applied here could only ever pick from that newest window and would miss an older
       * session that still exists in the store.
       *
       * The daemon matches every typed word against the row's title, repo root, cwd and provider
       * session id. A whole session id is `provider:providerSessionId` and appears in none of those
       * four, so the provider prefix is dropped from the query and put back by the exact-id
       * preference below: that is what keeps an id pasted out of the UI working.
       */
      const query = sessionSearchQuery(wanted);
      const search = async (): Promise<SessionList> => {
        try {
          return await api<SessionList>(`/api/sessions/search?q=${encodeURIComponent(query)}`);
        } catch (err) {
          // A daemon started before this route existed answers 404, and the tempting fallback —
          // filter the capped page — is the bug this replaced: it would answer from the newest 500
          // rows again and not say it had. Name the cause instead.
          if (err instanceof Error && err.message.endsWith(': 404'))
            throw new Error('this daemon is older than the CLI; run `salidium restart`');
          throw err;
        }
      };
      const list = wanted ? await search() : undefined;
      const sessions = list ? list.sessions : await api<Summary[]>('/api/sessions');
      /*
       * An exact id wins wherever it sits in the result; otherwise the newest match, the daemon
       * having ordered them by recency. The old single pass took the newest row satisfying any of
       * its three tests, so a fresher path match could outrank the id actually typed.
       */
      const picked = wanted
        ? (sessions.find((s) => s.id === wanted) ??
          sessions.find((s) => s.id.endsWith(wanted)) ??
          sessions[0])
        : sessions[0];
      if (!picked) {
        // `total` is counted over the store by the same predicate the query used, so this says how
        // much was actually looked at rather than how much happened to be on a page.
        process.stderr.write(
          wanted
            ? `no session matching ${wanted}; ${list?.total ?? 0} searched by name, repo, path and id\n`
            : 'no sessions yet\n',
        );
        return 1;
      }
      const view = await api<never>(`/api/sessions/${encodeURIComponent(picked.id)}/view`);
      const daemonInfo = await api<DaemonInfo>('/api/info');
      const levels: Record<string, 0 | 1 | 2> = { summary: 0, detail: 1, source: 2 };
      process.stdout.write(
        renderReport(view, {
          width: flag('width') ? Number(flag('width')) : undefined,
          detail: levels[flag('detail') ?? 'detail'] ?? 1,
          project: pathBasename(picked.cwd),
          agent: providerDisplayName(picked.provider, daemonInfo.providers),
          status: picked.status,
          cwd: picked.cwd,
        }),
      );
      return 0;
    }
    case 'stop': {
      const collection = await setCollectionState('pause', 'stop');
      const stopped = await stopDaemon();
      process.stdout.write(
        stopped === undefined
          ? 'daemon is not running\n'
          : !stopped.signaled
            ? `daemon pid ${stopped.pid} was not signaled; stale PID or unresponsive daemon\n`
            : stopped.exited
              ? `stopped daemon (pid ${stopped.pid})\n`
              : `daemon (pid ${stopped.pid}) was asked to stop and is still running\n`,
      );
      const storedMode = readSettings(salidiumHome).explainerCadence;
      if (storedMode !== 'off') {
        process.stdout.write(
          `Explanations remain set to ${explanationMode(storedMode).label} for the next start. Disable them with: salidium explanations off\n`,
        );
      }
      process.stdout.write(
        `Collection is paused until ${collection.pause?.expiresAt ?? 'the marker is cleared'}. Observed queue at pause: ${queueLabel(collection)}. New hook and transcript observations will not be collected while paused.\n`,
      );
      return stopped === undefined || (stopped.signaled && stopped.exited) ? 0 : 1;
    }
    case 'pause': {
      const status = await setCollectionState('pause', 'manual');
      if (!quiet) {
        if (jsonOutput) process.stdout.write(`${JSON.stringify(status)}\n`);
        else
          process.stdout.write(
            `Collection paused until ${status.pause?.expiresAt ?? 'the pause is cleared'}. Observed queue now: ${queueLabel(status)}.\n`,
          );
      }
      return 0;
    }
    case 'resume': {
      const status = await setCollectionState('resume');
      if (!quiet) {
        if (jsonOutput) process.stdout.write(`${JSON.stringify(status)}\n`);
        else process.stdout.write(`Collection active. ${queueLabel(status)} queued.\n`);
      }
      return 0;
    }
    /*
     * One command, because the two-command form is what everything here tells you to type — this
     * CLI printed it after `reingest`, and the docs printed it twice.
     *
     * It waits for the old process to be gone before starting the next, which the shell cannot do
     * for you: `stop` only sends SIGTERM, so `stop && start` races the old daemon's shutdown
     * against the new one's `alive` check, and a lost race hands you the dying daemon and reports
     * it as running. It is waited on because another process's startup cost is not a safe
     * synchronization mechanism, and here the wait is free.
     */
    case 'restart': {
      const stopped = await stopDaemon();
      if (stopped && !stopped.signaled) {
        process.stderr.write(
          `daemon pid ${stopped.pid} was not signaled; stale PID or unresponsive daemon; not starting a replacement\n`,
        );
        return 1;
      }
      if (stopped && !stopped.exited) {
        process.stderr.write(
          `daemon (pid ${stopped.pid}) did not stop; not starting another on the same port\n`,
        );
        return 1;
      }
      if (stopped) process.stdout.write(`stopped daemon (pid ${stopped.pid})\n`);
      const running = await ensureDaemon();
      /*
       * And it opens the UI, because a restart is the one thing that guarantees the page you have
       * is broken. The token is rotated on every start, so the tab you were reading signs itself
       * out the moment this command runs — leaving you to fish the new one out of `daemon.json`.
       * `restart` is `stop` followed by what bare `salidium` does, which is what it is asked for.
       *
       * `--no-open` for a script, which wants the daemon and not a browser window.
       */
      if (!noOpen) openBrowser(uiUrl(running));
      const explanations = await currentExplanationState(running, 'reachable');
      process.stdout.write(
        `daemon running (pid ${running.pid})\nExplanations: ${explanationStateLabel(explanations)}\n${uiUrl(running)}\n`,
      );
      return 0;
    }
    case 'config': {
      const action = arg ?? 'show';
      const d = readDaemonJson(salidiumHome);
      const presence = await presenceOf(d);
      if (action === 'show') {
        const effective = await readEffectiveOperationalConfig(d, presence);
        if (!quiet) {
          if (jsonOutput) process.stdout.write(`${JSON.stringify(effective)}\n`);
          else renderEffectiveConfig(effective);
        }
        return 0;
      }
      if (action !== 'set' && action !== 'reset') {
        process.stderr.write('config accepts show, set, or reset\n');
        return 2;
      }
      if (presence === 'unresponsive') {
        process.stderr.write(
          'the daemon is running but not answering; configuration was not changed\n',
        );
        return 1;
      }
      const key = args[0];
      if (action === 'set' && (!key || !isOperationalConfigKey(key) || args[1] === undefined)) {
        process.stderr.write(
          `usage: salidium config set KEY VALUE\nSupported keys: ${OPERATIONAL_CONFIG_KEYS.join(', ')}\n`,
        );
        return 2;
      }
      if (action === 'reset' && key && !isOperationalConfigKey(key)) {
        process.stderr.write(`unknown configuration key: ${key}\n`);
        return 2;
      }
      const configKey = key && isOperationalConfigKey(key) ? key : undefined;
      let effective: EffectiveOperationalConfig;
      try {
        const current =
          d && presence === 'reachable'
            ? await readEffectiveOperationalConfig(d, presence)
            : undefined;
        if (action === 'set') {
          const rawValue = args[1];
          if (!configKey || rawValue === undefined)
            throw new Error('configuration set request did not contain a supported key and value');
          const parsedValue = parseConfigValue(configKey, rawValue);
          if (d && presence === 'reachable' && current) {
            const response = await fetch(`http://127.0.0.1:${d.port}/api/operations/config`, {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${d.token}`,
                'Content-Type': 'application/json',
                'If-Match': String(current.revision),
              },
              body: JSON.stringify(configPatch(configKey, parsedValue)),
              signal: AbortSignal.timeout(2_000),
            });
            if (!response.ok) throw new Error(`daemon refused configuration (${response.status})`);
            effective = (await response.json()) as EffectiveOperationalConfig;
          } else {
            setOperationalConfigValue(salidiumHome, configKey, parsedValue);
            synchronizeOfflineRetention();
            effective = await readEffectiveOperationalConfig(d, presence);
          }
        } else if (d && presence === 'reachable' && current) {
          const query = key ? `?key=${encodeURIComponent(key)}` : '';
          const response = await fetch(`http://127.0.0.1:${d.port}/api/operations/config${query}`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${d.token}`,
              'If-Match': String(current.revision),
            },
            signal: AbortSignal.timeout(2_000),
          });
          if (!response.ok) throw new Error(`daemon refused configuration (${response.status})`);
          effective = (await response.json()) as EffectiveOperationalConfig;
        } else {
          resetOperationalConfig(salidiumHome, configKey);
          synchronizeOfflineRetention();
          effective = await readEffectiveOperationalConfig(d, presence);
        }
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
      }
      if (!quiet) {
        if (jsonOutput) process.stdout.write(`${JSON.stringify(effective)}\n`);
        else {
          process.stdout.write('Configuration saved.\n');
          renderEffectiveConfig(effective);
        }
      }
      return effective.restartRequired.length > 0 ? 3 : 0;
    }
    case 'maintenance':
      return maintenanceCommand(arg, args, { json: jsonOutput, quiet });
    case 'service':
      return serviceCommand(arg, { json: jsonOutput, quiet });
    case 'status': {
      const interval = argv.find((value) => value.startsWith('--interval='))?.slice(11);
      return statusCommand({
        json: jsonOutput,
        quiet,
        watch: argv.includes('--watch'),
        intervalSeconds: interval === undefined ? 2 : Number(interval),
      });
    }
    case 'explanations': {
      const d = readDaemonJson(salidiumHome);
      const presence = await presenceOf(d);
      if (!arg) {
        const state = await currentExplanationState(d, presence);
        const mode = explanationMode(state.effective);
        process.stdout.write(
          `Explanations: ${explanationStateLabel(state)}\n${state.writer ? `Written by: ${state.writer}\n` : ''}${mode.detail}. Reports, evidence, and quantities stay local.\nChange with: salidium explanations off|when-done|each-reply\n`,
        );
        return 0;
      }
      const cadence = parseExplanationMode(arg);
      if (!cadence) {
        process.stderr.write(
          'Choose off, when-done, or each-reply. Example: salidium explanations off\n',
        );
        return 2;
      }
      if (presence === 'unresponsive') {
        process.stderr.write(
          `daemon pid ${d?.pid ?? 'unknown'} is running but did not answer; the setting was not changed\n`,
        );
        return 1;
      }

      let state: ExplanationState;
      if (d && presence === 'reachable') {
        try {
          const response = await fetch(`http://127.0.0.1:${d.port}/api/settings/explainer`, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${d.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ cadence }),
            signal: AbortSignal.timeout(2_000),
          });
          if (!response.ok) {
            process.stderr.write(`daemon refused the explanation setting (${response.status})\n`);
            return 1;
          }
          const settings = ExplainerSettingsSchema.parse(await response.json());
          state = explanationStateFromApi(settings);
        } catch {
          process.stderr.write(
            'daemon stopped answering; the explanation setting was not changed\n',
          );
          return 1;
        }
      } else {
        writeSettings(salidiumHome, {
          ...readSettings(salidiumHome),
          explainerCadence: cadence,
        });
        state = localExplanationState();
      }
      const chosen = explanationMode(cadence);
      process.stdout.write(`Saved: ${chosen.label} · ${chosen.detail}\n`);
      if (state.effective !== cadence)
        process.stdout.write(
          'Local only is active because the daemon environment prevents model calls.\n',
        );
      return 0;
    }
    case 'install-hooks':
    case 'uninstall-hooks': {
      const remove = cmd === 'uninstall-hooks';
      const context: IntegrationContext = { userHome, salidiumHome };
      const explicit = arg && arg !== 'all' ? integrationById(arg) : undefined;
      if (arg && arg !== 'all' && !explicit) {
        process.stderr.write(`unknown provider: ${arg}\n`);
        return 2;
      }
      let targets = explicit
        ? [explicit]
        : providerIntegrations.filter((provider) => provider.detect(context).detected);
      if (targets.length === 0) {
        process.stdout.write('no supported coding agents detected\n');
        return 1;
      }
      if (!remove) {
        const unavailable = targets.filter((provider) => !provider.liveHooksSupported(context));
        for (const provider of unavailable) {
          process.stdout.write(
            `${provider.name}: skipped. Native Windows uses transcript history only; POSIX live hooks were not installed\n`,
          );
        }
        targets = targets.filter((provider) => provider.liveHooksSupported(context));
        if (targets.length === 0) return 1;
      }
      for (const provider of targets) {
        const r = remove ? provider.remove(context) : provider.install(context);
        process.stdout.write(
          `${provider.name}: ${remove ? 'removed' : 'connected'}${r.changed ? '' : ' (no change)'} → ${r.settingsPath}\n`,
        );
        if (r.note) process.stdout.write(`  note: ${r.note}\n`);
        if (!remove) {
          for (const validation of provider.validate(context)) {
            if (validation.level === 'attention')
              process.stdout.write(`  needs attention: ${validation.message}\n`);
            // Someone who typed `install-hooks codex` is asking about the hooks, so the standing
            // caveat belongs in the answer whether or not this run changed a file.
            else if (validation.level === 'info')
              process.stdout.write(`  note: ${validation.message}\n`);
          }
        }
      }
      return 0;
    }
    case 'audit-claims': {
      /*
       * Reads the store directly rather than through the API. The audit has to see everything:
       * the API's session list is capped and filtered for a reader, and an audit that silently
       * measures the newest few hundred sessions reports a number nobody can act on. Opened
       * read-only alongside a running daemon, which WAL makes safe.
       */
      const { db } = daemonPaths(salidiumHome);
      if (!existsSync(db)) {
        process.stderr.write(`no store at ${db}; run salidium once to create one\n`);
        return 1;
      }
      const flag = (name: string) =>
        argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? undefined;
      const num = (name: string, fallback: number) => {
        const v = flag(name);
        const n = v === undefined ? Number.NaN : Number(v);
        return Number.isFinite(n) ? n : fallback;
      };
      const opts = {
        sample: num('sample', 8),
        only: (flag('only') ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        seed: num('seed', 1),
        limit: num('limit', Number.MAX_SAFE_INTEGER),
        json: argv.includes('--json'),
      };
      const store = new SqliteStore(db, { readOnly: true });
      try {
        const take = function* () {
          let n = 0;
          for (const s of store.agentMessagesBySession()) {
            if (n++ >= opts.limit) return;
            yield s;
          }
        };
        process.stdout.write(renderAudit(auditClaims(take(), opts), opts));
      } finally {
        store.close();
      }
      return 0;
    }
    case 'reingest': {
      /*
       * An adapter that learns to read something new helps nobody who already has a store.
       * A finished session's file is skipped on every start — its inode and size still match the
       * cursor, which is what makes a cold start of hundreds of transcripts take milliseconds — so
       * the session keeps the thinner reading the adapter of the day produced, permanently.
       *
       * This writes durable jobs rather than deleting recovery cursors. It also includes paths
       * preserved only in event provenance when an old cursor row is missing. The next daemon
       * start processes those exact paths before its age-limited discovery pass, and a crash leaves
       * the jobs retryable. Event ids still dedupe the canonical log while fingerprint sidecars can
       * be strengthened from the newly-read raw records.
       */
      const { db } = daemonPaths(salidiumHome);
      if (!existsSync(db)) {
        process.stderr.write(`no store at ${db}\n`);
        return 1;
      }
      if (argv.includes('--status')) {
        const store = new SqliteStore(db, { readOnly: true });
        try {
          const jobs = store.reingestJobs();
          if (jobs.length === 0) {
            process.stdout.write('No re-ingestion jobs recorded.\n');
            return 0;
          }
          const statuses = ['queued', 'running', 'completed', 'missing', 'failed'] as const;
          const counts = new Map(statuses.map((status) => [status, 0]));
          for (const job of jobs) counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
          process.stdout.write(
            `Re-ingestion: ${jobs.length} jobs, ${statuses.map((status) => `${counts.get(status) ?? 0} ${status}`).join(', ')}.\n`,
          );
          const visible = argv.includes('--verbose')
            ? jobs
            : jobs.filter((job) => job.status === 'missing' || job.status === 'failed');
          for (const job of visible)
            process.stdout.write(
              `${job.status.padEnd(9)} ${job.sessionId} ${job.path} (attempts ${job.attempts}, parser ${job.parserRevision})${job.error ? `: ${job.error}` : ''}\n`,
            );
          if (!argv.includes('--verbose') && visible.length < jobs.length)
            process.stdout.write('Use --status --verbose to list every job.\n');
        } finally {
          store.close();
        }
        return 0;
      }
      if (await liveStoreWriteBlocked('queue re-ingestion')) return 2;
      const target = arg && !arg.startsWith('--') ? arg : undefined;
      if (!target && !argv.includes('--all')) {
        process.stderr.write('name a session, or pass --all to re-read every session file\n');
        return 2;
      }
      const store = new SqliteStore(db);
      let queued = 0;
      let missing = 0;
      try {
        const sources = store.reingestSources();
        const matching = target
          ? sources.filter((s) => s.sessionId === target || s.sessionId.endsWith(target))
          : sources;
        if (matching.length === 0) {
          process.stderr.write(
            target ? `no session files recorded for ${target}\n` : 'no session files recorded\n',
          );
          return 1;
        }
        for (const s of matching) {
          if (!existsSync(s.path)) missing++;
          store.enqueueReingest(s);
          queued++;
        }
      } finally {
        store.close();
      }
      process.stdout.write(
        `${queued} session file${queued === 1 ? '' : 's'} queued for durable re-ingestion on the next daemon start.\n`,
      );
      if (missing > 0)
        process.stdout.write(
          `${missing} file${missing === 1 ? ' is' : 's are'} currently missing; the job remains recorded with that outcome.\n`,
        );
      process.stdout.write('Restart the daemon to apply: salidium restart\n');
      return 0;
    }
    case 'retention': {
      const { db } = daemonPaths(salidiumHome);
      if (!existsSync(db)) {
        process.stderr.write(`no store at ${db}\n`);
        return 1;
      }
      if (arg !== undefined && (await liveStoreWriteBlocked('change or apply retention'))) return 2;
      const store = new SqliteStore(db, { readOnly: arg === undefined });
      try {
        if (arg === 'apply') {
          const running = readDaemonJson(salidiumHome);
          if (await storeHasWriter(running)) {
            process.stderr.write(
              'stop Salidium before applying cleanup manually; the running daemon applies the configured policy safely\n',
            );
            return 2;
          }
          const applied = store.applyRetention();
          process.stdout.write(
            `Forgot ${applied.sessions.length} complete session${applied.sessions.length === 1 ? '' : 's'} (${formatBytes(applied.bytes)}, ${applied.eventCount} events). SQLite can reuse the freed pages; run \`salidium retention compact\` offline to return them to the OS.\n`,
          );
          return 0;
        }
        if (arg === 'compact') {
          const dbBytes = statSync(db).size;
          const walPath = `${db}-wal`;
          const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
          const free = statfsSync(db);
          const freeBytes = Number(free.bavail) * Number(free.bsize);
          // SQLite VACUUM builds a temporary copy before atomically replacing the database. Keep
          // explicit headroom rather than discovering an undersized disk halfway through it.
          const requiredBytes = dbBytes + walBytes + Math.max(64 * 1024 * 1024, dbBytes * 0.1);
          if (freeBytes < requiredBytes) {
            process.stderr.write(
              `compaction needs about ${formatBytes(requiredBytes)} free; only ${formatBytes(freeBytes)} is available\n`,
            );
            return 2;
          }
          runRetentionCompactionMaintenance(salidiumHome, () => store.compact());
          const compactedBytes = statSync(db).size;
          process.stdout.write(
            `Compacted the offline store from ${formatBytes(dbBytes + walBytes)} to ${formatBytes(compactedBytes)}.\n`,
          );
          return 0;
        }
        if (arg !== undefined) {
          const policy = arg === 'forever' ? 'forever' : Number(arg);
          if (policy !== 'forever' && policy !== 30 && policy !== 90 && policy !== 365) {
            process.stderr.write('retention must be forever, 30, 90, or 365 days\n');
            return 2;
          }
          store.setRetentionPolicy(policy);
          process.stdout.write(
            policy === 'forever'
              ? 'Session history is kept forever. Nothing was deleted.\n'
              : `Sessions older than ${policy} days will expire automatically in bounded batches. Working, waiting, and pinned sessions are never eligible.\n`,
          );
        }
        const policy = store.retentionPolicy();
        const preview = store.retentionPreview(policy);
        const storeBytes = [db, `${db}-wal`].reduce(
          (bytes, path) => bytes + (existsSync(path) ? statSync(path).size : 0),
          0,
        );
        process.stdout.write(`Policy: ${policy === 'forever' ? 'forever' : `${policy} days`}\n`);
        process.stdout.write(`Store: ${formatBytes(storeBytes)}\n`);
        if (storeBytes >= 1000 * 1000 * 1000)
          process.stdout.write(
            inspectStoreLayout(db).optimized
              ? 'Storage warning: history is over 1 GB. Preview exactly what retention would delete before opting in.\n'
              : 'Lossless storage optimization is available before deleting history. Run `salidium storage`, then `salidium storage optimize`; it coordinates queue drain and daemon stop.\n',
          );
        process.stdout.write(`Pinned: ${store.pinnedSessionIds().length}\n`);
        process.stdout.write(
          policy === 'forever'
            ? 'Cleanup preview: no sessions are eligible.\n'
            : `Cleanup preview: ${preview.sessions.length} complete session${preview.sessions.length === 1 ? '' : 's'}, ${preview.eventCount} events, about ${formatBytes(preview.bytes)}.\n`,
        );
        return 0;
      } finally {
        store.close();
      }
    }
    case 'storage': {
      const { db } = daemonPaths(salidiumHome);
      if (!existsSync(db)) {
        process.stderr.write(`no store at ${db}\n`);
        return 1;
      }
      if (arg !== undefined && arg !== 'optimize' && arg !== 'composition') {
        process.stderr.write('storage accepts only `composition` or `optimize`\n');
        return 2;
      }
      /*
       * Measured here rather than asked of the daemon. It is read-only, a typed command is allowed
       * to take the ten seconds it costs, and this way the answer is available with the daemon
       * stopped, which is exactly when someone is looking at a store that has grown too large.
       */
      if (arg === 'composition') {
        const store = new SqliteStore(db, { concurrentWriter: true });
        try {
          const measured = store.storageComposition();
          if (jsonOutput) {
            process.stdout.write(`${JSON.stringify(measured)}\n`);
            return 0;
          }
          const label: Record<string, string> = {
            sessions: 'Recorded sessions',
            checkpoints: 'Replay checkpoints',
            provenance: 'Provenance records',
            structure: 'Indexes and internal structure',
            reusable: 'Reusable space',
          };
          process.stdout.write(`On this Mac: ${formatBytes(measured.fileBytes ?? 0)}\n`);
          for (const part of measured.parts)
            process.stdout.write(
              `  ${(label[part.key] ?? part.key).padEnd(30)} ${formatBytes(part.bytes)}\n`,
            );
          process.stdout.write(
            `\n${measured.sessions ?? 0} sessions across ${measured.projects.length + measured.projectsOmitted} projects.\n`,
          );
          for (const project of measured.projects)
            process.stdout.write(
              `  ${formatBytes(project.bytes).padStart(9)}  ${String(project.sessions).padStart(4)} ${project.sessions === 1 ? 'session ' : 'sessions'}  ${project.path || 'No project recorded'}\n`,
            );
          if (measured.projectsOmitted > 0)
            process.stdout.write(`  ${measured.projectsOmitted} more not listed.\n`);
          process.stdout.write(
            '\nIndexes and internal structure is the remainder after the named parts, not a separate measurement.\n',
          );
          return 0;
        } finally {
          store.close();
        }
      }
      if (arg === undefined) {
        const layout = inspectStoreLayout(db);
        if (quiet) return layout.optimized ? 0 : 3;
        if (jsonOutput) process.stdout.write(`${JSON.stringify(layout)}\n`);
        else {
          process.stdout.write(`Layout: ${layout.optimized ? 'Optimized' : 'Legacy'}\n`);
          process.stdout.write(`Page size: ${formatBytes(layout.pageSize)}\n`);
          process.stdout.write(
            `Events: ${layout.eventsWithoutRowid ? 'WITHOUT ROWID' : 'rowid table'}, ${layout.eventJsonType ?? 'unknown'} payload\n`,
          );
          process.stdout.write(`Checkpoints: ${layout.checkpointType ?? 'unknown'} payload\n`);
          if (!layout.optimized)
            process.stdout.write(
              'Lossless optimization is available. Run `salidium storage optimize`; it coordinates queue drain and daemon stop.\n',
            );
        }
        return layout.optimized ? 0 : 3;
      }
      return maintenanceCommand('optimize', args, { json: jsonOutput, quiet });
    }
    case 'pin':
    case 'unpin': {
      const { db } = daemonPaths(salidiumHome);
      if (!existsSync(db) || !arg) {
        process.stderr.write(!arg ? `name a session to ${cmd}\n` : `no store at ${db}\n`);
        return 2;
      }
      if (await liveStoreWriteBlocked(`${cmd} a session`)) return 2;
      const store = new SqliteStore(db);
      try {
        if (!store.pinSession(arg, cmd === 'pin')) {
          process.stderr.write(`unknown session: ${arg}\n`);
          return 1;
        }
      } finally {
        store.close();
      }
      process.stdout.write(`${arg} is ${cmd === 'pin' ? 'pinned' : 'no longer pinned'}.\n`);
      return 0;
    }
    case 'forget': {
      const { db } = daemonPaths(salidiumHome);
      if (!existsSync(db) || !arg) {
        process.stderr.write(!arg ? 'name one session to forget\n' : `no store at ${db}\n`);
        return 2;
      }
      if (!assumeYes) {
        process.stderr.write(
          'Forgetting removes the whole session and cannot be undone from Salidium. Re-run with --yes.\n',
        );
        return 2;
      }
      const running = readDaemonJson(salidiumHome);
      if (await storeHasWriter(running)) {
        process.stderr.write('stop Salidium before forgetting a session\n');
        return 2;
      }
      const store = new SqliteStore(db);
      try {
        if (!store.forgetSession(arg)) {
          process.stderr.write(`unknown session: ${arg}\n`);
          return 1;
        }
      } finally {
        store.close();
      }
      process.stdout.write(`Forgot ${arg}; its source cursor remains tombstoned.\n`);
      return 0;
    }
    case 'consumer':
      return runConsumerCommand(
        salidiumHome,
        arg,
        args,
        { json: jsonOutput },
        {
          out: (text) => process.stdout.write(text),
          err: (text) => process.stderr.write(text),
        },
      );
    case 'doctor':
      return doctor({
        json: jsonOutput,
        quiet,
        bundle: argv.includes('--bundle'),
        dryRun: argv.includes('--dry-run'),
        output: argv.find((value) => value.startsWith('--output='))?.slice(9),
      });
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

interface ProviderObservation {
  id: 'claude-code' | 'codex';
  name: string;
  detected: boolean;
  liveHooksSupported: boolean;
  hookStatus: 'configured' | 'not-configured' | 'partial' | 'invalid' | null;
  missingEvents: string[];
  hookTrust: 'trusted' | 'untrusted' | 'modified' | 'managed' | 'unknown' | null;
  hookTrustIssue: string | null;
}

async function observeProviders(): Promise<ProviderObservation[]> {
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

function localRetention(): CollectionStatus['store']['retention'] {
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

async function readEffectiveOperationalConfig(
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

function synchronizeOfflineRetention(): void {
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

function configPatch(key: string, value: unknown): Record<string, Record<string, unknown>> {
  const [group, field] = key.split('.');
  if (!group || !field) throw new Error(`invalid configuration key: ${key}`);
  return { [group]: { [field]: value } };
}

function parseConfigValue(key: string, raw: string): unknown {
  if (key === 'providers.enabled') {
    if (raw.trim() === 'none') return [];
    if (raw.trim().startsWith('[')) return JSON.parse(raw) as unknown;
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (key === 'git.enabled' || key === 'alerts.nativeNotifications') {
    if (raw !== 'true' && raw !== 'false') throw new Error(`${key} must be true or false`);
    return raw === 'true';
  }
  if (key === 'explainer.model') return raw === 'null' || raw === 'default' ? null : raw;
  if (
    key.endsWith('Minutes') ||
    key.endsWith('Seconds') ||
    key.endsWith('Bytes') ||
    key.endsWith('Files') ||
    key === 'history.days'
  ) {
    if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a nonnegative whole number`);
    return Number(raw);
  }
  if (key === 'retention.days') return raw === 'forever' ? raw : Number(raw);
  return raw;
}

function effectiveRows(config: EffectiveOperationalConfig) {
  return [
    ['history.days', config.values.history.days],
    ['retention.days', config.values.retention.days],
    ['git.enabled', config.values.git.enabled],
    ['providers.enabled', config.values.providers.enabled],
    ['explainer.cadence', config.values.explainer.cadence],
    ['explainer.backend', config.values.explainer.backend],
    ['explainer.model', config.values.explainer.model],
    ['health.sampleIntervalSeconds', config.values.health.sampleIntervalSeconds],
    ['health.historyMinutes', config.values.health.historyMinutes],
    ['alerts.queueAgeMinutes', config.values.alerts.queueAgeMinutes],
    ['alerts.queueGrowthFiles', config.values.alerts.queueGrowthFiles],
    ['alerts.databaseSizeBytes', config.values.alerts.databaseSizeBytes],
    ['alerts.cooldownMinutes', config.values.alerts.cooldownMinutes],
    ['alerts.nativeNotifications', config.values.alerts.nativeNotifications],
    ['ui.operationsDetail', config.values.ui.operationsDetail],
  ] as const;
}

function renderEffectiveConfig(config: EffectiveOperationalConfig): void {
  process.stdout.write(
    `Configuration schema ${config.schemaVersion}, revision ${config.revision}\n`,
  );
  for (const [key, entry] of effectiveRows(config)) {
    const rendered = Array.isArray(entry.value)
      ? entry.value.join(',') || 'none'
      : entry.value === null
        ? 'default'
        : String(entry.value);
    const source =
      entry.source === 'environment' ? `environment (${entry.environment})` : entry.source;
    const restart = config.restartRequired.includes(key) ? '; restart required' : '';
    process.stdout.write(`${key.padEnd(30)} ${rendered}  [${source}${restart}]\n`);
  }
}

async function readOperationsOverview(
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

/*
 * An absent estimate says which of the two reasons it is absent for.
 *
 * Everything null read "Unavailable (needs at least two exact samples)", which for the drain rate
 * was printed directly under a velocity line reporting eighty-four of them. `drainRate` is null
 * whenever the queue is not shrinking, and `timeToEmpty` whenever it is not shrinking or is
 * already empty; neither has anything to do with how many samples there are.
 */
function estimateLabel(
  estimate: OperationsHealthSnapshot['estimates']['queueVelocity'],
  absent = 'Unavailable (needs two measurements)',
): string {
  if (!estimate) return absent;
  const value =
    estimate.unit === 'bytes/minute'
      ? `${formatBytes(Math.abs(estimate.value))}/minute`
      : Math.abs(estimate.value).toFixed(1);
  /*
   * The sign comes from the number as shown, not the number as measured. A velocity of -0.004
   * files per minute is negative and rounds to 0.0, which printed as "−0.0 files/minute".
   */
  const zero = /^[0.]+(?: B\/minute)?$/.test(value);
  const sign = zero ? '' : estimate.value < 0 ? '−' : '+';
  const unit = estimate.unit === 'bytes/minute' ? '' : ` ${estimate.unit}`;
  return `${sign}${value}${unit} · derived from ${estimate.samples} samples over ${Math.round(estimate.sampleWindowSeconds)}s`;
}

async function serviceCommand(
  action: string | undefined,
  options: { json: boolean; quiet: boolean },
): Promise<number> {
  const command = action ?? 'status';
  if (!['install', 'status', 'enable', 'disable', 'uninstall'].includes(command)) {
    process.stderr.write('service accepts install, status, enable, disable, or uninstall\n');
    return 2;
  }
  const serviceOptions = {
    home: salidiumHome,
    userHome,
    currentScript: process.argv[1] ?? '',
    version: VERSION,
  };
  if (command === 'status') {
    const state = inspectMacOSService(serviceOptions);
    if (!options.quiet) {
      if (options.json) process.stdout.write(`${JSON.stringify(state)}\n`);
      else process.stdout.write(`${describeMacOSService(state).join('\n')}\n`);
    }
    return state.installed && state.enabled && state.daemonLoaded && state.menuLoaded ? 0 : 1;
  }
  if (platform() !== 'darwin') {
    process.stderr.write('always-on mode is currently available on macOS only\n');
    return 2;
  }

  if (command === 'install') {
    validateDaemonEnvironment();
    prepareMacOSService(serviceOptions);
    const stopped = await stopDaemon();
    if (stopped && (!stopped.signaled || !stopped.exited)) {
      process.stderr.write(
        `the existing daemon (pid ${stopped.pid}) could not be stopped safely; the login service was prepared but not activated\n`,
      );
      return 1;
    }
    await implicitlyResumeCollection();
    const paths = activateMacOSService(serviceOptions);
    const running = await ensureDaemon();
    if (!options.quiet) {
      if (options.json)
        process.stdout.write(
          `${JSON.stringify({ installed: true, enabled: true, pid: running.pid, paths })}\n`,
        );
      else
        process.stdout.write(
          `Always-on mode installed. Salidium is running (pid ${running.pid}) and its menu-bar control will start at login.\nData remains in ${salidiumHome}.\nDisable: salidium service disable\nRemove service files: salidium service uninstall\n`,
        );
    }
    return 0;
  }

  if (command === 'enable') {
    validateDaemonEnvironment();
    const before = inspectMacOSService(serviceOptions);
    if (!before.installed) {
      process.stderr.write('always-on mode is not installed; run `salidium service install`\n');
      return 1;
    }
    const stopped = await stopDaemon();
    if (stopped && (!stopped.signaled || !stopped.exited)) {
      process.stderr.write(
        `the existing daemon (pid ${stopped.pid}) could not be stopped safely; always-on mode was not enabled\n`,
      );
      return 1;
    }
    await implicitlyResumeCollection();
    activateMacOSService(serviceOptions);
    const running = await ensureDaemon();
    if (!options.quiet)
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ installed: true, enabled: true, pid: running.pid })}\n`
          : `Always-on mode enabled. Salidium is running (pid ${running.pid}).\n`,
      );
    return 0;
  }

  const before = inspectMacOSService(serviceOptions);
  if (!before.installed) {
    if (!options.quiet)
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ installed: false, enabled: false, removed: false })}\n`
          : 'Always-on mode is not installed.\n',
      );
    return 0;
  }
  await setCollectionState('pause', 'stop');
  const stopped = await stopDaemon();
  if (command === 'disable') {
    disableMacOSService(serviceOptions);
    if (!options.quiet)
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ installed: true, enabled: false, daemonStopped: stopped?.exited ?? true })}\n`
          : `Always-on mode disabled. Salidium and its menu bar are stopped; reports and settings remain in ${salidiumHome}.\nEnable again: salidium service enable\n`,
      );
    return stopped && (!stopped.signaled || !stopped.exited) ? 1 : 0;
  }

  const paths = uninstallMacOSService(serviceOptions);
  if (!options.quiet)
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ installed: false, removed: true, dataHome: salidiumHome })}\n`
        : `Always-on service files removed from ${paths.root}. Reports and settings were kept in ${salidiumHome}.\n`,
    );
  return stopped && (!stopped.signaled || !stopped.exited) ? 1 : 0;
}

async function statusCommand(options: {
  json: boolean;
  quiet: boolean;
  watch: boolean;
  intervalSeconds: number;
}): Promise<number> {
  if (
    !Number.isFinite(options.intervalSeconds) ||
    options.intervalSeconds < 0.5 ||
    options.intervalSeconds > 60
  ) {
    process.stderr.write('--interval must be from 0.5 to 60 seconds\n');
    return 2;
  }
  let interrupted = false;
  let wakeWatch: (() => void) | undefined;
  const interrupt = () => {
    interrupted = true;
    wakeWatch?.();
  };
  if (options.watch) process.once('SIGINT', interrupt);
  let lastExit = 0;
  let providers: ProviderObservation[] = [];
  let nextProviderInspectionAt = 0;
  const service = inspectMacOSService({ home: salidiumHome, userHome });
  try {
    do {
      const daemon = readDaemonJson(salidiumHome);
      const presence = await presenceOf(daemon);
      const explanations = await currentExplanationState(daemon, presence);
      if (Date.now() >= nextProviderInspectionAt) {
        providers = await observeProviders();
        nextProviderInspectionAt = Date.now() + 5 * 60_000;
      }
      const operations = await readOperationsOverview(daemon, presence, providers);
      const collection = collectionStatusFromHealth(operations.health);
      lastExit =
        presence === 'unresponsive'
          ? 1
          : operations.health.overall === 'critical'
            ? 4
            : presence === 'reachable'
              ? 0
              : 1;
      if (options.quiet) return lastExit;
      if (options.watch && process.stdout.isTTY && !options.json)
        process.stdout.write('\u001b[2J\u001b[H');
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({
            contractVersion: 1,
            daemon:
              daemon && presence !== 'absent'
                ? { ...daemon, token: undefined, presence }
                : { presence },
            collection,
            explanations,
            service,
            providers,
            operations,
          })}\n`,
        );
      } else {
        const health = operations.health;
        /*
         * One line about the daemon, in one shape.
         *
         * A stopped daemon printed a bare "not running" and then "Daemon: Stopped" directly under
         * it, and an unresponsive one changed the label itself to "Daemon running:" so the colon
         * fell in a different column than the six lines below it. The bare line existed because
         * `daemonLaunch.test.ts` asserted on it; what that test is for is that `status` reports a
         * dead daemon, which "Daemon: Stopped" says on its own.
         */
        process.stdout.write(
          health.daemon.state === 'running'
            ? `Daemon: Running · pid ${health.daemon.pid} · since ${health.daemon.startedAt}\n`
            : health.daemon.state === 'unresponsive'
              ? `Daemon: Not answering · pid ${health.daemon.pid}\n`
              : 'Daemon: Stopped\n',
        );
        process.stdout.write(
          daemon && presence !== 'absent'
            ? `Local endpoint: http://127.0.0.1:${daemon.port} · state ${salidiumHome}\n`
            : `State directory: ${salidiumHome}\n`,
        );
        if (service.supported)
          process.stdout.write(
            service.installed
              ? `Always-on: ${service.enabled ? 'Enabled' : 'Disabled'} · daemon ${service.daemonLoaded ? 'loaded' : 'not loaded'} · menu bar ${service.menuLoaded ? 'loaded' : 'not loaded'}\n`
              : 'Always-on: Not installed · enable with salidium service install\n',
          );
        process.stdout.write(
          `Collection: ${health.collection.state === 'active' ? 'Active' : `Paused${health.collection.pauseExpiresAt ? ` until ${health.collection.pauseExpiresAt}` : ''}`}\n`,
        );
        process.stdout.write(
          health.queue.availability === 'exact'
            ? `Queue (exact): ${(health.queue.files ?? 0).toLocaleString()} files, ${formatBytes(health.queue.bytes ?? 0)}${health.queue.oldestAt ? `, oldest ${health.queue.oldestAt}` : ''}\n`
            : `Queue: Unavailable · ${health.queue.reason ?? 'exact scan could not complete'}\n`,
        );
        process.stdout.write(
          `Store (exact): ${health.store.totalBytes === null ? 'Unavailable' : formatBytes(health.store.totalBytes)}, retention ${retentionLabel(health.store.retention)}, last ingest ${health.store.lastIngestAt ?? 'Unavailable'}\n`,
        );
        /*
         * How fast the store is filling, and how much room is left before the warning.
         *
         * "Storage growth (estimate): +499.8 KiB/minute" was already printed four lines down and
         * is a number nobody can act on: it does not say whether that is a megabyte a week or a
         * gigabyte a day. Retention defaults to keeping everything and the only other signal is an
         * alert that fires at 5 GB, which arrives once there are already 5 GB.
         */
        const projection = storageProjection(
          health.store.totalBytes,
          health.estimates.storageGrowth,
          operations.config.values.alerts.databaseSizeBytes.value,
        );
        if (projection) process.stdout.write(`Store outlook: ${projection}\n`);
        process.stdout.write(
          `Queue velocity (estimate): ${estimateLabel(health.estimates.queueVelocity)}\n`,
        );
        const sampled = health.estimates.queueVelocity !== null;
        const notShrinking = 'Unavailable (the queue is not shrinking)';
        process.stdout.write(
          `Drain rate (estimate): ${estimateLabel(
            health.estimates.drainRate,
            sampled ? notShrinking : undefined,
          )}\n`,
        );
        process.stdout.write(
          `Storage growth (estimate): ${estimateLabel(health.estimates.storageGrowth)}\n`,
        );
        process.stdout.write(
          `Time to empty (estimate): ${
            health.estimates.timeToEmpty
              ? `${Math.round(health.estimates.timeToEmpty.value)} seconds · derived`
              : health.queue.files === 0
                ? 'Already empty'
                : sampled
                  ? notShrinking
                  : 'Unavailable (needs two measurements)'
          }\n`,
        );
        process.stdout.write(
          `Health: ${health.overall === 'critical' ? 'Critical' : health.overall === 'attention' ? 'Needs attention' : 'Healthy'}\n`,
        );
        process.stdout.write(`Explanations: ${explanationStateLabel(explanations)}\n`);
        process.stdout.write(
          `Maintenance: ${health.maintenance ? `${maintenancePhaseLabel(health.maintenance.phase)} · ${health.maintenance.message}` : 'Idle'}\n`,
        );
        process.stdout.write(
          `Alerts: ${operations.alerts.active.length} active${operations.alerts.active.some((alert) => alert.state === 'acknowledged') ? ' (some acknowledged)' : ''}\n`,
        );
        process.stdout.write(
          `Desktop notifications: ${operations.config.values.alerts.nativeNotifications.value ? 'On' : 'Off'}\n`,
        );
        for (const provider of providers) {
          const label = !provider.detected
            ? 'Not detected'
            : !provider.liveHooksSupported
              ? 'History only; live hooks unavailable on native Windows'
              : hookStatusLabel(provider.hookStatus);
          const trust =
            provider.id === 'codex' && provider.hookStatus !== 'not-configured'
              ? `; trust ${hookTrustLabel(provider.hookTrust)}`
              : '';
          process.stdout.write(`${provider.name}: ${label}${trust}\n`);
        }
        if (health.gaps.active || health.gaps.recovered)
          process.stdout.write(
            `Collection gaps: ${health.gaps.active} active, ${health.gaps.recovered} recovered, ${health.gaps.omitted} older episodes omitted; exact dropped event counts unavailable\n`,
          );
        if (operations.config.restartRequired.length)
          process.stdout.write(
            `Restart required for: ${operations.config.restartRequired.join(', ')}\n`,
          );
        if (!options.watch)
          process.stdout.write(
            'Control: salidium open · salidium status --watch · salidium pause|resume|stop\n',
          );
      }
      if (!options.watch || interrupted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.intervalSeconds * 1000);
        wakeWatch = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wakeWatch = undefined;
    } while (!interrupted);
  } finally {
    if (options.watch) process.off('SIGINT', interrupt);
  }
  return lastExit;
}

async function maintenanceCommand(
  action: string | undefined,
  args: string[],
  options: { json: boolean; quiet: boolean },
): Promise<number> {
  const command = action ?? 'status';
  const daemon = readDaemonJson(salidiumHome);
  const presence = await presenceOf(daemon);
  if (command === 'status') {
    const state = readMaintenanceState(salidiumHome);
    if (!options.quiet)
      process.stdout.write(
        options.json
          ? `${JSON.stringify(state)}\n`
          : state
            ? `${state.phase}: ${state.message}\n`
            : 'Maintenance: idle\n',
      );
    return state?.phase === 'failure' || state?.phase === 'recovery' ? 3 : 0;
  }
  if (command === 'queue') {
    const asked = args.find((value) => value.startsWith('--limit='))?.slice(8);
    const limit = asked === undefined ? 25 : Number(asked);
    if (!Number.isFinite(limit) || limit < 0 || limit > 200) {
      process.stderr.write('--limit must be from 0 to 200\n');
      return 2;
    }
    let queue: QueueInspection;
    if (daemon && presence === 'reachable') {
      const response = await fetch(
        `http://127.0.0.1:${daemon.port}/api/operations/queue?limit=${Math.trunc(limit)}`,
        {
          headers: { Authorization: `Bearer ${daemon.token}` },
          signal: AbortSignal.timeout(2_000),
        },
      );
      if (!response.ok) throw new Error(`daemon refused queue inspection (${response.status})`);
      queue = (await response.json()) as QueueInspection;
    } else queue = inspectQueue(salidiumHome, { entryLimit: Math.trunc(limit) });
    if (!options.quiet) {
      if (options.json) process.stdout.write(`${JSON.stringify(queue)}\n`);
      else {
        process.stdout.write(
          queue.exactTotals
            ? `Queue: ${queue.totalFiles} files, ${formatBytes(queue.totalBytes ?? 0)} (exact)\n`
            : 'Queue totals unavailable; the scan safety ceiling was reached.\n',
        );
        if (queue.quarantinedFiles)
          process.stdout.write(
            `Quarantined: ${queue.quarantinedFiles} files, ${formatBytes(queue.quarantinedBytes ?? 0)} kept as evidence; a drain will not store them\n`,
          );
        for (const entry of queue.entries)
          process.stdout.write(
            `${entry.queuedAt}  ${String(entry.provider ?? 'unknown').padEnd(12)} ${entry.state.padEnd(10)} ${formatBytes(entry.bytes)}  ${entry.id}\n`,
          );
        if (queue.entriesTruncated)
          process.stdout.write('Older queue metadata omitted from this view.\n');
      }
    }
    return queue.exactTotals ? 0 : 3;
  }
  if (command === 'drain') {
    if (!daemon || presence !== 'reachable') {
      process.stderr.write(
        'start Salidium before draining; only the daemon can make queued input durable\n',
      );
      return 1;
    }
    const waitRaw = args.find((value) => value.startsWith('--wait='))?.slice(7);
    const waitSeconds = waitRaw === undefined ? 30 : Number(waitRaw);
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 300) {
      process.stderr.write('--wait must be from 0 to 300 seconds\n');
      return 2;
    }
    const deadline = Date.now() + waitSeconds * 1000;
    let result:
      | {
          state: unknown;
          before: { totalFiles: number | null };
          after: { totalFiles: number | null };
        }
      | undefined;
    for (;;) {
      const response = await fetch(
        `http://127.0.0.1:${daemon.port}/api/operations/maintenance/drain`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${daemon.token}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) throw new Error(`daemon refused queue drain (${response.status})`);
      const next = (await response.json()) as NonNullable<typeof result>;
      result = next;
      if (next.after.totalFiles === 0 || Date.now() >= deadline) break;
      await sleep(100);
    }
    if (!result) throw new Error('queue drain returned no result');
    if (!options.quiet)
      process.stdout.write(
        options.json
          ? `${JSON.stringify(result)}\n`
          : `Queue drain: ${result.before.totalFiles ?? 'unknown'} → ${result.after.totalFiles ?? 'unknown'} files. No queued file was discarded.\n`,
      );
    return result.after.totalFiles === 0 ? 0 : 3;
  }
  if (command === 'optimize') {
    const dryRun = args.includes('--dry-run');
    if (dryRun) {
      const preview = storageOptimizationPreflight(salidiumHome);
      if (!options.quiet)
        process.stdout.write(
          options.json
            ? `${JSON.stringify(preview)}\n`
            : `Optimization preview: ${preview.beforeBytes} bytes; needs ${preview.requiredFreeBytes} free; ${preview.queue.totalFiles ?? 'unknown'} queued files. ${preview.canRun ? 'Ready.' : `Blocked: ${preview.blockers.join('; ')}.`}\n`,
        );
      return preview.canRun ? 0 : 3;
    }
    if (presence === 'unresponsive') {
      process.stderr.write(
        'the daemon is running but not answering; stop Salidium before offline maintenance\n',
      );
      return 2;
    }
    let restart = false;
    let resume = false;
    let exitCode = 0;
    try {
      if (daemon && presence === 'reachable') {
        restart = true;
        const current = await collectionStatus(daemon, presence, configuredHookPresent());
        resume = current.state === 'active';
        const drained = await maintenanceCommand('drain', ['--wait=60'], {
          json: false,
          quiet: true,
        });
        if (drained !== 0) throw new Error('the durable queue did not empty before the deadline');
        await setCollectionState('pause', 'manual');
        const stopped = await stopDaemon();
        if (!stopped?.signaled || !stopped.exited)
          throw new Error('the daemon did not stop cleanly');
      }
      const result = runStorageOptimizationMaintenance(salidiumHome, {
        onProgress:
          options.quiet || options.json
            ? undefined
            : (message) => process.stdout.write(`${message}…\n`),
      });
      if (!options.quiet)
        process.stdout.write(
          options.json
            ? `${JSON.stringify(result)}\n`
            : result.alreadyOptimized
              ? 'Storage is already optimized.\n'
              : `Optimized ${result.eventRows.toLocaleString()} events from ${formatBytes(result.beforeBytes)} to ${formatBytes(result.afterBytes)}; row counts, logical digests, and integrity matched.\n`,
        );
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      exitCode = 2;
    } finally {
      if (restart) {
        try {
          await ensureDaemon();
          if (resume) await setCollectionState('resume');
        } catch (error) {
          process.stderr.write(
            `maintenance finished, but daemon restart failed: ${String(error)}\n`,
          );
          exitCode = 2;
        }
      }
    }
    return exitCode;
  }
  if (command === 'acknowledge') {
    const id = args[0];
    if (!id) {
      process.stderr.write('usage: salidium maintenance acknowledge ALERT_ID\n');
      return 2;
    }
    let alerts: LocalAlertState;
    if (daemon && presence === 'reachable') {
      const response = await fetch(
        `http://127.0.0.1:${daemon.port}/api/operations/alerts/${encodeURIComponent(id)}/acknowledge`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${daemon.token}` },
          signal: AbortSignal.timeout(2_000),
        },
      );
      if (!response.ok) throw new Error(`alert acknowledgement failed (${response.status})`);
      alerts = (await response.json()) as LocalAlertState;
    } else alerts = acknowledgeLocalAlert(salidiumHome, id);
    if (!options.quiet)
      process.stdout.write(
        options.json ? `${JSON.stringify(alerts)}\n` : `Alert ${id} acknowledged.\n`,
      );
    return 0;
  }
  process.stderr.write('maintenance accepts status, queue, drain, optimize, or acknowledge\n');
  return 2;
}

function maintenancePhaseLabel(phase: string): string {
  if (phase === 'failure') return 'Did not finish';
  if (phase === 'recovery') return 'Recovering';
  if (phase === 'completed') return 'Finished';
  if (phase === 'running') return 'Running';
  return phase;
}

/** Both halves are labelled projections: a rate measured over an hour does not run overnight. */
function storageProjection(
  total: number | null,
  growth: OperationsHealthSnapshot['estimates']['storageGrowth'],
  warnAt: number,
): string {
  const parts: string[] = [];
  if (growth && growth.value > 0)
    parts.push(`about ${formatBytes(growth.value * 60 * 24)} a day at this rate`);
  if (total !== null) {
    const mark = formatBytes(warnAt);
    const room = formatBytes(warnAt - total);
    parts.push(
      total >= warnAt
        ? `past its ${mark} warning mark`
        : room === mark
          ? `warns at ${mark}`
          : `${room} below its ${mark} warning mark`,
    );
  }
  return parts.join(' · ');
}

function queueLabel(status: CollectionStatus): string {
  return `${status.queue.files.toLocaleString()} file${status.queue.files === 1 ? '' : 's'}, ${formatBytes(status.queue.bytes)}`;
}

function retentionLabel(retention: CollectionStatus['store']['retention']): string {
  if (retention === null) return 'Unavailable';
  return retention === 'forever' ? 'Forever' : `${retention} days`;
}

function collectionStatusLabel(status: CollectionStatus): string {
  if (!status.pause) return status.state === 'paused' ? 'Paused; lease unreadable' : 'Active';
  return `Paused until ${status.pause.expiresAt}`;
}

function hookStatusLabel(status: string | null): string {
  if (status === 'configured') return 'Connected';
  if (status === 'partial') return 'Incomplete';
  if (status === 'invalid') return 'Configuration needs repair';
  return 'Not connected';
}

function hookTrustLabel(trust: string | null): string {
  if (trust === 'trusted') return 'Approved';
  if (trust === 'managed') return 'Managed';
  if (trust === 'untrusted') return 'Approval required';
  if (trust === 'modified') return 'Changed since approval';
  return 'Unavailable';
}

async function setCollectionState(
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

async function implicitlyResumeCollection(): Promise<void> {
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

async function collectionStatus(
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

function configuredHookPresent(): boolean {
  return (['claude-code', 'codex'] as const).some(
    (provider) => inspectBuiltInHooks(provider, userHome, salidiumHome).status !== 'not-configured',
  );
}

function uiUrl(d: DaemonJson): string {
  return `http://127.0.0.1:${d.port}/#token=${d.token}`;
}

interface ExplanationState {
  stored: ExplainerCadence;
  effective: ExplainerCadence;
  envOff: boolean;
  /** Which writer the daemon will use, when a running daemon could say. */
  writer?: string;
}

function explanationStateFromApi(settings: ExplainerSettings): ExplanationState {
  const writer = explanationWriter(settings);
  return {
    stored: settings.cadence,
    effective: settings.envOff ? 'off' : settings.cadence,
    envOff: settings.envOff,
    ...(writer ? { writer } : {}),
  };
}

function localExplanationState(): ExplanationState {
  const stored = readSettings(salidiumHome).explainerCadence;
  const effective = effectiveCadence(stored);
  return { stored, effective, envOff: effective !== stored };
}

async function currentExplanationState(
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

function explanationStateLabel(state: ExplanationState): string {
  const mode = explanationMode(state.effective);
  return `${mode.label}${state.envOff && state.stored !== 'off' ? ' (forced by environment)' : ''} · ${mode.detail}`;
}

async function alive(d: DaemonJson): Promise<boolean> {
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
type Presence = 'reachable' | 'unresponsive' | 'absent';

async function presenceOf(d: DaemonJson | undefined): Promise<Presence> {
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
async function storeHasWriter(d: DaemonJson | undefined): Promise<boolean> {
  return (await presenceOf(d)) !== 'absent';
}

/**
 * Ask the running daemon to stop, and wait until its process is actually gone.
 *
 * `undefined` if there was nothing running. Otherwise the pid, whether it was safely signaled, and
 * whether it left. A PID is not identity: it is signaled only after the tokened endpoint confirms
 * that the same PID belongs to the daemon described by daemon.json.
 */
async function stopDaemon(): Promise<
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
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function liveStoreWriteBlocked(action: string): Promise<boolean> {
  const daemon = readDaemonJson(salidiumHome);
  if (!(await storeHasWriter(daemon))) return false;
  process.stderr.write(
    `stop Salidium before you ${action}; offline maintenance will not migrate or rewrite a store under a running daemon\n`,
  );
  return true;
}

async function ensureDaemon(): Promise<DaemonJson> {
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
function startupFailureReason(logFile: string): string {
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
function compareSemver(left: string, right: string): -1 | 0 | 1 | undefined {
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

function openBrowser(url: string): void {
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

async function confirmSetup(question: string, color: boolean): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await prompt.question(`${question} [y/N] `);
      return /^(y|yes)$/i.test(answer.trim());
    } finally {
      prompt.close();
    }
  }

  const ui = new TerminalUi(color);
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = Boolean(input.isRaw);
  let selected = false;

  const render = () => output.write(`\u001b[?25l\r\u001b[2K${ui.choice(question, selected)}`);

  return new Promise<boolean>((resolve, reject) => {
    const finish = (decision: boolean) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
      render();
      output.write('\u001b[?25h\n');
      resolve(decision);
    };
    const onData = (data: Buffer | string) => {
      const result = consentKeyResult(String(data), selected);
      selected = result.selected;
      if (result.aborted) {
        input.off('data', onData);
        input.setRawMode(wasRaw);
        if (!wasRaw) input.pause();
        output.write('\u001b[?25h\n');
        reject(new Error('Aborted with Ctrl+C'));
        return;
      }
      if (result.decision !== undefined) {
        finish(result.decision);
        return;
      }
      render();
    };

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    render();
  });
}

async function selectTerminalOption(
  question: string,
  options: readonly string[],
  initialIndex: number,
  color: boolean,
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return initialIndex;

  const ui = new TerminalUi(color);
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = Boolean(input.isRaw);
  let selectedIndex = initialIndex;

  const render = () =>
    output.write(`\u001b[?25l\r\u001b[2K${ui.choices(question, options, selectedIndex)}`);

  return new Promise<number>((resolve, reject) => {
    const finish = (decision: number) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
      selectedIndex = decision;
      render();
      output.write('\u001b[?25h\n');
      resolve(decision);
    };
    const onData = (data: Buffer | string) => {
      const result = selectionKeyResult(String(data), selectedIndex, options.length);
      selectedIndex = result.selectedIndex;
      if (result.aborted) {
        input.off('data', onData);
        input.setRawMode(wasRaw);
        if (!wasRaw) input.pause();
        output.write('\u001b[?25h\n');
        reject(new Error('Aborted with Ctrl+C'));
        return;
      }
      if (result.decision !== undefined) {
        finish(result.decision);
        return;
      }
      render();
    };

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    render();
  });
}

function essentialValidations(): IntegrationValidation[] {
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

function validateDaemonEnvironment(): void {
  validateSalidiumPort(process.env.SALIDIUM_PORT);
  validateSalidiumHistoryDays(process.env.SALIDIUM_HISTORY_DAYS);
}

async function doctor(options: {
  json: boolean;
  quiet: boolean;
  bundle: boolean;
  dryRun: boolean;
  output?: string;
}): Promise<number> {
  const lines: string[] = [];
  let problems = 0;
  const validations = essentialValidations();
  for (const validation of validations) {
    lines.push(validation.message);
    if (validation.level === 'attention') problems++;
  }
  const d = readDaemonJson(salidiumHome);
  const presence = await presenceOf(d);
  lines.push(
    d && presence === 'reachable'
      ? `daemon running on ${d.port}`
      : d && presence === 'unresponsive'
        ? `daemon pid ${d.pid} is running on ${d.port} but did not answer; it may be importing history`
        : 'daemon not running',
  );
  let settingsProblem: string | undefined;
  readSettings(salidiumHome, (reason) => {
    settingsProblem = reason;
  });
  if (settingsProblem) {
    lines.push(
      'operational configuration is invalid; safe defaults are in force until it is repaired',
    );
    problems++;
  }
  lines.push(`explanations ${explanationStateLabel(localExplanationState())}`);
  const context: IntegrationContext = { userHome, salidiumHome };
  const providerResults: Array<{
    id: string;
    name: string;
    detected: boolean;
    validations: IntegrationValidation[];
    historyFound: boolean;
    hookStatus: string | null;
    hookTrust: string | null;
    hookTrustIssue: string | null;
  }> = [];
  for (const provider of providerIntegrations) {
    const detection = provider.detect(context);
    if (!detection.detected) {
      lines.push(`${provider.name} not detected`);
      providerResults.push({
        id: provider.id,
        name: provider.name,
        detected: false,
        validations: [],
        historyFound: false,
        hookStatus: null,
        hookTrust: null,
        hookTrustIssue: null,
      });
      continue;
    }
    if (!provider.liveHooksSupported(context)) {
      lines.push(
        `${provider.name} history-only on native Windows; live POSIX hooks are unavailable`,
      );
      lines.push(
        `${provider.name} history ${provider.historyDirectories(context).some(existsSync) ? 'found' : 'not found yet'}`,
      );
      providerResults.push({
        id: provider.id,
        name: provider.name,
        detected: true,
        validations: provider.validate(context),
        historyFound: provider.historyDirectories(context).some(existsSync),
        hookStatus: null,
        hookTrust: null,
        hookTrustIssue: null,
      });
      continue;
    }
    const inspection = provider.inspect(context);
    const providerValidations = provider.validate(context);
    for (const validation of providerValidations) {
      lines.push(validation.message);
      if (validation.level === 'attention') problems++;
    }
    const historyFound = provider.historyDirectories(context).some(existsSync);
    lines.push(`${provider.name} history ${historyFound ? 'found' : 'not found yet'}`);
    providerResults.push({
      id: provider.id,
      name: provider.name,
      detected: true,
      validations: providerValidations,
      historyFound,
      hookStatus: inspection.status,
      hookTrust: null,
      hookTrustIssue: null,
    });
  }
  const codexResult = providerResults.find((provider) => provider.id === 'codex');
  if (codexResult?.detected && codexResult.hookStatus !== 'not-configured') {
    const trust = await inspectCodexHookTrust(
      process.cwd(),
      process.env,
      3_000,
      undefined,
      VERSION,
    );
    codexResult.hookTrust = trust.trust;
    codexResult.hookTrustIssue = trust.issue ?? null;
    lines.push(`Codex hook trust ${hookTrustLabel(trust.trust).toLowerCase()}`);
    if (trust.trust === 'untrusted' || trust.trust === 'modified') problems++;
  }
  const collection = await collectionStatus(d, presence, configuredHookPresent());
  lines.push(`collection ${collectionStatusLabel(collection).toLowerCase()}`);
  lines.push(`queue ${queueLabel(collection)}`);
  lines.push(
    `store ${collection.store.bytes === null ? 'unavailable' : formatBytes(collection.store.bytes)}, retention ${retentionLabel(collection.store.retention).toLowerCase()}, last ingest ${collection.store.lastIngestAt ?? 'unavailable'}`,
  );
  if (collection.gaps.active.length > 0)
    lines.push(
      `collection has ${collection.gaps.active.length} active loss marker${collection.gaps.active.length === 1 ? '' : 's'}; exact dropped event counts are unavailable`,
    );
  if (collection.gaps.recovered.length > 0 || collection.gaps.omittedEpisodes > 0)
    lines.push(
      `collection ledger has ${collection.gaps.recovered.length} recovered episode${collection.gaps.recovered.length === 1 ? '' : 's'} and ${collection.gaps.omittedEpisodes} older omitted`,
    );
  if (collection.state === 'paused' && !collection.pause)
    lines.push('collection pause marker is unreadable; any later CLI command will clear it');
  const exit =
    collection.health === 'runaway'
      ? 4
      : problems
        ? 1
        : collection.health === 'attention' || (collection.state === 'paused' && !collection.pause)
          ? 3
          : 0;
  let bundle:
    | { dryRun: true; manifest: ReturnType<typeof diagnosticManifest> }
    | { dryRun: false; result: ReturnType<typeof createDiagnosticBundle> }
    | undefined;
  if (options.bundle) {
    const now = new Date();
    const manifest = diagnosticManifest(now);
    if (options.dryRun) bundle = { dryRun: true, manifest };
    else {
      const providers = await observeProviders();
      const operations = await readOperationsOverview(d, presence, providers);
      const stamp = now
        .toISOString()
        .replaceAll(':', '')
        .replace(/\.\d{3}Z$/, 'Z');
      const outputPath = resolve(
        options.output ?? join(process.cwd(), `salidium-diagnostics-${stamp}.json`),
      );
      const result = createDiagnosticBundle({
        home: salidiumHome,
        outputPath,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        storeSchemaVersion: operations.health.store.schemaVersion,
        config: operations.config,
        health: operations.health,
        alerts: operations.alerts,
        platform: {
          platform: platform(),
          release: release(),
          arch: arch(),
          node: process.versions.node,
        },
        now,
      });
      bundle = { dryRun: false, result };
    }
  }
  if (options.quiet) return exit;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: exit === 0,
        exitCode: exit,
        daemon: d && presence !== 'absent' ? { ...d, token: undefined, presence } : { presence },
        validations,
        settingsProblem: settingsProblem ?? null,
        providers: providerResults,
        collection,
        diagnosticBundle: bundle ?? null,
      })}\n`,
    );
  } else {
    if (bundle?.dryRun)
      lines.push(
        `diagnostic bundle preview: ${bundle.manifest.entries.map((entry) => entry.name).join(', ')}; excludes ${bundle.manifest.excludes.join(', ')}`,
      );
    else if (bundle)
      lines.push(
        `diagnostic bundle written to ${bundle.result.path} (${formatBytes(bundle.result.bytes)}, ${bundle.result.redactions} redactions)`,
      );
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return exit;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
