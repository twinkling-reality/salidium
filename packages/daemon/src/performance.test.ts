import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBuilder } from '@salidium/core/testing';
import type { CanonicalEvent } from '@salidium/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DaemonHandle, startDaemon } from './daemon.ts';

/**
 * Long-session behaviour: a synthetic session with tens of thousands of events must ingest at
 * a live-friendly rate, keep the latest state cheap to read, reconstruct history quickly, and not
 * bloat storage. Thresholds are generous (CI machines vary) but catch regressions in kind.
 *
 * Every bound here is a wall clock reading, which on a shared runner measures the machine as well
 * as the code. Bounds are deliberately derived from both idle and CPU-saturated runs; an idle-only
 * bound can pass on a developer laptop and fail in CI for no actionable reason.
 *
 *   reading                idle     saturated   bound
 *   per event              0.03 ms   0.35 ms     2 ms
 *   one more event (p50)   0.04 ms   0.10 ms     5 ms
 *   snapshot                 16 ms    218 ms     see below
 *   scrub                   106 ms   1069 ms     5000 ms
 *
 * Snapshot is the one bound that could not be set this way. It reads a checkpoint where the scrub
 * replays the log, and that is the property worth testing; but a bound loose enough to survive a
 * loaded runner (1.5 s) is also loose enough for a regression that replays everything (~106 ms) to
 * pass. So it is asserted against the scrub instead. A ratio cancels the machine out: snapshot was
 * 15% of the scrub idle and 20% of it saturated, and a snapshot that stopped using its checkpoint
 * fails the comparison on any hardware, at any load.
 */
const tmp = mkdtempSync(join(tmpdir(), 'salidium-perf-'));
let daemon: DaemonHandle;
const SESSION = 'claude-code:perf-session';

function buildEvents(turns: number, toolsPerTurn: number): CanonicalEvent[] {
  const b = new EventBuilder(SESSION, '2026-08-16T08:00:00.000Z');
  const events: CanonicalEvent[] = [b.sessionStarted('/repo/perf')];
  for (let t = 0; t < turns; t++) {
    events.push(b.turnStarted(`Task ${t}: improve module ${t % 17}`));
    events.push(b.message(`Working on module ${t % 17}; found that handler ${t} needs a guard.`));
    for (let i = 0; i < toolsPerTurn; i++) {
      const id = `c${t}-${i}`;
      if (i % 3 === 0) events.push(...b.edit(id, `/repo/perf/src/mod${t % 17}/file${i}.ts`, 3, 1));
      else if (i % 7 === 0)
        events.push(
          ...b.command(id, 'pnpm vitest run', ' Tests  120 passed (120)', { exitCode: 0 }),
        );
      else events.push(...b.command(id, `rg pattern${i} src/`, 'src/a.ts:1: match\n'.repeat(20)));
    }
    events.push(b.turnEnded(`Done with module ${t % 17}. Tests pass.`));
  }
  return events;
}

beforeAll(async () => {
  daemon = await startDaemon({
    home: join(tmp, 'salidium'),
    userHome: join(tmp, 'home'),
    port: 0,
    providers: ['claude-code'],
    gitEnrichment: false,
    historyDays: 0,
    logLevel: 'silent',
  });
});

afterAll(async () => {
  await daemon.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('long sessions', () => {
  it('ingests ~30k events quickly and keeps live/snapshot/scrub paths fast', async () => {
    const events = buildEvents(300, 48); // ~30k events
    expect(events.length).toBeGreaterThan(28_000);
    const coordinator = daemon.registry.get(SESSION, { cwd: '/repo/perf' });
    const t0 = performance.now();
    // Ingest in bursts, as the tailer would.
    for (let i = 0; i < events.length; i += 200) coordinator.ingest(events.slice(i, i + 200));
    const ingestMs = performance.now() - t0;
    const perEvent = ingestMs / events.length;
    // Live path: applying one more event must stay sub-millisecond even at this size.
    //
    // Measured as one wall-clock sample it was the flakiest assertion here, and not because the
    // threshold was tight: the true cost is ~0.17 ms against a 5 ms bound, and it still read
    // 301 ms once on a machine that was busy backfilling. A sample that short measures the
    // scheduler as much as the code, so the fix is a better statistic rather than a looser bound.
    // A descheduled sample moves the median of fifty by nothing; a real regression moves every
    // sample, so the assertion keeps its teeth. The worst sample is printed but not asserted on,
    // because it is a fact about the machine.
    const b = new EventBuilder(SESSION, '2026-08-17T08:00:00.000Z');
    const singles: number[] = [];
    for (let i = 0; i < 50; i++) {
      // An explicit id: the builder's own `msg:<seq>` counter restarts per builder, so a second
      // builder's messages collide with the first's and dedupe away.
      const one = b.raw({
        id: `late:${i}`,
        kind: 'agent.message',
        text: 'one more',
        phase: 'commentary',
      });
      const t1 = performance.now();
      coordinator.ingest([one]);
      singles.push(performance.now() - t1);
    }
    singles.sort((x, y) => x - y);
    const singleMs = singles[Math.floor(singles.length / 2)] ?? 0;
    const singleWorstMs = singles[singles.length - 1] ?? 0;
    coordinator.flush();
    coordinator.checkpoint();

    // Sampled for the same reason the live path is: at ~20 ms idle this is the shortest reading
    // here, so it carries the most relative noise, and it is compared against a longer one.
    const snaps: number[] = [];
    let snap: ReturnType<typeof daemon.registry.snapshot>;
    for (let i = 0; i < 5; i++) {
      const t2 = performance.now();
      snap = daemon.registry.snapshot(SESSION, 300);
      snaps.push(performance.now() - t2);
    }
    snaps.sort((x, y) => x - y);
    const snapshotMs = snaps[Math.floor(snaps.length / 2)] ?? 0;
    expect(snap?.summary.counts.turns).toBe(300);
    expect(snap?.summary.counts.filesChanged).toBe(17 * 16);

    // Measured once, and deliberately not sampled: a repeated scrub to the same instant is served
    // from the cache and reads as ~0 ms, which would turn the comparison below into a test that
    // can only fail. It is also the longer of the two readings, so it carries the least relative
    // noise, and an unlucky sample makes it larger — which is the safe direction here.
    const t3 = performance.now();
    const mid = daemon.registry.stateAtTime(SESSION, '2026-08-16T09:00:00.000Z');
    const scrubMs = performance.now() - t3;
    expect(mid?.state.turns.length).toBeGreaterThan(0);
    expect(mid?.state.turns.length).toBeLessThan(300);

    const t4 = performance.now();
    const events2 = daemon.registry.eventsAfter(SESSION, -1, undefined, 100_000);
    const readMs = performance.now() - t4;
    expect(events2.length).toBe(events.length + singles.length);

    const dbBytes = statSync(join(tmp, 'salidium', 'salidium.db')).size;
    const summary = {
      events: events.length,
      ingestMs: Math.round(ingestMs),
      perEventUs: Math.round(perEvent * 1000),
      singleEventMedianMs: +singleMs.toFixed(3),
      singleEventWorstMs: +singleWorstMs.toFixed(3),
      snapshotMs: Math.round(snapshotMs),
      scrubMs: Math.round(scrubMs),
      readAllMs: Math.round(readMs),
      dbMB: +(dbBytes / 1e6).toFixed(1),
    };
    process.stdout.write(`perf ${JSON.stringify(summary)}\n`);
    expect(perEvent).toBeLessThan(2); // per event end to end (reduce + redact + queue)
    expect(singleMs).toBeLessThan(5);
    // Reading a checkpoint against replaying the log: the comparison is the assertion, and it
    // holds whatever the machine is doing.
    expect(snapshotMs).toBeLessThan(scrubMs);
    expect(scrubMs).toBeLessThan(5000);
    expect(dbBytes).toBeLessThan(200 * 1024 * 1024);
  }, 120_000);
});
