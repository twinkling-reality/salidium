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
 * Implicit resume exists to clear a marker whose only owner has died: a pause is a lease that the
 * running daemon expires, so a daemon that crashed while paused leaves collection stopped with
 * nothing able to restart it. ADR 0003 makes the next ordinary command that recovery step.
 *
 * Three kinds of caller are excluded. Lifecycle commands whose purpose is to preserve state, which
 * is the ADR's own list. Private worker entrypoints such as `__usage-backfill`, because the daemon
 * spawns those itself and work it scheduled must never be a way to start recording again. And
 * `--no-resume` itself, for a caller that has already seen the daemon answer and so cannot be
 * recovering after a crash, and whose surface cannot show that recovery happened.
 */
export function clearsPauseOnRun(
  command: string,
  argument: string | undefined,
  argv: readonly string[],
): boolean {
  if (argv.includes('--no-resume')) return false;
  if (['pause', 'resume', 'stop', 'service'].includes(command)) return false;
  if (command.startsWith('__')) return false;
  if (command === 'storage' && argument === 'optimize') return false;
  return true;
}
