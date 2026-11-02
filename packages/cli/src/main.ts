#!/usr/bin/env node
import { resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parentPort } from 'node:worker_threads';
import {
  DEFAULT_PORT,
  readCollectionPause,
  readSettings,
  SqliteStore,
  startDaemon,
} from '@salidium/daemon';
import { doctorCommand } from './commands/doctor.ts';
import {
  runAuditClaimsCommand,
  runForgetCommand,
  runPinCommand,
  runReingestCommand,
  runRetentionCommand,
  runShowCommand,
  runStorageCommand,
} from './commands/ingest.ts';
import { runMapCommand } from './commands/projectMap.ts';
import {
  runConfigCommand,
  runExplanationsCommand,
  runHooksCommand,
  runUpCommand,
  serviceCommand,
} from './commands/service.ts';
import {
  currentExplanationState,
  ensureDaemon,
  explanationStateLabel,
  implicitlyResumeCollection,
  openBrowser,
  queueLabel,
  salidiumHome,
  setCollectionState,
  stopDaemon,
  uiUrl,
  VERSION,
  validateDaemonEnvironment,
} from './commands/shared.ts';
import { maintenanceCommand, statusCommand } from './commands/status.ts';
import { runConsumerCommand } from './consumerCommand.ts';
import { explanationMode } from './explanationMode.ts';
import { clearsPauseOnRun } from './pauseOnRun.ts';

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
  salidium storage              Show the lossless storage layout, total size, and project breakdown
  salidium storage composition  Measure what is using the space, by part and by project
  salidium storage forget --project PATH [--yes]
                                Preview or forget every session recorded for one project
  salidium storage forget --all [--yes]
                                Preview or forget every session while keeping settings and hooks
  salidium storage compact      Coordinate queue drain, daemon pause, VACUUM, and restart
  salidium storage optimize     Coordinate, copy, verify, and install the compact layout
  salidium pin [session]        Exempt a session from automatic retention
  salidium unpin [session]      Remove the retention exemption
  salidium forget [session]     Immediately forget one whole session (--yes)
  salidium consumer create LABEL
                                Create a read-only credential a local tool uses to read reports;
                                the token is printed once
  salidium consumer list        Show consumer credentials (never their secrets)
  salidium consumer revoke ID   Revoke one consumer credential immediately
  salidium map allow REPOSITORY Let Salidium map a repository's committed tree (experimental);
                                tools with a consumer credential can then read its structure
  salidium map list             Show the repositories Salidium may map
  salidium map revoke REPOSITORY
                                Stop mapping a repository and delete its cached maps
  salidium map show REPOSITORY [COMMIT]
                                Print a summary of the map at a commit (default HEAD)
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
Ordinary commands resume an expired or manual pause. help, version, pause, stop, service commands,
and coordinated storage optimize or compact do not; resume changes collection state explicitly. A pause
from stop or service disable lasts until a command starts Salidium again (up, start, open, restart) or
resume is run, because nothing drains the queue while it is stopped. Add --no-resume to any command
to leave a pause in place, for a caller that has already seen the daemon answer and so cannot be
recovering a marker its dead owner left behind.
`;

async function main(argv: string[]): Promise<number> {
  const assumeYes = argv.includes('--yes') || argv.includes('-y');
  const noOpen = argv.includes('--no-open');
  const jsonOutput = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const positional = argv.filter(
    (value) =>
      ![
        '--yes',
        '-y',
        '--no-open',
        '--json',
        '--quiet',
        '--no-resume',
        '--storage',
        '--operations',
      ].includes(value),
  );
  const [cmd = 'up', arg, ...args] = positional;
  if (clearsPauseOnRun(cmd, arg, argv, readCollectionPause(salidiumHome)?.reason))
    await implicitlyResumeCollection();
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
    case 'up':
      return runUpCommand({ assumeYes, noOpen });
    case 'open': {
      const running = await ensureDaemon();
      const target = argv.includes('--storage')
        ? 'storage'
        : argv.includes('--operations')
          ? 'operations'
          : undefined;
      openBrowser(uiUrl(running, target));
      return 0;
    }
    case 'show':
      return runShowCommand(arg, argv);
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
        `Collection is paused until Salidium starts again or you run \`salidium resume\`. Observed queue at pause: ${queueLabel(collection)}. New hook and transcript observations will not be collected while paused.\n`,
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
    case 'config':
      return runConfigCommand(arg, args, { json: jsonOutput, quiet });
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
    case 'explanations':
      return runExplanationsCommand(arg);
    case 'install-hooks':
    case 'uninstall-hooks':
      return runHooksCommand(cmd, arg);
    case 'audit-claims':
      return runAuditClaimsCommand(argv);
    case 'reingest':
      return runReingestCommand(arg, argv);
    case 'retention':
      return runRetentionCommand(arg);
    case 'storage':
      return runStorageCommand(arg, args, { assumeYes, json: jsonOutput, quiet });
    case 'pin':
    case 'unpin':
      return runPinCommand(cmd, arg);
    case 'forget':
      return runForgetCommand(arg, assumeYes);
    case 'map':
      return runMapCommand(
        salidiumHome,
        arg,
        args,
        { json: jsonOutput },
        {
          out: (text) => process.stdout.write(text),
          err: (text) => process.stderr.write(text),
        },
      );
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
      return doctorCommand({
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

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
