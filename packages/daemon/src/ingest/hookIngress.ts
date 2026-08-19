import {
  closeSync,
  existsSync,
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
import { CanonicalTimestampSchema, type ProviderId } from '@salidium/protocol';
import type { Logger } from '../logging/logger.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';
import {
  MAX_HOOK_SPOOL_RECORD_BYTES,
  MAX_INGEST_PAYLOAD_BYTES,
  TRUNCATED_HOOK_PAYLOAD_KEY,
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
  private readonly userHome: string;
  private readonly maxPayloadBytes: number;
  private readonly maxSpoolRecordBytes: number;
  private spoolTimer: NodeJS.Timeout | undefined;
  private draining = false;

  constructor(args: {
    adapters: ProviderAdapter[];
    registry: SessionRegistry;
    tailer: TranscriptTailer;
    spoolDir: string;
    userHome: string;
    log: Logger;
    /** Test seams; production uses the shared hostile-input ceilings. */
    maxPayloadBytes?: number;
    maxSpoolRecordBytes?: number;
  }) {
    this.adapters = new Map(args.adapters.map((a) => [a.id, a]));
    this.registry = args.registry;
    this.tailer = args.tailer;
    this.spoolDir = args.spoolDir;
    this.userHome = args.userHome;
    this.log = args.log;
    this.maxPayloadBytes = args.maxPayloadBytes ?? MAX_INGEST_PAYLOAD_BYTES;
    this.maxSpoolRecordBytes = args.maxSpoolRecordBytes ?? MAX_HOOK_SPOOL_RECORD_BYTES;
  }

  /** Handles one hook payload; returns the number of events accepted. */
  handle(providerId: string, payload: unknown, receivedAt = new Date().toISOString()): number {
    if (
      payload !== null &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>)[TRUNCATED_HOOK_PAYLOAD_KEY] === true
    ) {
      this.log.warn('hook payload exceeded the relay limit and was skipped', {
        provider: providerId,
        limitBytes: this.maxPayloadBytes,
      });
      return 0;
    }
    const received = CanonicalTimestampSchema.safeParse(receivedAt);
    if (!received.success) {
      this.log.warn('hook envelope has a noncanonical receivedAt and was skipped', {
        provider: providerId,
      });
      return 0;
    }
    const adapter = this.adapters.get(providerId as ProviderId);
    if (!adapter) return 0;
    const transcript = adapter.transcriptPathFromHook(payload);
    const events = adapter.parseHookPayload(payload, { receivedAt: received.data });
    let accepted = 0;
    if (events.length) {
      const sessionId = events[0]?.sessionId;
      if (sessionId) {
        accepted = this.registry.ingest(sessionId, events, { cwd: transcript?.cwd });
        // HTTP success and spool deletion are recovery boundaries: do not let either discard the
        // relay's copy while this session still exists only in the coordinator's write-behind
        // queue. Throwing makes the HTTP relay spool its pending file and keeps a processing file
        // available for the next drain.
        if (!this.registry.flush(sessionId)) throw new Error('hook events are not durable yet');
      }
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
    return accepted;
  }

  /** Reads both atomic per-envelope payloads and legacy JSONL spools, deleting only durable work. */
  drainSpool(): void {
    if (this.draining) return;
    if (!existsSync(this.spoolDir)) return;
    this.draining = true;
    try {
      this.drainOrphanedPending();
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
          for (const item of boundedLines(processing, this.maxSpoolRecordBytes)) {
            if (item.oversized) {
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
    }
  }

  /**
   * A failed sender publishes `<unique>.ready.json` atomically; claim it with another rename before
   * reading. Plain `.json` files are legacy/in-flight payloads and remain protected by the 10 s
   * orphan grace period. Processing files survive daemon crashes and persistence failures.
   */
  private drainOrphanedPending(): void {
    const pending = join(this.spoolDir, 'pending');
    if (!existsSync(pending)) return;
    const cutoff = Date.now() - 10_000;
    const files = readdirSync(pending)
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
    for (const f of files) {
      const path = join(pending, f);
      const alreadyProcessing = f.endsWith('.processing');
      const processing = alreadyProcessing ? path : `${path}.processing`;
      try {
        const st = statSync(path);
        const ready = f.endsWith('.ready.json') || f.endsWith('.ready.json.processing');
        if (!ready && !alreadyProcessing && st.mtimeMs > cutoff) continue;
        if (!alreadyProcessing) {
          try {
            renameSync(path, processing);
          } catch {
            continue;
          }
        }
        const claimed = statSync(processing);
        if (claimed.size > this.maxPayloadBytes) {
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
          unlinkSync(processing);
          continue;
        }
        this.handle(provider, payload, claimed.mtime.toISOString());
        try {
          unlinkSync(processing);
        } catch {
          /* ignore */
        }
        this.log.info('recovered orphaned hook payload', { file: f });
      } catch (err) {
        // Persistence/processing failures can recover, so retain the relay's only remaining copy.
        this.log.warn('orphaned hook recovery deferred', { file: f, err: String(err) });
      }
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
    for (const id of this.adapters.keys())
      if (file.startsWith(`${id.replaceAll('/', '~')}_`)) return id;
    for (const id of this.adapters.keys()) if (file.startsWith(`${id}-`)) return id;
    return file.split('-')[0] ?? 'claude-code';
  }

  startSpoolWatcher(intervalMs = 5000): void {
    if (!existsSync(this.spoolDir)) mkdirSync(this.spoolDir, { recursive: true, mode: 0o700 });
    this.drainSpool();
    this.spoolTimer = setInterval(() => this.drainSpool(), intervalMs);
    this.spoolTimer.unref?.();
  }

  stop(): void {
    if (this.spoolTimer) clearInterval(this.spoolTimer);
  }
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
