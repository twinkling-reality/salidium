import type { CanonicalEvent, StoredEvent } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../logging/logger.ts';
import type { SessionRegistry } from '../sessions/sessionRegistry.ts';
import { type GitObservation, GitSnapshotEnricher } from './gitSnapshot.ts';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const SESSION = 'codex:thread';
const quiet = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

function harness() {
  const subscribers: Array<(sessionId: string, events: StoredEvent[]) => void> = [];
  const ingested: CanonicalEvent[] = [];
  const registry = {
    subscribeAll(sub: (sessionId: string, events: StoredEvent[]) => void) {
      subscribers.push(sub);
      return () => {};
    },
    peek: () => ({ state: { cwd: '/repo' } }),
    ingest: (_sessionId: string, events: CanonicalEvent[]) => ingested.push(...events),
  } as unknown as SessionRegistry;
  // Each read waits until the test releases it, so a boundary can arrive mid-read.
  const reads: Array<(observation: GitObservation) => void> = [];
  const enricher = new GitSnapshotEnricher(registry, quiet, {
    now: () => NOW,
    minIntervalMs: 0,
    read: () => new Promise((resolve) => reads.push(resolve)),
  });
  enricher.start();
  let seq = 0;
  const emitFor = (
    session: string,
    ...events: Array<Partial<StoredEvent> & { kind: StoredEvent['kind'] }>
  ) =>
    subscribers[0]?.(
      session,
      events.map(
        (e) =>
          ({
            id: `e${seq}`,
            sessionId: session,
            ts: new Date(NOW - 1000).toISOString(),
            tsSource: 'provider',
            source: { provider: 'codex', channel: 'rollout' },
            seq: seq++,
            ...e,
          }) as StoredEvent,
      ),
    );
  const emit = (...events: Array<Partial<StoredEvent> & { kind: StoredEvent['kind'] }>) =>
    emitFor(SESSION, ...events);
  const head = (sha: string): GitObservation => ({ repoRoot: '/repo', head: sha, dirty: [] });
  const release = async (sha: string) => {
    for (let i = 0; i < 20 && reads.length === 0; i++) await Promise.resolve();
    reads.shift()?.(head(sha));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const snapshots = () =>
    ingested.flatMap((e) => (e.kind === 'git.snapshot' ? [[e.trigger, e.head]] : []));
  return {
    enricher,
    emit,
    emitFor,
    release,
    snapshots,
    ingested,
    pendingReads: () => reads.length,
  };
}

const commit = {
  kind: 'tool.completed',
  callId: 'c1',
  toolName: 'Bash',
  isError: false,
  result: {
    kind: 'command',
    exit: { code: 0, observation: 'explicit' },
    outputExcerpt: '',
    outputChars: 0,
    truncated: false,
    gitOperation: { commit: { sha: 'b'.repeat(40) } },
  },
} as const;

describe('git snapshots at session boundaries', () => {
  it('keeps the turn end that arrives while a commit is being read, and reads it after', async () => {
    const { emit, release, snapshots, enricher } = harness();
    emit(commit);
    emit({ kind: 'turn.ended', outcome: 'completed' });
    await release('b'.repeat(40));
    await release('c'.repeat(40));
    await enricher.settled();
    expect(snapshots()).toEqual([
      ['commit', 'b'.repeat(40)],
      ['turn.ended', 'c'.repeat(40)],
    ]);
  });

  it('labels a batch by its last boundary, which is what the repository reflects when read', async () => {
    const { emit, release, snapshots, enricher } = harness();
    emit({ kind: 'session.started', cwd: '/repo' }, { kind: 'turn.ended', outcome: 'completed' });
    await release('a'.repeat(40));
    await enricher.settled();
    expect(snapshots()).toEqual([['turn.ended', 'a'.repeat(40)]]);
  });

  it('runs one read at a time and coalesces boundaries that wait, one per kind', async () => {
    const { emit, release, snapshots, enricher, pendingReads } = harness();
    emit({ kind: 'session.started', cwd: '/repo' });
    emit(commit);
    emit(commit);
    emit({ kind: 'turn.ended', outcome: 'completed' });
    emit({ kind: 'turn.ended', outcome: 'completed' });
    expect(pendingReads()).toBe(1);
    await release('a'.repeat(40));
    await release('b'.repeat(40));
    await release('c'.repeat(40));
    await enricher.settled();
    expect(snapshots().map(([trigger]) => trigger)).toEqual([
      'session.started',
      'commit',
      'turn.ended',
    ]);
    expect(pendingReads()).toBe(0);
  });

  it('never reads for a boundary that is history rather than live', async () => {
    const { emit, snapshots, enricher, pendingReads } = harness();
    emit({ kind: 'turn.ended', outcome: 'completed', ts: '2026-10-01T00:00:00.000Z' });
    await enricher.settled();
    expect(pendingReads()).toBe(0);
    expect(snapshots()).toEqual([]);
  });
});

describe('git snapshots under load', () => {
  it('reads at most four repositories at once, across sessions', async () => {
    const { emitFor, release, pendingReads, enricher } = harness();
    for (let i = 0; i < 6; i++)
      emitFor(`codex:s${i}`, { kind: 'turn.ended', outcome: 'completed' });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(pendingReads()).toBe(4);
    await release('a'.repeat(40));
    await release('a'.repeat(40));
    expect(pendingReads()).toBe(4);
    for (let i = 0; i < 4; i++) await release('a'.repeat(40));
    await enricher.settled();
    expect(pendingReads()).toBe(0);
  });

  it('reads HEAD at a resume but does not offer it as where the session started', async () => {
    const { emit, release, ingested, enricher } = harness();
    emit({ kind: 'session.started', cwd: '/repo', reason: 'resume' });
    await release('a'.repeat(40));
    await enricher.settled();
    const [snapshot] = ingested;
    expect(snapshot).toMatchObject({ kind: 'git.snapshot', head: 'a'.repeat(40) });
    expect(snapshot && 'trigger' in snapshot ? snapshot.trigger : undefined).toBeUndefined();
  });
});
