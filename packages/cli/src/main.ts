#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statfsSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { basename as pathBasename } from '@salidium/core';
import {
  type DaemonJson,
  DEFAULT_PORT,
  daemonPaths,
  defaultUiDist,
  getExplainerStatus,
  readDaemonJson,
  readSettings,
  rotateLogFile,
  SCHEMA_VERSION,
  SqliteStore,
  startDaemon,
  validateSalidiumHistoryDays,
} from '@salidium/daemon';
import { type DaemonInfo, PROTOCOL_VERSION } from '@salidium/protocol';
import { auditClaims, renderAudit } from './auditClaims.ts';
import type { IntegrationContext, IntegrationValidation } from './integrations.ts';
import { integrationById, providerIntegrations } from './integrations.ts';
import { runFirstRunOnboarding } from './onboarding.ts';
import { renderReport } from './render.ts';
import { resolveBrowserLaunch, validateSalidiumPort } from './runtime.ts';
import { providerDisplayName, sessionSearchQuery } from './showSession.ts';

const HELP = `salidium — see what your coding agent did, why, how, what's verified, what's left, what needs you.

Usage:
  salidium                      Connect detected agents on first run, then start and open Salidium
  salidium start                Start the daemon in the background
  salidium daemon               Run the daemon in the foreground
  salidium stop                 Stop the background daemon
  salidium restart              Stop it, start it again, and open the UI (--no-open to skip)
  salidium status               Show daemon status
  salidium open                 Open the UI in your browser
  salidium show [session]       Print the report for a session as text (default: most recent)
                                --detail=summary|detail|source, --width=N
  salidium install-hooks [claude-code|codex|all]    Register Salidium hooks (default: all present)
  salidium uninstall-hooks [claude-code|codex|all]
  salidium doctor               Check the local setup
  salidium --version            Print the installed version
  salidium reingest [session]   Re-read session files (--all, --status, --verbose)
  salidium retention            Show the current history policy and a cleanup preview
  salidium retention forever|30|90|365
                                Set automatic session retention (default: forever)
  salidium retention apply      Apply one cleanup batch now (daemon must be stopped)
  salidium retention compact    Return reusable SQLite pages to the OS (daemon must be stopped)
  salidium pin [session]        Exempt a session from automatic retention
  salidium unpin [session]      Remove the retention exemption
  salidium forget [session]     Immediately forget one whole session (--yes)
  salidium audit-claims         Measure the claim classifier against every session in your store
                                --sample=N (default 8), --only=rule, --seed=N, --limit=N, --json

First-run options:
  --yes, -y                    Approve detected provider configuration without a prompt
  --no-open                    Start Salidium without opening a browser

Environment:
  SALIDIUM_HOME          State directory (default ~/.salidium)
  SALIDIUM_PORT          Loopback port (default ${DEFAULT_PORT})
  SALIDIUM_HISTORY_DAYS  Whole days of transcript history to import, 0 or greater (default 7)
  SALIDIUM_NO_GIT=1      Disable read-only git snapshots
  SALIDIUM_EXPLAINER     Visual explainer: auto, claude, codex, or off (default auto)
  SALIDIUM_EXPLAIN_MODEL Optional model override for the selected explainer

Native Windows imports transcript history but does not install the POSIX live-hook relay.
`;

const require = createRequire(import.meta.url);
const VERSION: string = (() => {
  try {
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

const userHome = homedir();
const salidiumHome = process.env.SALIDIUM_HOME ?? join(userHome, '.salidium');

async function main(argv: string[]): Promise<number> {
  const assumeYes = argv.includes('--yes') || argv.includes('-y');
  const noOpen = argv.includes('--no-open');
  const positional = argv.filter((value) => !['--yes', '-y', '--no-open'].includes(value));
  const [cmd = 'up', arg] = positional;
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
    case 'start': {
      const running = await ensureDaemon();
      process.stdout.write(
        `daemon running on http://127.0.0.1:${running.port} (pid ${running.pid})\n`,
      );
      return 0;
    }
    case 'up': {
      const context: IntegrationContext = { userHome, salidiumHome };
      await runFirstRunOnboarding(
        context,
        {
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          confirm: confirmSetup,
          write: (text) => process.stdout.write(text),
        },
        {
          assumeYes,
          firstRun: !existsSync(daemonPaths(salidiumHome).db),
        },
      );
      for (const validation of essentialValidations()) {
        if (validation.level === 'attention')
          process.stdout.write(`Needs attention: ${validation.message}.\n`);
      }
      const running = await ensureDaemon();
      if (!noOpen && process.stdout.isTTY) openBrowser(uiUrl(running));
      process.stdout.write(`${uiUrl(running)}\n`);
      return 0;
    }
    case 'open': {
      const running = await ensureDaemon();
      openBrowser(uiUrl(running));
      return 0;
    }
    case 'show': {
      const d = readDaemonJson(salidiumHome);
      if (!d || !(await alive(d))) {
        process.stderr.write('daemon is not running; start it with `salidium start`\n');
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
      return stopped === undefined || (stopped.signaled && stopped.exited) ? 0 : 1;
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
      process.stdout.write(`daemon running (pid ${running.pid})\n${uiUrl(running)}\n`);
      return 0;
    }
    case 'status': {
      const d = readDaemonJson(salidiumHome);
      const ok = d ? await alive(d) : false;
      process.stdout.write(
        ok && d ? `running: pid ${d.pid}, port ${d.port}, since ${d.startedAt}\n` : 'not running\n',
      );
      const context: IntegrationContext = { userHome, salidiumHome };
      for (const provider of providerIntegrations) {
        const detection = provider.detect(context);
        const status = !detection.detected
          ? 'not detected'
          : provider.liveHooksSupported(context)
            ? provider.inspect(context).status
            : 'history-only (native Windows; live hooks unavailable)';
        process.stdout.write(`${provider.name}: ${status}\n`);
      }
      return ok ? 0 : 1;
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
            `${provider.name}: skipped — native Windows uses transcript history only; POSIX live hooks were not installed\n`,
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
            `Re-ingestion: ${jobs.length} jobs — ${statuses.map((status) => `${counts.get(status) ?? 0} ${status}`).join(', ')}.\n`,
          );
          const visible = argv.includes('--verbose')
            ? jobs
            : jobs.filter((job) => job.status === 'missing' || job.status === 'failed');
          for (const job of visible)
            process.stdout.write(
              `${job.status.padEnd(9)} ${job.sessionId} ${job.path} (attempts ${job.attempts}, parser ${job.parserRevision})${job.error ? ` — ${job.error}` : ''}\n`,
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
          if (running && (await alive(running))) {
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
          store.compact();
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
        if (storeBytes >= 1024 * 1024 * 1024)
          process.stdout.write(
            'Storage warning: history is over 1 GiB. Preview a 30, 90, or 365 day policy before opting in.\n',
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
      if (running && (await alive(running))) {
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
    case 'doctor':
      return doctor();
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function uiUrl(d: DaemonJson): string {
  return `http://127.0.0.1:${d.port}/#token=${d.token}`;
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
  if (!daemon || !(await alive(daemon))) return false;
  process.stderr.write(
    `stop Salidium before you ${action}; offline maintenance will not migrate or rewrite a store under a running daemon\n`,
  );
  return true;
}

async function ensureDaemon(): Promise<DaemonJson> {
  const existing = readDaemonJson(salidiumHome);
  if (existing && (await alive(existing))) {
    const runtimeCompatible =
      existing.version === VERSION &&
      existing.protocolVersion === PROTOCOL_VERSION &&
      existing.storeSchemaVersion === SCHEMA_VERSION;
    if (runtimeCompatible) return existing;
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
      throw new Error(`daemon ${childFailure} before it became ready; see ${paths.startupLogFile}`);
    const d = readDaemonJson(salidiumHome);
    if (d && d.pid === child.pid && (await alive(d))) return d;
  }
  throw new Error(`daemon did not start; see ${paths.startupLogFile}`);
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

async function confirmSetup(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(question);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
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

async function doctor(): Promise<number> {
  const lines: string[] = [];
  let problems = 0;
  for (const validation of essentialValidations()) {
    lines.push(validation.message);
    if (validation.level === 'attention') problems++;
  }
  const d = readDaemonJson(salidiumHome);
  const running = d ? await alive(d) : false;
  lines.push(`daemon ${running && d ? `running on ${d.port}` : 'not running'}`);
  let settingsProblem: string | undefined;
  readSettings(salidiumHome, (reason) => {
    settingsProblem = reason;
  });
  if (settingsProblem) {
    lines.push('settings file is invalid; optional explanations are safely off until it is fixed');
    problems++;
  }
  const context: IntegrationContext = { userHome, salidiumHome };
  for (const provider of providerIntegrations) {
    const detection = provider.detect(context);
    if (!detection.detected) {
      lines.push(`${provider.name} not detected`);
      continue;
    }
    if (!provider.liveHooksSupported(context)) {
      lines.push(
        `${provider.name} history-only on native Windows; live POSIX hooks are unavailable`,
      );
      lines.push(
        `${provider.name} history ${provider.historyDirectories(context).some(existsSync) ? 'found' : 'not found yet'}`,
      );
      continue;
    }
    for (const validation of provider.validate(context)) {
      lines.push(validation.message);
      if (validation.level === 'attention') problems++;
    }
    lines.push(
      `${provider.name} history ${provider.historyDirectories(context).some(existsSync) ? 'found' : 'not found yet'}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return problems ? 1 : 0;
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
