import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { normalizeProviderTimestamp, type ProviderAdapter } from '@salidium/adapter-kit';
import { CanonicalTimestampSchema, type ProviderId, ProviderIdSchema } from '@salidium/protocol';
import type { Logger } from '../logging/logger.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';
import {
  archiveCollectionGap,
  COLLECTION_GAP_LEDGER_FILE,
  recordCollectionGap,
} from './collectionGaps.ts';
import {
  HOOK_BREAKER_FILE,
  HOOK_SHED_FIRST_FILE,
  HOOK_SHED_RETAIN_FILE,
  HOOK_SHED_SECOND_FILE,
  MAX_HOOK_PENDING_FILES,
  MAX_HOOK_SHED_FIRST_PENDING_FILES,
  MAX_HOOK_SHED_SECOND_PENDING_FILES,
  MAX_HOOK_SPOOL_RECORD_BYTES,
  MAX_INGEST_PAYLOAD_BYTES,
  MAX_QUARANTINED_FILES,
  MAX_SPOOL_DRAIN_BATCH,
  TRUNCATED_HOOK_PAYLOAD_KEY,
  UNATTRIBUTED_SUFFIX,
} from './limits.ts';
import type { TranscriptTailer } from './transcriptTailer.ts';

/**
 * Turns hook payloads (from the relay's HTTP POST, or from spool files the relay wrote while the
 * daemon was down) into canonical events. Also uses the payload's transcript_path to start
 * tailing the session file, which is how a brand-new session becomes visible within one hook.
 */
export class HookIngress {
  private readonly adapters: Map<ProviderId, ProviderAdapter>;
  private readonly registry: SessionRegistry;
  private readonly tailer: TranscriptTailer;
  private readonly log: Logger;
  private readonly spoolDir: string;
  private readonly breakerFile: string;
  private readonly gapLedgerFile: string;
  private readonly userHome: string;
  private readonly maxPayloadBytes: number;
  private readonly maxSpoolRecordBytes: number;
  private readonly maxQuarantinedFiles: number;
  /**
   * Whether the current full-quarantine episode already has its gap. Held in memory, so a restart
   * during one long episode records it once more; a durable marker would be the alternative.
   */
  private quarantineFullRecorded = false;
  private readonly collectionEnabled: () => boolean;
  private spoolTimer: NodeJS.Timeout | undefined;
  /** Set only while a capped drain pass has more of the same backlog still to read. */
  private catchUp: NodeJS.Timeout | undefined;
  private draining = false;

  constructor(args: {
    adapters: ProviderAdapter[];
    registry: SessionRegistry;
    tailer: TranscriptTailer;
    spoolDir: string;
    /** Relay breaker sentinel, cleared once a drain leaves the spool under its ceiling. */
    breakerFile: string;
    /** Bounded durable history of pressure episodes. */
    gapLedgerFile?: string;
    userHome: string;
    log: Logger;
    /** Test seams; production uses the shared hostile-input ceilings. */
    maxPayloadBytes?: number;
    maxSpoolRecordBytes?: number;
    maxQuarantinedFiles?: number;
    /** Dynamic collection gate shared with transcript ingest. */
    collectionEnabled?: () => boolean;
  }) {
    this.adapters = new Map(args.adapters.map((a) => [a.id, a]));
    this.registry = args.registry;
    this.tailer = args.tailer;
    this.spoolDir = args.spoolDir;
    this.breakerFile = args.breakerFile;
    this.gapLedgerFile =
      args.gapLedgerFile ?? join(dirname(args.breakerFile), COLLECTION_GAP_LEDGER_FILE);
    this.userHome = args.userHome;
    this.log = args.log;
    this.maxPayloadBytes = args.maxPayloadBytes ?? MAX_INGEST_PAYLOAD_BYTES;
    this.maxSpoolRecordBytes = args.maxSpoolRecordBytes ?? MAX_HOOK_SPOOL_RECORD_BYTES;
    this.maxQuarantinedFiles = args.maxQuarantinedFiles ?? MAX_QUARANTINED_FILES;
    this.collectionEnabled = args.collectionEnabled ?? (() => true);
  }

  /** Handles one hook payload; returns the number of events accepted. */
  handle(providerId: string, payload: unknown, receivedAt = new Date().toISOString()): number {
    if (!this.collectionEnabled()) return 0;
    const received = CanonicalTimestampSchema.safeParse(receivedAt);
    if (!received.success) {
      this.recordObservedGap('hook-envelope-invalid-timestamp', providerId, null);
      this.log.warn('hook envelope has a noncanonical receivedAt and was skipped', {
        provider: providerId,
      });
      return 0;
    }
    if (
      payload !== null &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>)[TRUNCATED_HOOK_PAYLOAD_KEY] === true
    ) {
      this.recordObservedGap('hook-payload-truncated', providerId, received.data);
      this.log.warn('hook payload exceeded the relay limit and was skipped', {
        provider: providerId,
        limitBytes: this.maxPayloadBytes,
      });
      return 0;
    }
    const outcome = this.ingestPayload(providerId, payload, received.data);
    // HTTP success and spool deletion are recovery boundaries: do not let either discard the
    // relay's copy while this session still exists only in the coordinator's write-behind
    // queue. Throwing makes the HTTP relay spool its pending file and keeps a processing file
    // available for the next drain.
    if (outcome.sessionId && !this.registry.flush(outcome.sessionId))
      throw new Error('hook events are not durable yet');
    return outcome.accepted;
  }

  /**
   * The half of `handle` that stops short of the durability boundary, so a drain can ingest a whole
   * batch and then flush each touched session once instead of opening one transaction per envelope.
   * Callers must flush the returned session before treating the payload's source as discardable.
   */
  private ingestPayload(
    providerId: string,
    payload: unknown,
    receivedAt: string,
  ): { accepted: number; sessionId?: string } {
    const adapter = this.adapters.get(providerId as ProviderId);
    if (!adapter)
      throw new Error(`provider ${providerId} is not enabled; the durable payload was retained`);
    const transcript = adapter.transcriptPathFromHook(payload);
    const events = adapter.parseHookPayload(payload, { receivedAt });
    let accepted = 0;
    let sessionId: string | undefined;
    if (events.length) {
      sessionId = events[0]?.sessionId;
      if (sessionId) accepted = this.registry.ingest(sessionId, events, { cwd: transcript?.cwd });
    }
    if (transcript) {
      // Only files under the provider's own state directories are ever tailed, whatever a hook
      // payload claims (payloads are authenticated but treated as untrusted input).
      const roots = adapter.sessionRoots(this.userHome).map((r) => resolveReal(r));
      for (const candidate of [transcript.path, (transcript as { agentPath?: string }).agentPath]) {
        if (!candidate) continue;
        const real = resolveReal(candidate);
        if (roots.some((root) => real === root || real.startsWith(`${root}${sep}`)))
          this.tailer.track(candidate);
        else this.log.warn('ignoring transcript_path outside provider roots', { path: candidate });
      }
    }
    return { accepted, sessionId };
  }

  /** Reads both atomic per-envelope payloads and legacy JSONL spools, deleting only durable work. */
  drainSpool(): void {
    if (!this.collectionEnabled()) return;
    if (this.draining) return;
    if (!existsSync(this.spoolDir)) {
      this.releasePressureMarkers();
      return;
    }
    this.draining = true;
    let more = false;
    try {
      more = this.drainOrphanedPending();
      const files = readdirSync(this.spoolDir)
        .filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.processing'))
        // Recover an interrupted drain before renaming a newer daily spool onto the same target.
        .sort((a, b) => {
          const ap = a.endsWith('.processing');
          const bp = b.endsWith('.processing');
          return ap === bp ? a.localeCompare(b) : ap ? -1 : 1;
        });
      for (const f of files) {
        const path = join(this.spoolDir, f);
        const alreadyProcessing = f.endsWith('.processing');
        const processing = alreadyProcessing ? path : `${path}.processing`;
        if (!alreadyProcessing) {
          // A failed older drain owns this target. Leave the new spool alone until it succeeds.
          if (existsSync(processing)) continue;
          try {
            renameSync(path, processing);
          } catch {
            continue;
          }
        }
        let complete = true;
        try {
          let count = 0;
          let lineNo = 0;
          for (const item of boundedLines(processing, this.maxSpoolRecordBytes)) {
            lineNo += 1;
            if (item.oversized) {
              this.recordObservedGap(
                'hook-spool-record-oversized',
                this.providerFromSpoolName(f),
                null,
                `legacy-spool-line-${lineNo}`,
              );
              this.log.warn('oversized hook spool record skipped', {
                file: f,
                limitBytes: this.maxSpoolRecordBytes,
              });
              continue;
            }
            const line = item.line;
            if (!line.trim()) continue;
            let rec: { provider?: string; receivedAt?: string; payload?: unknown };
            try {
              rec = JSON.parse(line) as typeof rec;
            } catch {
              // A malformed line cannot become valid on retry; preserve the remaining valid lines.
              this.recordObservedGap(
                'hook-spool-record-malformed',
                this.providerFromSpoolName(f),
                null,
                `legacy-spool-line-${lineNo}`,
              );
              continue;
            }
            try {
              const provider = rec.provider ?? this.providerFromSpoolName(f);
              // Older relays emitted valid RFC 3339 without milliseconds. Recover those by
              // normalizing at the legacy-envelope boundary; `handle` itself remains strict so
              // every adapter receives the canonical contract and locale/local strings stay out.
              const receivedAt = rec.receivedAt
                ? normalizeProviderTimestamp(rec.receivedAt)
                : new Date().toISOString();
              if (!receivedAt) {
                this.recordObservedGap(
                  'hook-envelope-invalid-timestamp',
                  provider,
                  null,
                  `legacy-spool-line-${lineNo}`,
                );
                this.log.warn('hook spool envelope has an invalid receivedAt and was skipped', {
                  file: f,
                });
                continue;
              }
              this.handle(provider, rec.payload ?? rec, receivedAt);
              count++;
            } catch (err) {
              complete = false;
              this.log.warn('hook spool drain deferred', { file: f, err: String(err) });
              break;
            }
          }
          if (count) this.log.info('drained hook spool', { file: f, payloads: count });
        } catch {
          complete = false;
        }
        if (complete) {
          try {
            unlinkSync(processing);
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      this.draining = false;
      this.releasePressureMarkers();
    }
    // A capped pass left work behind. Come back on the next tick of the event loop rather than at
    // the next poll, so a large backlog still clears quickly without ever holding the loop.
    if (more && this.spoolTimer && !this.catchUp) {
      this.catchUp = setTimeout(() => {
        this.catchUp = undefined;
        this.drainSpool();
      }, 25);
      this.catchUp.unref?.();
    }
  }

  /** Ready and claimed envelopes, counted the way the relay's own glob counts them. */
  private pendingCount(): number {
    const pending = join(this.spoolDir, 'pending');
    if (!existsSync(pending)) return 0;
    try {
      return readdirSync(pending).filter(
        (f) => f.endsWith('.ready.json') || f.endsWith('.ready.json.processing'),
      ).length;
    } catch {
      // Unreadable is not empty. Report the ceiling so the breaker stays closed.
      return MAX_HOOK_PENDING_FILES;
    }
  }

  /**
   * Lets hooks back in once the backlog is under the relay's ceiling. Tied to a finished drain and
   * not to startup on purpose: clearing the sentinel when the daemon comes up would re-admit every
   * hook at the moment the queue is at its worst and the daemon has not read any of it yet.
   */
  private releasePressureMarkers(): void {
    try {
      const pending = this.pendingCount();
      const home = dirname(this.breakerFile);
      const markers = [
        { path: join(home, HOOK_SHED_FIRST_FILE), threshold: MAX_HOOK_SHED_FIRST_PENDING_FILES },
        { path: join(home, HOOK_SHED_SECOND_FILE), threshold: MAX_HOOK_SHED_SECOND_PENDING_FILES },
        { path: join(home, HOOK_SHED_RETAIN_FILE), threshold: MAX_HOOK_PENDING_FILES },
        { path: join(home, HOOK_BREAKER_FILE), threshold: MAX_HOOK_PENDING_FILES },
      ];
      for (const marker of markers) {
        if (!existsSync(marker.path) || pending >= marker.threshold) continue;
        archiveCollectionGap(marker.path, this.gapLedgerFile);
        this.log.info('hook relay pressure cleared', { pending, threshold: marker.threshold });
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * A failed sender publishes `<unique>.ready.json` atomically; claim it with another rename before
   * reading. Plain `.json` files are legacy/in-flight payloads and remain protected by the 10 s
   * orphan grace period. Processing files survive daemon crashes and persistence failures.
   */
  private drainOrphanedPending(): boolean {
    const pending = join(this.spoolDir, 'pending');
    if (!existsSync(pending)) return false;
    const cutoff = Date.now() - 10_000;
    const listing = readdirSync(pending);
    const all = listing
      .filter(
        (f) =>
          f.endsWith('.ready.json') ||
          f.endsWith('.ready.json.processing') ||
          (f.endsWith('.json') && !f.endsWith('.oversized')) ||
          f.endsWith('.json.processing'),
      )
      .sort((a, b) => {
        const ap = a.endsWith('.processing');
        const bp = b.endsWith('.processing');
        return ap === bp ? a.localeCompare(b) : ap ? -1 : 1;
      });
    // Envelopes for a provider that is not enabled are retained on purpose: they were collected
    // while it was, and a reversible config change must not destroy them. But retaining them is
    // not the same as offering them to the drain. Every pass would claim the same ones, fail on
    // them, keep them, and -- because `.processing` sorts first -- refill the whole batch with
    // them, so an enabled provider's envelopes sat behind them and were never read at all while
    // the pass re-armed itself indefinitely. Set them aside before the batch is cut; they rejoin
    // it unchanged the moment their provider is enabled again.
    //
    // A name that carries no valid provider id is different. No configuration change can ever make
    // it drainable, so retaining it as though its provider were merely disabled kept it waiting
    // forever and pinned the queue's oldest item. It joins the batch only to be quarantined, and
    // only while the quarantine has room. Past that it stays where it is, still counted by the relay
    // and still waiting, and is kept out of the batch so it cannot crowd out drainable work.
    let quarantineRoom = Math.max(
      0,
      this.maxQuarantinedFiles - listing.filter((f) => quarantinedName(f)).length,
    );
    let unattributedLeft = 0;
    const drainable = all.filter((f) => {
      const provider = this.providerFromPendingName(f);
      if (attributable(provider)) return this.adapters.has(provider as ProviderId);
      if (quarantineRoom > 0) {
        quarantineRoom -= 1;
        return true;
      }
      unattributedLeft += 1;
      return false;
    });
    const retained = all.length - drainable.length - unattributedLeft;
    if (retained > 0)
      this.log.debug('retaining envelopes for providers that are not enabled', { files: retained });
    const files = drainable.slice(0, MAX_SPOOL_DRAIN_BATCH);
    const more = drainable.length > files.length;
    // Claimed envelopes whose events are ingested but not yet proven durable. Nothing here may be
    // deleted until its session flushes, so a failed batch still leaves the relay's only copy.
    const claimedBatch: { file: string; processing: string; sessionId?: string }[] = [];
    const touched = new Set<string>();
    let recovered = 0;
    let earliestUnattributed: string | undefined;
    for (const f of files) {
      const path = join(pending, f);
      const alreadyProcessing = f.endsWith('.processing');
      const processing = alreadyProcessing ? path : `${path}.processing`;
      try {
        const st = statSync(path);
        const ready = f.endsWith('.ready.json') || f.endsWith('.ready.json.processing');
        if (!ready && !alreadyProcessing && st.mtimeMs > cutoff) continue;
        if (!attributable(this.providerFromPendingName(f))) {
          const queuedAt = st.mtime.toISOString();
          if (
            this.quarantineUnattributed(pending, f) &&
            (!earliestUnattributed || queuedAt < earliestUnattributed)
          )
            earliestUnattributed = queuedAt;
          continue;
        }
        if (!alreadyProcessing) {
          try {
            renameSync(path, processing);
          } catch {
            continue;
          }
        }
        const claimed = statSync(processing);
        if (claimed.size > this.maxPayloadBytes) {
          this.recordObservedGap(
            'hook-payload-oversized',
            this.providerFromPendingName(f),
            claimed.mtime.toISOString(),
          );
          const quarantined = `${processing}.oversized`;
          renameSync(processing, quarantined);
          this.log.warn('oversized orphaned hook payload quarantined', {
            file: f,
            limitBytes: this.maxPayloadBytes,
            quarantined,
          });
          continue;
        }
        const provider = this.providerFromPendingName(f);
        let payload: unknown;
        try {
          payload = JSON.parse(readFileSync(processing, 'utf8')) as unknown;
        } catch {
          // A truncated/malformed pending file cannot become valid on retry.
          this.recordObservedGap('hook-payload-malformed', provider, claimed.mtime.toISOString());
          unlinkSync(processing);
          continue;
        }
        const { sessionId } = this.ingestPayload(provider, payload, claimed.mtime.toISOString());
        if (sessionId) touched.add(sessionId);
        claimedBatch.push({ file: f, processing, sessionId });
      } catch (err) {
        // Persistence/processing failures can recover, so retain the relay's only remaining copy.
        this.log.warn('orphaned hook recovery deferred', { file: f, err: String(err) });
      }
    }

    this.recordUnattributedGaps(earliestUnattributed, unattributedLeft);

    // One transaction per session in the batch rather than one per envelope. A large backlog
    // spread across a few sessions is the common shape, so this is the difference between one
    // commit per queued file and one per session.
    const undurable = new Set<string>();
    for (const sessionId of touched) {
      try {
        if (!this.registry.flush(sessionId)) undurable.add(sessionId);
      } catch (err) {
        undurable.add(sessionId);
        this.log.warn('hook batch flush failed; envelopes retained', {
          sessionId,
          err: String(err),
        });
      }
    }
    for (const item of claimedBatch) {
      if (item.sessionId && undurable.has(item.sessionId)) continue;
      try {
        unlinkSync(item.processing);
        recovered++;
      } catch {
        /* ignore */
      }
    }
    // One line per pass. Per-file logging made a large recovery write a log entry per envelope,
    // and the rotation check stats the file on every line.
    if (recovered || undurable.size)
      this.log.info('recovered orphaned hook payloads', {
        recovered,
        sessions: touched.size,
        deferred: claimedBatch.length - recovered,
        remaining: more,
      });
    return more;
  }

  /**
   * Sets aside an envelope whose name says nothing about which provider produced it. Its payload is
   * not read, because attributing it from untrusted content would be a guess presented as fact, and
   * it is not deleted, because it may be the only copy of real evidence. A hard link claims the
   * quarantine name: unlike a rename it fails on an existing file instead of replacing it, so one
   * quarantined envelope can never overwrite another. Returns whether the envelope was set aside.
   */
  private quarantineUnattributed(pending: string, file: string): boolean {
    const source = join(pending, file);
    const quarantined = `${source}${UNATTRIBUTED_SUFFIX}`;
    try {
      linkSync(source, quarantined);
    } catch (err) {
      this.log.warn('hook envelope without a provider was left in place', {
        file,
        err: String(err),
      });
      return false;
    }
    try {
      unlinkSync(source);
    } catch {
      // Gone already. The quarantined link holds the same file, which is all that must survive.
    }
    this.log.warn('hook envelope without a provider quarantined', { file, quarantined });
    return true;
  }

  /**
   * One gap per pass rather than one per file: the ledger keeps a bounded number of episodes, and a
   * single pass of unattributed files must not evict the pressure gaps already in it. The files
   * themselves are the exact count, in queue inspection. Gaps are recorded after the renames, so a
   * crash between them leaves quarantined files without their gap. They are still counted there.
   */
  private recordUnattributedGaps(earliest: string | undefined, left: number): void {
    try {
      if (earliest) this.recordObservedGap('hook-envelope-unattributed', null, earliest);
      if (left === 0) this.quarantineFullRecorded = false;
      else if (!this.quarantineFullRecorded) {
        this.recordObservedGap('hook-quarantine-full', null, null);
        this.quarantineFullRecorded = true;
        this.log.warn('hook quarantine is full; unattributed envelopes left in place', {
          files: left,
          limit: this.maxQuarantinedFiles,
        });
      }
    } catch (err) {
      this.log.warn('unattributed hook envelopes were not recorded as a gap', { err: String(err) });
    }
  }

  private providerFromSpoolName(file: string): string {
    const stem = file.replace(/\.processing$/, '');
    for (const id of this.adapters.keys()) if (stem.startsWith(`${id}.`)) return id;
    return stem.split('.')[0] ?? 'claude-code';
  }

  private providerFromPendingName(file: string): string {
    // Current relays encode the one namespacing slash as `~` and use `_` as a separator. Both
    // characters are excluded by ProviderIdSchema, making this reversible without letting one
    // provider id become a path. Keep accepting the old `id-...` form for built-in spool files.
    const separator = file.indexOf('_');
    if (separator > 0) return file.slice(0, separator).replaceAll('~', '/');
    for (const id of this.adapters.keys())
      if (file.startsWith(`${id.replaceAll('/', '~')}_`)) return id;
    for (const id of this.adapters.keys()) if (file.startsWith(`${id}-`)) return id;
    for (const id of ['claude-code', 'codex']) if (file.startsWith(`${id}-`)) return id;
    return file.split('-')[0] ?? 'claude-code';
  }

  private recordObservedGap(
    reason: string,
    provider: string | null,
    firstDroppedAt: string | null,
    event: string | null = null,
  ): void {
    recordCollectionGap(this.gapLedgerFile, {
      reason,
      provider,
      event,
      pressure: null,
      firstDroppedAt,
      exactCount: null,
    });
  }

  startSpoolWatcher(intervalMs = 5000): void {
    if (!existsSync(this.spoolDir)) mkdirSync(this.spoolDir, { recursive: true, mode: 0o700 });
    // The poll is installed before the first pass, not after it. A capped pass only chains into the
    // next one while this watcher is running, and startup is exactly when the backlog is largest:
    // draining first would leave the recovery waiting a full interval between its own batches.
    // Re-entry is already prevented by `draining`.
    this.spoolTimer = setInterval(() => this.drainSpool(), intervalMs);
    this.spoolTimer.unref?.();
    this.drainSpool();
  }

  stop(): void {
    if (this.spoolTimer) clearInterval(this.spoolTimer);
    this.spoolTimer = undefined;
    if (this.catchUp) clearTimeout(this.catchUp);
    this.catchUp = undefined;
  }
}

/** Files set aside from the drain: oversized payloads and envelopes that name no provider. */
function quarantinedName(file: string): boolean {
  return file.endsWith('.oversized') || file.endsWith(UNATTRIBUTED_SUFFIX);
}

/** Whether a name-derived provider is one any adapter could ever own. */
function attributable(provider: string): boolean {
  return ProviderIdSchema.safeParse(provider).success;
}

type BoundedLine = { line: string; oversized?: false } | { oversized: true };

/** Streams newline-delimited spool records without ever retaining more than limit + one chunk. */
function* boundedLines(path: string, limit: number): Generator<BoundedLine> {
  const fd = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let remainder = Buffer.alloc(0);
  let discarding = false;
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) break;
      const incoming = chunk.subarray(0, n);
      let incomingStart = 0;
      if (discarding) {
        const nl = incoming.indexOf(0x0a);
        if (nl === -1) continue;
        discarding = false;
        incomingStart = nl + 1;
      }
      const remaining = incoming.subarray(incomingStart);
      const data = remainder.length
        ? Buffer.concat([remainder, remaining])
        : Buffer.from(remaining);
      let start = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, start);
        if (nl === -1) break;
        if (nl - start > limit) yield { oversized: true };
        else yield { line: data.subarray(start, nl).toString('utf8') };
        start = nl + 1;
      }
      const tail = data.subarray(start);
      if (tail.length > limit) {
        yield { oversized: true };
        remainder = Buffer.alloc(0);
        discarding = true;
      } else {
        remainder = Buffer.from(tail);
      }
    }
    if (remainder.length) yield { line: remainder.toString('utf8') };
  } finally {
    closeSync(fd);
  }
}

function resolveReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Not created yet (a brand-new session): resolve the parent instead.
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}
