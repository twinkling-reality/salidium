import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type CanonicalEvent, makeEventId, type StoredEvent } from '@salidium/protocol';
import type { Logger } from '../logging/logger.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';

const run = promisify(execFile);

/**
 * Read-only git observation at turn boundaries for LIVE sessions only: HEAD, branch, and dirty
 * paths. Emitted as `git.snapshot` events (observed by Salidium) so commit-aware session diffs
 * and "changes not attributable to a tool call" are possible. Never writes to the repo and never
 * runs for historical backfills (the repo now says nothing about the repo then).
 */
export class GitSnapshotEnricher {
  private readonly registry: SessionRegistry;
  private readonly log: Logger;
  private readonly inFlight = new Set<string>();
  private readonly lastRun = new Map<string, number>();
  private unsubscribe: (() => void) | undefined;

  constructor(registry: SessionRegistry, log: Logger) {
    this.registry = registry;
    this.log = log;
  }

  start(): void {
    this.unsubscribe = this.registry.subscribeAll((sessionId, events) => {
      const trigger = events.find(
        (e) =>
          e.kind === 'turn.ended' ||
          e.kind === 'session.started' ||
          (e.kind === 'tool.completed' &&
            e.result.kind === 'command' &&
            e.result.gitOperation?.commit),
      );
      if (!trigger) return;
      const age = Date.now() - Date.parse(trigger.ts);
      if (Number.isNaN(age) || age > 120_000) return; // not live
      void this.snapshot(sessionId, trigger);
    });
  }

  private async snapshot(sessionId: string, trigger: StoredEvent): Promise<void> {
    if (this.inFlight.has(sessionId)) return;
    const last = this.lastRun.get(sessionId) ?? 0;
    if (Date.now() - last < 3000) return;
    const cwd = this.registry.peek(sessionId)?.state.cwd;
    if (!cwd) return;
    this.inFlight.add(sessionId);
    this.lastRun.set(sessionId, Date.now());
    try {
      const top = await git(cwd, ['rev-parse', '--show-toplevel']);
      if (!top) return;
      const repoRoot = top.trim();
      const head = (await git(cwd, ['rev-parse', 'HEAD']))?.trim();
      const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
      const status =
        (await git(cwd, ['status', '--porcelain=v2', '--untracked-files=normal'])) ?? '';
      const dirty: Array<{ path: string; status: string }> = [];
      for (const line of status.split('\n')) {
        if (!line) continue;
        const parts = line.split(' ');
        if (line.startsWith('1 ') || line.startsWith('2 '))
          dirty.push({
            status: parts[1] ?? '',
            path: parts.slice(8).join(' ').split('\t')[0] ?? '',
          });
        else if (line.startsWith('u '))
          dirty.push({ status: 'U', path: parts.slice(10).join(' ') });
        else if (line.startsWith('? ')) dirty.push({ status: '?', path: line.slice(2) });
        if (dirty.length >= 200) break;
      }
      const event: CanonicalEvent = {
        id: makeEventId(sessionId, 'git', 'snapshot', trigger.seq),
        sessionId,
        ts: new Date().toISOString(),
        tsSource: 'ingest',
        turnId: trigger.turnId,
        source: { provider: trigger.source.provider, channel: 'salidium' },
        kind: 'git.snapshot',
        repoRoot,
        head: head || undefined,
        branch: branch && branch !== 'HEAD' ? branch : undefined,
        dirty,
        dirtyTruncated: dirty.length >= 200 || undefined,
      };
      this.registry.ingest(sessionId, [event]);
    } catch (err) {
      this.log.debug('git snapshot skipped', { sessionId, err: String(err) });
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  stop(): void {
    this.unsubscribe?.();
  }
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch {
    return undefined;
  }
}
