import {
  closeSync,
  existsSync,
  type FSWatcher,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  watch,
} from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { ProviderAdapter, RecordParser } from '@salidium/adapter-kit';
import type { CanonicalEvent } from '@salidium/protocol';
import type { Logger } from '../logging/logger.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';
import type { SalidiumStore } from '../storage/salidiumStore.ts';
import { MAX_INGEST_PAYLOAD_BYTES } from './limits.ts';

interface TrackedSource {
  path: string;
  adapter: ProviderAdapter;
  sessionId: string;
  providerSessionId: string;
  agentId?: string;
  parser: RecordParser;
  offset: number;
  lineNo: number;
  inode?: number;
  remainder: Buffer;
  /** An over-limit unterminated record was warned about; ignore bytes until its newline. */
  discardingOversizedRecord: boolean;
  reading: boolean;
  dirty: boolean;
  lastActivity: number;
  /** False when the file was skipped as already-ingested; the first growth triggers a full re-parse. */
  parserSynced: boolean;
}

const CHUNK = 256 * 1024;
const NEWLINE = 0x0a;

/**
 * Tails provider session files by byte offset. Splits records on `\n` bytes only (matching the
 * writers), tolerates partial trailing lines, detects truncation/rotation via inode and size,
 * persists cursors so a restart resumes exactly, and yields to the event loop during backfills
 * so live sessions stay responsive.
 */
export class TranscriptTailer {
  private readonly adapters: ProviderAdapter[];
  private readonly registry: SessionRegistry;
  private readonly store: SalidiumStore;
  private readonly log: Logger;
  private readonly maxRecordBytes: number;
  private readonly rootDiscoveryIntervalMs: number;
  private readonly watchRoot: typeof watch;
  private readonly sources = new Map<string, TrackedSource>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly watcherRetryAfter = new Map<string, number>();
  private readonly discoveredRoots = new Set<string>();
  private readonly pokeTimers = new Map<string, NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private rootDiscoveryTimer: NodeJS.Timeout | undefined;
  private roots: string[] = [];
  private stopped = false;

  constructor(args: {
    adapters: ProviderAdapter[];
    registry: SessionRegistry;
    store: SalidiumStore;
    log: Logger;
    /** Test seam; production uses the shared 8 MiB hostile-input ceiling. */
    maxRecordBytes?: number;
    /** Test seam; production checks for newly-created provider roots once per second. */
    rootDiscoveryIntervalMs?: number;
    /** Test seam for filesystems where recursive watch attachment is unavailable. */
    watchRoot?: typeof watch;
  }) {
    this.adapters = args.adapters;
    this.registry = args.registry;
    this.store = args.store;
    this.log = args.log;
    this.maxRecordBytes = args.maxRecordBytes ?? MAX_INGEST_PAYLOAD_BYTES;
    this.rootDiscoveryIntervalMs = args.rootDiscoveryIntervalMs ?? 1000;
    this.watchRoot = args.watchRoot ?? watch;
  }

  get watchedCount(): number {
    return this.sources.size;
  }

  countForProvider(providerId: string): number {
    let n = 0;
    for (const s of this.sources.values()) if (s.adapter.id === providerId) n++;
    return n;
  }

  /** Starts watching provider roots and resolves after the initial recent-file backfill. */
  start(userHome: string, historyDays: number): Promise<void> {
    for (const adapter of this.adapters) {
      for (const root of adapter.sessionRoots(userHome)) {
        if (!this.roots.includes(root)) this.roots.push(root);
      }
    }
    this.ensureRootWatchers();
    // Explicit jobs are durable and bypass the ordinary age window. Process them before the
    // opportunistic recent-history scan so an adapter upgrade cannot strand old sessions.
    const initialBackfill = this.startBackfill(historyDays);
    this.sweepTimer = setInterval(() => this.sweepActive(), 2000);
    this.sweepTimer.unref?.();
    this.rescanTimer = setInterval(() => void this.scanRoots(historyDays, false), 60_000);
    this.rescanTimer.unref?.();
    this.rootDiscoveryTimer = setInterval(() => {
      if (this.ensureRootWatchers()) void this.scanRoots(historyDays, false);
    }, this.rootDiscoveryIntervalMs);
    this.rootDiscoveryTimer.unref?.();
    return initialBackfill;
  }

  private async startBackfill(historyDays: number): Promise<void> {
    await this.processReingestJobs();
    if (!this.stopped) await this.scanRoots(historyDays, true);
  }

  /** Attaches watchers to roots that appeared after startup and forgets roots that vanished. */
  private ensureRootWatchers(): boolean {
    if (this.stopped) return false;
    let needsScan = false;
    for (const root of this.roots) {
      if (existsSync(root)) {
        if (!this.discoveredRoots.has(root)) {
          this.discoveredRoots.add(root);
          needsScan = true;
        }
      } else {
        this.discoveredRoots.delete(root);
      }
    }
    for (const [root, watcher] of this.watchers) {
      if (existsSync(root)) continue;
      watcher.close();
      this.watchers.delete(root);
      this.watcherRetryAfter.delete(root);
    }
    for (const root of this.roots) {
      if (this.watchers.has(root) || !existsSync(root)) continue;
      if ((this.watcherRetryAfter.get(root) ?? 0) > Date.now()) continue;
      try {
        const watcher = this.watchRoot(root, { recursive: true }, (_event, filename) => {
          if (!filename || this.stopped) return;
          const path = join(root, filename.toString());
          if (this.adapters.some((adapter) => adapter.matchSessionFile(path))) this.poke(path);
        });
        watcher.on('error', (err) => {
          this.log.warn('fs.watch error', { root, err: String(err) });
          watcher.close();
          this.watchers.delete(root);
          this.watcherRetryAfter.set(root, Date.now() + 60_000);
        });
        this.watchers.set(root, watcher);
        this.watcherRetryAfter.delete(root);
        needsScan = true;
      } catch (err) {
        this.log.warn('fs.watch failed; relying on periodic sweeps', { root, err: String(err) });
        this.watcherRetryAfter.set(root, Date.now() + 60_000);
      }
    }
    return needsScan;
  }

  /** Ensures a specific file is tracked and read now (e.g. from a hook's transcript_path). */
  track(path: string): void {
    if (!this.adapters.some((a) => a.matchSessionFile(path))) return;
    this.poke(path, 0);
  }

  private poke(path: string, delayMs = 30): void {
    const existing = this.pokeTimers.get(path);
    if (existing) return;
    const t = setTimeout(() => {
      this.pokeTimers.delete(path);
      void this.readNow(path);
    }, delayMs);
    t.unref?.();
    this.pokeTimers.set(path, t);
  }

  private ensureTracked(path: string, forceFromStart = false): TrackedSource | undefined {
    const existing = this.sources.get(path);
    if (existing && !forceFromStart) return existing;
    if (existing?.reading) return undefined;
    if (existing) this.sources.delete(path);
    for (const adapter of this.adapters) {
      const m = adapter.matchSessionFile(path);
      if (!m) continue;
      const cursor = this.store.getSource(path);
      const parser = adapter.createRecordParser({
        sessionId: m.sessionId,
        providerSessionId: m.providerSessionId,
        agentId: m.agentId,
        path,
        observedAt: new Date().toISOString(),
      });
      // Parsers are stateful (a result record needs its call record), so a file is always parsed
      // from byte 0 and event-id dedupe makes re-ingest harmless. Files whose size and inode match
      // the persisted cursor are already fully ingested and are skipped until they grow; the first
      // growth triggers one full re-parse so parser state is complete.
      let alreadyIngested = false;
      if (cursor && cursor.byteOffset > 0) {
        try {
          const st = statSync(path);
          alreadyIngested =
            !forceFromStart && st.ino === cursor.inode && st.size === cursor.byteOffset;
        } catch {
          alreadyIngested = false;
        }
      }
      const src: TrackedSource = {
        path,
        adapter,
        sessionId: m.sessionId,
        providerSessionId: m.providerSessionId,
        agentId: m.agentId,
        parser,
        offset: alreadyIngested ? (cursor?.byteOffset ?? 0) : 0,
        lineNo: alreadyIngested ? (cursor?.lineNo ?? 0) : 0,
        inode: cursor?.inode,
        remainder: Buffer.alloc(0),
        discardingOversizedRecord: false,
        reading: false,
        dirty: false,
        lastActivity: Date.now(),
        parserSynced: !alreadyIngested,
      };
      this.sources.set(path, src);
      return src;
    }
    return undefined;
  }

  private async readNow(
    path: string,
    opts: { forceFromStart?: boolean; fingerprintOrigin?: 'ingest' | 'backfill' } = {},
  ): Promise<boolean> {
    if (this.stopped) return false;
    const src = this.ensureTracked(path, opts.forceFromStart);
    if (!src) return false;
    if (src.reading) {
      src.dirty = true;
      return false;
    }
    src.reading = true;
    let complete = true;
    try {
      do {
        src.dirty = false;
        complete = (await this.readOnce(src, opts.fingerprintOrigin ?? 'ingest')) && complete;
      } while (src.dirty && !this.stopped);
    } catch (err) {
      this.log.warn('tail read failed', { path, err: String(err) });
      complete = false;
    } finally {
      src.reading = false;
    }
    return complete;
  }

  private async readOnce(
    src: TrackedSource,
    fingerprintOrigin: 'ingest' | 'backfill',
  ): Promise<boolean> {
    let fd: number;
    try {
      fd = openSync(src.path, 'r');
    } catch {
      return false; // deleted or unreadable
    }
    try {
      const st = fstatSync(fd);
      if ((src.inode !== undefined && st.ino !== src.inode) || st.size < src.offset) {
        // Rotated or truncated: start over; dedupe makes re-ingest harmless.
        src.offset = 0;
        src.lineNo = 0;
        src.remainder = Buffer.alloc(0);
        src.discardingOversizedRecord = false;
        src.parser = src.adapter.createRecordParser({
          sessionId: src.sessionId,
          providerSessionId: src.providerSessionId,
          agentId: src.agentId,
          path: src.path,
          observedAt: new Date().toISOString(),
        });
        src.parserSynced = true;
      }
      src.inode = st.ino;
      if (st.size === src.offset) return true;
      if (!src.parserSynced) {
        // Skipped as already-ingested but it grew: parse from the start so parser state is complete.
        src.offset = 0;
        src.lineNo = 0;
        src.remainder = Buffer.alloc(0);
        src.discardingOversizedRecord = false;
        src.parser = src.adapter.createRecordParser({
          sessionId: src.sessionId,
          providerSessionId: src.providerSessionId,
          agentId: src.agentId,
          path: src.path,
          observedAt: new Date().toISOString(),
        });
        src.parserSynced = true;
      }
      const buf = Buffer.allocUnsafe(CHUNK);
      let position = src.offset;
      let batches = 0;
      while (position < st.size && !this.stopped) {
        const n = readSync(fd, buf, 0, CHUNK, position);
        if (n <= 0) break;
        position += n;
        const incoming = buf.subarray(0, n);
        let incomingStart = 0;
        const events: CanonicalEvent[] = [];
        if (src.discardingOversizedRecord) {
          const nl = incoming.indexOf(NEWLINE);
          if (nl === -1) {
            // The warning was emitted when the limit was crossed. Advance without retaining any
            // of this hostile newline-free record; memory stays bounded by the fixed read chunk.
            src.offset = position;
            src.lastActivity = Date.now();
            if (++batches % 4 === 0) await yieldToLoop();
            continue;
          }
          src.discardingOversizedRecord = false;
          src.lineNo += 1;
          incomingStart = nl + 1;
        }
        const remaining = incoming.subarray(incomingStart);
        const data = src.remainder.length
          ? Buffer.concat([src.remainder, remaining])
          : Buffer.from(remaining);
        let start = 0;
        for (;;) {
          const nl = data.indexOf(NEWLINE, start);
          if (nl === -1) break;
          const length = nl - start;
          if (length > this.maxRecordBytes) {
            events.push(this.oversizedRecordWarning(src));
          } else {
            const line = data.subarray(start, nl).toString('utf8');
            try {
              const evs = src.parser.parseRecord(line, src.lineNo);
              if (evs.length) events.push(...evs);
            } catch (err) {
              this.log.warn('parser threw', { path: src.path, line: src.lineNo, err: String(err) });
            }
          }
          src.lineNo += 1;
          start = nl + 1;
        }
        // Everything read so far is either parsed or held in `remainder`; the file offset
        // advances to `position` so partial-line bytes are never read from disk twice.
        const tail = data.subarray(start);
        if (tail.length > this.maxRecordBytes) {
          events.push(this.oversizedRecordWarning(src));
          src.remainder = Buffer.alloc(0);
          src.discardingOversizedRecord = true;
        } else {
          src.remainder = Buffer.from(tail);
        }
        src.offset = position;
        if (events.length) this.registry.ingest(src.sessionId, events, { fingerprintOrigin });
        src.lastActivity = Date.now();
        if (++batches % 4 === 0) await yieldToLoop();
      }
      // The cursor is the recovery boundary. Persist every accepted event before advancing it;
      // otherwise a process exit in the coordinator's write-behind window makes the file look
      // fully ingested even though its newest events never reached SQLite. A failed flush leaves
      // the older cursor in place, so restart/retry safely re-parses and dedupes the records.
      if (!this.registry.flush(src.sessionId)) return false;
      this.store.upsertSource({
        path: src.path,
        sessionId: src.sessionId,
        provider: src.adapter.id,
        agentId: src.agentId,
        inode: src.inode,
        byteOffset: src.offset,
        lineNo: src.lineNo,
      });
      return true;
    } finally {
      closeSync(fd);
    }
  }

  private async processReingestJobs(): Promise<void> {
    const jobs = this.store.pendingReingestJobs();
    if (jobs.length) this.log.info('re-ingesting transcript evidence', { files: jobs.length });
    for (const job of jobs) {
      if (this.stopped) return;
      this.store.startReingestJob(job.id);
      if (!existsSync(job.path)) {
        this.store.finishReingestJob(job.id, 'missing', 'provider file no longer exists');
        this.log.warn('re-ingest source missing', { path: job.path, sessionId: job.sessionId });
        continue;
      }
      const matched = this.adapters.some((adapter) => adapter.matchSessionFile(job.path));
      if (!matched) {
        this.store.finishReingestJob(job.id, 'failed', 'no enabled adapter accepts this path');
        continue;
      }
      const complete = await this.readNow(job.path, {
        forceFromStart: true,
        fingerprintOrigin: 'backfill',
      });
      this.store.finishReingestJob(
        job.id,
        complete ? 'completed' : 'failed',
        complete ? undefined : 'read or persistence failed; retry on next daemon start',
      );
    }
  }

  private oversizedRecordWarning(src: TrackedSource): CanonicalEvent {
    this.log.warn('oversized transcript record skipped', {
      path: src.path,
      line: src.lineNo,
      limitBytes: this.maxRecordBytes,
    });
    return {
      id: `${src.sessionId}#ingest:warning:truncated-record:${src.lineNo}`,
      sessionId: src.sessionId,
      ts: new Date().toISOString(),
      tsSource: 'ingest',
      source: {
        provider: src.adapter.id,
        channel: src.adapter.id === 'codex' ? 'rollout' : 'transcript',
        ref: { path: src.path, line: src.lineNo },
      },
      kind: 'ingest.warning',
      code: 'truncated-record',
      detail: `provider record exceeded ${this.maxRecordBytes} bytes and was skipped`,
    };
  }

  private sweepActive(): void {
    if (this.stopped) return;
    const now = Date.now();
    for (const src of this.sources.values()) {
      // Only stat files touched in the last hour; older ones rely on fs.watch and rescans.
      if (now - src.lastActivity > 60 * 60_000) continue;
      try {
        const st = statSync(src.path);
        if (st.size !== src.offset || st.ino !== src.inode) this.poke(src.path, 0);
      } catch {
        /* gone */
      }
    }
  }

  private async scanRoots(historyDays: number, initial: boolean): Promise<void> {
    this.ensureRootWatchers();
    const cutoff = Date.now() - historyDays * 24 * 60 * 60_000;
    const found: Array<{ path: string; mtime: number }> = [];
    for (const root of this.roots) {
      for (const path of walk(root)) {
        if (!this.adapters.some((a) => a.matchSessionFile(path))) continue;
        try {
          const st = statSync(path);
          if (st.mtimeMs >= cutoff) found.push({ path, mtime: st.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    if (initial) this.log.info('backfilling transcripts', { files: found.length, historyDays });
    for (const f of found) {
      if (this.stopped) return;
      if (!initial && this.sources.has(f.path)) continue;
      await this.readNow(f.path);
    }
    if (initial) this.log.info('backfill complete', { files: found.length });
  }

  stop(): void {
    this.stopped = true;
    for (const watcher of this.watchers.values()) watcher.close();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    if (this.rootDiscoveryTimer) clearInterval(this.rootDiscoveryTimer);
    for (const t of this.pokeTimers.values()) clearTimeout(t);
  }
}

function* walk(dir: string): Generator<string> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}
