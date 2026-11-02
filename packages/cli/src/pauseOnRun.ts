/*
 * Whether running a command clears a pause, decided in one place so it can be read and tested.
 *
 * Its own module rather than an export from `main.ts`, because that file runs the CLI on import:
 * the bottom of it calls `main(process.argv.slice(2))` unconditionally. A test that imported the
 * predicate from there would execute a command against whatever `SALIDIUM_HOME` resolves to, which
 * for a developer running the suite is their real one, and the first thing that command does is
 * decide whether to clear their pause.
 */

/**
 * What each command in `main.ts` is, as far as a pause is concerned. Every `case` label of the
 * command switch has an entry, and `pauseOnRun.test.ts` fails when one is added without a decision,
 * so a new command cannot inherit recovery by default. A command that is not listed, which is a
 * typo printing the help text, clears nothing.
 *
 * - `informational` prints something that does not depend on Salidium's state: help and version.
 * - `lifecycle` exists to preserve or change collection state itself, which is the ADR's own list.
 * - `worker` is a private entrypoint the daemon spawns itself. `__storage-composition` runs every
 *   time Analyze is pressed, and if it resumed, that press would silently undo a deliberate pause.
 * - `starts-daemon` brings back the process that drains the queue.
 * - `ordinary` is everything else, and is the recovery step ADR 0003 describes.
 */
export const PAUSE_POLICY = {
  help: 'informational',
  '--help': 'informational',
  '-h': 'informational',
  version: 'informational',
  '--version': 'informational',
  '-v': 'informational',
  pause: 'lifecycle',
  resume: 'lifecycle',
  stop: 'lifecycle',
  service: 'lifecycle',
  '__usage-backfill': 'worker',
  '__storage-composition': 'worker',
  up: 'starts-daemon',
  start: 'starts-daemon',
  open: 'starts-daemon',
  restart: 'starts-daemon',
  daemon: 'starts-daemon',
  show: 'ordinary',
  config: 'ordinary',
  maintenance: 'ordinary',
  status: 'ordinary',
  explanations: 'ordinary',
  'install-hooks': 'ordinary',
  'uninstall-hooks': 'ordinary',
  'audit-claims': 'ordinary',
  reingest: 'ordinary',
  retention: 'ordinary',
  storage: 'ordinary',
  pin: 'ordinary',
  unpin: 'ordinary',
  forget: 'ordinary',
  map: 'ordinary',
  consumer: 'ordinary',
  doctor: 'ordinary',
} as const satisfies Record<
  string,
  'informational' | 'lifecycle' | 'worker' | 'starts-daemon' | 'ordinary'
>;

/**
 * Implicit resume exists to clear a marker whose only owner has died: a pause is a lease that the
 * running daemon expires, so a daemon that crashed while paused leaves collection stopped with
 * nothing able to restart it. ADR 0003 makes the next ordinary command that recovery step.
 *
 * A pause written by `stop` or `service disable` has no such owner. Those commands pause and then
 * remove the daemon on purpose, so the marker is the only thing keeping hooks from spooling into a
 * queue nothing drains, and it is not stale while the daemon is down: it is doing its job. Only a
 * command that starts the daemon again clears it, because that restores what the pause stood in
 * for. Asking for the status of a stopped Salidium leaves it stopped.
 *
 * `--no-resume` is for a caller that has already seen the daemon answer and so cannot be recovering
 * after a crash, and whose surface cannot show that recovery happened. A pause marker that cannot be
 * read has no reason, and is treated as an ordinary pause so that a corrupt file stays recoverable.
 */
export function clearsPauseOnRun(
  command: string,
  argument: string | undefined,
  argv: readonly string[],
  pauseReason?: string,
): boolean {
  if (argv.includes('--no-resume')) return false;
  const policy = Object.hasOwn(PAUSE_POLICY, command)
    ? PAUSE_POLICY[command as keyof typeof PAUSE_POLICY]
    : undefined;
  if (policy === 'starts-daemon') return true;
  if (policy !== 'ordinary') return false;
  if (
    (command === 'storage' || command === 'maintenance') &&
    (argument === 'optimize' || argument === 'compact')
  )
    return false;
  return pauseReason !== 'stop';
}
