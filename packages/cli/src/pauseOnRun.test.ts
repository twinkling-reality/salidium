import { describe, expect, it } from 'vitest';
import { clearsPauseOnRun } from './pauseOnRun.ts';

/*
 * The end-to-end half of this contract is in `daemonLaunch.test.ts`, which pauses, runs a command,
 * and looks at the marker. That costs a Node process per case, and the cases are now a list rather
 * than a pair, so the list is checked here and the mechanism is checked once there.
 */
describe('which commands clear a pause', () => {
  it('lets an ordinary command recover a marker whose owner may have died', () => {
    expect(clearsPauseOnRun('up', undefined, [])).toBe(true);
    expect(clearsPauseOnRun('status', undefined, [])).toBe(true);
    expect(clearsPauseOnRun('open', undefined, [])).toBe(true);
    expect(clearsPauseOnRun('storage', 'composition', [])).toBe(true);
  });

  it('leaves it alone for the commands whose purpose is preserving lifecycle state', () => {
    for (const command of ['pause', 'resume', 'stop', 'service'])
      expect(clearsPauseOnRun(command, 'status', [])).toBe(false);
    expect(clearsPauseOnRun('storage', 'optimize', [])).toBe(false);
  });

  /*
   * The regression this guards. The daemon spawns `__storage-composition` every time someone asks
   * what is using their disk, so if that entrypoint resumed collection, pressing Analyze on a
   * deliberately paused Salidium would quietly start recording again: the same fault as the menu
   * bar's "Open Salidium", reintroduced through a different door.
   */
  it('never lets a private worker entrypoint resume collection', () => {
    expect(clearsPauseOnRun('__usage-backfill', '/tmp/store.db', [])).toBe(false);
    expect(clearsPauseOnRun('__storage-composition', '/tmp/store.db', [])).toBe(false);
  });

  it('honours --no-resume for a caller that has already seen the daemon answer', () => {
    expect(clearsPauseOnRun('open', undefined, ['open', '--no-resume'])).toBe(false);
    expect(clearsPauseOnRun('status', undefined, ['status', '--json', '--no-resume'])).toBe(false);
    // Opt-in only: every other caller keeps the documented recovery behaviour.
    expect(clearsPauseOnRun('open', undefined, ['open'])).toBe(true);
  });
});
