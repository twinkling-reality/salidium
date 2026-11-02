import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clearsPauseOnRun, PAUSE_POLICY } from './pauseOnRun.ts';

/*
 * The end-to-end half of this contract is in `daemonLaunch.test.ts`, which pauses, runs a command,
 * and looks at the marker. That costs a Node process per case, and the cases are now a list rather
 * than a pair, so the list is checked here and the mechanism is checked once there.
 */
describe('which commands clear a pause', () => {
  it('lets an ordinary command recover a marker whose owner may have died', () => {
    expect(clearsPauseOnRun('up', undefined, [], 'manual')).toBe(true);
    expect(clearsPauseOnRun('status', undefined, [], 'manual')).toBe(true);
    expect(clearsPauseOnRun('open', undefined, [], 'manual')).toBe(true);
    expect(clearsPauseOnRun('storage', 'composition', [], 'manual')).toBe(true);
    // A marker that cannot be read stays recoverable.
    expect(clearsPauseOnRun('status', undefined, [], undefined)).toBe(true);
  });

  it('leaves it alone for the commands whose purpose is preserving lifecycle state', () => {
    for (const command of ['pause', 'resume', 'stop', 'service'])
      expect(clearsPauseOnRun(command, 'status', [], 'manual')).toBe(false);
    expect(clearsPauseOnRun('storage', 'optimize', [], 'manual')).toBe(false);
    expect(clearsPauseOnRun('storage', 'compact', [], 'manual')).toBe(false);
    expect(clearsPauseOnRun('maintenance', 'optimize', [], 'manual')).toBe(false);
    expect(clearsPauseOnRun('maintenance', 'compact', [], 'manual')).toBe(false);
  });

  /*
   * A release check ran `salidium help` against a real home and undid its owner's `salidium stop`.
   * Printing help or the version is not a person returning to Salidium, and a typo that prints the
   * help text is not one either.
   */
  it('never lets help, the version, or an unknown command clear a pause', () => {
    for (const command of ['help', '--help', '-h', 'version', '--version', '-v', 'stauts'])
      for (const reason of ['manual', 'stop', undefined] as const)
        expect(clearsPauseOnRun(command, undefined, [], reason)).toBe(false);
  });

  /*
   * `stop` and `service disable` pause and then remove the daemon, so their marker is all that
   * keeps hooks from spooling into a queue nothing drains. Only bringing the daemon back clears it.
   */
  it('keeps a stop pause until a command starts the daemon again', () => {
    for (const command of ['status', 'show', 'storage', 'config', 'doctor', 'install-hooks'])
      expect(clearsPauseOnRun(command, undefined, [], 'stop')).toBe(false);
    for (const command of ['up', 'start', 'open', 'restart', 'daemon'])
      expect(clearsPauseOnRun(command, undefined, [], 'stop')).toBe(true);
    expect(clearsPauseOnRun('storage', 'optimize', [], 'stop')).toBe(false);
    expect(clearsPauseOnRun('storage', 'compact', [], 'stop')).toBe(false);
  });

  /*
   * The regression this guards. The daemon spawns `__storage-composition` every time someone asks
   * what is using their disk, so if that entrypoint resumed collection, pressing Analyze on a
   * deliberately paused Salidium would quietly start recording again: the same fault as the menu
   * bar's "Open Salidium", reintroduced through a different door.
   */
  it('never lets a private worker entrypoint resume collection', () => {
    expect(clearsPauseOnRun('__usage-backfill', '/tmp/store.db', [], 'manual')).toBe(false);
    expect(clearsPauseOnRun('__storage-composition', '/tmp/store.db', [], 'manual')).toBe(false);
  });

  it('honours --no-resume for a caller that has already seen the daemon answer', () => {
    expect(clearsPauseOnRun('open', undefined, ['open', '--no-resume'], 'manual')).toBe(false);
    expect(
      clearsPauseOnRun('status', undefined, ['status', '--json', '--no-resume'], 'manual'),
    ).toBe(false);
    expect(clearsPauseOnRun('up', undefined, ['--no-resume'], 'stop')).toBe(false);
    // Opt-in only: every other caller keeps the documented recovery behaviour.
    expect(clearsPauseOnRun('open', undefined, ['open'], 'manual')).toBe(true);
  });

  /*
   * Read from the source rather than imported, because importing `main.ts` runs the CLI. A command
   * added to the switch without an entry would clear nothing, which is the safe direction, but the
   * choice should be made rather than defaulted.
   */
  it('has a decision for every command main.ts handles', () => {
    const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const body = source.slice(
      source.indexOf('async function main('),
      source.indexOf('\n}\n', source.indexOf('async function main(')),
    );
    const handled = [...body.matchAll(/^ {4}case '([^']+)':/gm)].map((match) => match[1]);
    expect(handled.length).toBeGreaterThan(20);
    expect(new Set(handled)).toEqual(new Set(Object.keys(PAUSE_POLICY)));
  });
});
