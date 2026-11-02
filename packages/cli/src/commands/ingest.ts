import { existsSync, statfsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatBytes, basename as pathBasename } from '@salidium/core';
import {
  daemonPaths,
  inspectStoreLayout,
  readDaemonJson,
  runRetentionCompactionMaintenance,
  SqliteStore,
} from '@salidium/daemon';
import {
  type DaemonInfo,
  StorageDeletionPreviewSchema,
  StorageDeletionResultSchema,
  type StorageDeletionScope,
} from '@salidium/protocol';
import { auditClaims, renderAudit } from '../auditClaims.ts';
import { renderReport } from '../render.ts';
import { providerDisplayName, sessionSearchQuery } from '../showSession.ts';
import { liveStoreWriteBlocked, presenceOf, salidiumHome, storeHasWriter } from './shared.ts';
import { maintenanceCommand } from './status.ts';

export async function runShowCommand(arg: string | undefined, argv: string[]): Promise<number> {
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

export function runAuditClaimsCommand(argv: string[]): number {
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

export async function runReingestCommand(arg: string | undefined, argv: string[]): Promise<number> {
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
      // A store-backed provider's cursor key is `<store path>#<session id>`, not a file.
      const hash = s.path.lastIndexOf('#');
      const file = hash > 0 && !existsSync(s.path) ? s.path.slice(0, hash) : s.path;
      if (!existsSync(file)) missing++;
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

export async function runRetentionCommand(arg: string | undefined): Promise<number> {
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

export async function runStorageCommand(
  arg: string | undefined,
  args: string[],
  options: { assumeYes: boolean; json: boolean; quiet: boolean },
): Promise<number> {
  const { db } = daemonPaths(salidiumHome);
  if (!existsSync(db)) {
    process.stderr.write(`no store at ${db}\n`);
    return 1;
  }
  if (
    arg !== undefined &&
    arg !== 'optimize' &&
    arg !== 'composition' &&
    arg !== 'forget' &&
    arg !== 'compact'
  ) {
    process.stderr.write('storage accepts `composition`, `forget`, `compact`, or `optimize`\n');
    return 2;
  }
  if (arg === 'forget') {
    const forgetAll = args.includes('--all');
    let projectTarget: string | undefined;
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (!token) continue;
      if (token.startsWith('--project=')) {
        projectTarget = token.slice('--project='.length);
        break;
      }
      if (token === '--project') {
        projectTarget = args[i + 1];
        break;
      }
    }
    if ((forgetAll && projectTarget !== undefined) || (!forgetAll && projectTarget === undefined)) {
      process.stderr.write('usage: salidium storage forget (--project PATH | --all) [--yes]\n');
      return 2;
    }
    const scope: StorageDeletionScope = forgetAll
      ? { kind: 'all' }
      : {
          kind: 'project',
          project: projectTarget === '' ? '' : resolve(projectTarget ?? ''),
        };
    const daemon = readDaemonJson(salidiumHome);
    const presence = await presenceOf(daemon);
    if (presence === 'unresponsive') {
      process.stderr.write(
        'the daemon is running but not answering; stop Salidium before deleting history\n',
      );
      return 2;
    }
    if (!options.assumeYes) {
      let preview: ReturnType<SqliteStore['previewStorageDeletion']>;
      if (daemon && presence === 'reachable') {
        const response = await fetch(
          `http://127.0.0.1:${daemon.port}/api/operations/storage/preview`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${daemon.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(scope),
            signal: AbortSignal.timeout(5_000),
          },
        );
        if (!response.ok) {
          process.stderr.write(`daemon refused storage preview (${response.status})\n`);
          return 1;
        }
        preview = StorageDeletionPreviewSchema.parse(await response.json());
      } else {
        const store = new SqliteStore(db, { concurrentWriter: true });
        try {
          preview = store.previewStorageDeletion(scope);
        } finally {
          store.close();
        }
      }
      if (!options.quiet) {
        if (options.json) {
          process.stdout.write(`${JSON.stringify(preview)}\n`);
        } else {
          const range =
            preview.oldestAt && preview.newestAt
              ? ` (${preview.oldestAt.slice(0, 10)} to ${preview.newestAt.slice(0, 10)})`
              : '';
          const targetLabel =
            scope.kind === 'all'
              ? 'all recorded history'
              : scope.project || 'sessions with no recorded project';
          process.stdout.write(
            `Preview for ${targetLabel}: ${preview.sessions} session${preview.sessions === 1 ? '' : 's'}, ${preview.eventCount.toLocaleString()} events, ${formatBytes(preview.bytes)}${range}.\nRe-run with --yes to delete ${preview.sessions === 1 ? 'this session' : `these ${preview.sessions} sessions`}.\n`,
          );
        }
      }
      return 0;
    }
    if (daemon && presence === 'reachable') {
      const response = await fetch(
        `http://127.0.0.1:${daemon.port}/api/operations/storage/delete`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${daemon.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ scope }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        process.stderr.write(`daemon refused storage deletion (${response.status})\n`);
        return 1;
      }
      const result = StorageDeletionResultSchema.parse(await response.json());
      if (!options.quiet) {
        if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
        else
          process.stdout.write(
            `Forgot ${result.removedSessions} session${result.removedSessions === 1 ? '' : 's'} (${result.removedEvents.toLocaleString()} events, ${formatBytes(result.removedBytes)}). Run \`salidium storage compact\` to return reusable space to disk.\n`,
          );
      }
      return 0;
    }
    const store = new SqliteStore(db);
    try {
      const applied = store.applyStorageDeletion(scope);
      if (applied.status !== 'deleted') return 1;
      const result = applied.result;
      if (!options.quiet) {
        if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
        else
          process.stdout.write(
            `Forgot ${result.removedSessions} session${result.removedSessions === 1 ? '' : 's'} (${result.removedEvents.toLocaleString()} events, ${formatBytes(result.removedBytes)}). Run \`salidium storage compact\` to return reusable space to disk.\n`,
          );
      }
      return 0;
    } finally {
      store.close();
    }
  }
  if (arg === 'compact') {
    return maintenanceCommand('compact', args, { json: options.json, quiet: options.quiet });
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
      if (options.json) {
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
    if (options.quiet) return layout.optimized ? 0 : 3;
    if (options.json) process.stdout.write(`${JSON.stringify(layout)}\n`);
    else {
      const store = new SqliteStore(db, { concurrentWriter: true });
      let measured: ReturnType<SqliteStore['storageComposition']> | undefined;
      try {
        measured = store.storageComposition();
      } finally {
        store.close();
      }
      const reusable = measured?.parts.find((part) => part.key === 'reusable')?.bytes ?? 0;
      process.stdout.write(
        `Total on disk: ${formatBytes(measured?.fileBytes ?? 0)} · Reusable space: ${formatBytes(reusable)}\n`,
      );
      process.stdout.write(`Layout: ${layout.optimized ? 'Optimized' : 'Legacy'}\n`);
      process.stdout.write(`Page size: ${formatBytes(layout.pageSize)}\n`);
      process.stdout.write(
        `Events: ${layout.eventsWithoutRowid ? 'WITHOUT ROWID' : 'rowid table'}, ${layout.eventJsonType ?? 'unknown'} payload\n`,
      );
      process.stdout.write(`Checkpoints: ${layout.checkpointType ?? 'unknown'} payload\n`);
      if (measured && measured.projects.length > 0) {
        process.stdout.write(
          `Projects (${measured.sessions ?? 0} sessions across ${measured.projects.length + measured.projectsOmitted} projects):\n`,
        );
        for (const project of measured.projects) {
          process.stdout.write(
            `  ${formatBytes(project.bytes).padStart(9)}  ${String(project.sessions).padStart(4)} ${project.sessions === 1 ? 'session ' : 'sessions'}  ${project.path || 'No project recorded'}\n`,
          );
        }
        if (measured.projectsOmitted > 0)
          process.stdout.write(`  ${measured.projectsOmitted} more not listed.\n`);
      }
      if (!layout.optimized)
        process.stdout.write(
          'Lossless optimization is available. Run `salidium storage optimize`; it coordinates queue drain and daemon stop.\n',
        );
    }
    return layout.optimized ? 0 : 3;
  }
  return maintenanceCommand('optimize', args, { json: options.json, quiet: options.quiet });
}

export async function runPinCommand(
  cmd: 'pin' | 'unpin',
  arg: string | undefined,
): Promise<number> {
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

export async function runForgetCommand(
  arg: string | undefined,
  assumeYes: boolean,
): Promise<number> {
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
