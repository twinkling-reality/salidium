import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { trustedPathEntries } from '@salidium/adapter-kit';
import { writePrivateTextAtomic } from '../operations/files.ts';
import {
  HOOK_BREAKER_FILE,
  HOOK_PAUSE_FILE,
  HOOK_QUOTA_LOCK_FILE,
  HOOK_QUOTA_REAPING_DIR,
  HOOK_SHED_FIRST_FILE,
  HOOK_SHED_RETAIN_FILE,
  HOOK_SHED_SECOND_FILE,
  MAX_HOOK_ABSOLUTE_PENDING_FILES,
  MAX_HOOK_PENDING_FILES,
  MAX_HOOK_SHED_FIRST_PENDING_FILES,
  MAX_HOOK_SHED_SECOND_PENDING_FILES,
  MAX_INGEST_PAYLOAD_BYTES,
  TRUNCATED_HOOK_PAYLOAD_KEY,
} from './limits.ts';

/**
 * The hook relay: a tiny POSIX shell script Claude Code / Codex run as an async command hook.
 * It POSTs the hook's stdin JSON to the daemon and, if the daemon is unreachable, atomically
 * publishes the unique pending payload as a ready spool file the daemon drains on its next start.
 * It always exits 0 so it can never surface an error in the agent's session.
 */
function shellQuote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Shell values must not contain newlines');
  return value.replace(/'/g, `'\\''`);
}

export function writeRelayScript(
  hooksDir: string,
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  const path = join(hooksDir, 'relay.sh');
  const relayPath =
    trustedPathEntries({ environment }).join(':') || '/usr/bin:/bin:/usr/sbin:/sbin';
  const truncatedPayload = JSON.stringify({
    [TRUNCATED_HOOK_PAYLOAD_KEY]: true,
    limitBytes: MAX_INGEST_PAYLOAD_BYTES,
  });
  const script = `#!/bin/sh
# Salidium hook relay, installed by \`salidium install-hooks\`. Use uninstall-hooks to disconnect it.
# Reads the hook JSON from stdin, then hands off to a detached child so the agent's process
# teardown (e.g. \`claude -p\`) can never cut the delivery short. Always exits 0.
umask 077
# Package runners prepend project-owned node_modules bins. Relay commands run only from the
# absolute, sanitized installation PATH captured when this script is written.
PATH='${shellQuote(relayPath)}'; export PATH
# Salidium's own explainer invokes a local agent CLI. That call can fire hooks like any other
# session, so without this guard the daemon would ingest its enrichment and explain the explanation.
# The variable is set only by the explainer.
[ -n "$SALIDIUM_INTERNAL" ] && exit 0
HOME_DIR='${shellQuote(home)}'
# A pause is one marker test before stdin is read. Its JSON lease is cleared by a running daemon or
# any later CLI command; the relay itself stays fork-free on this path and does not pretend to own a clock.
[ -e "$HOME_DIR/${HOOK_PAUSE_FILE}" ] && exit 0
# Event and pressure class are fixed arguments in the provider hook definition. They let the relay
# shed only explicitly declared low-fidelity observations without parsing untrusted JSON.
if [ "$1" = "--send" ] && [ "$#" -ge 5 ]; then
  EVENT="$3"; PRESSURE="$4"
else
  EVENT="\${2:-Unknown}"; PRESSURE="\${3:-retain}"
fi
# The terminal breaker is one test and no subprocess before stdin is read. It exists only after the
# ordinary queue and protected lifecycle reserve are both full.
[ -e "$HOME_DIR/${HOOK_BREAKER_FILE}" ] && exit 0
# Earlier pressure levels stop only the event class that caused them. Lifecycle events continue
# into reserved capacity instead of being discarded behind redundant tool observations.
case "$PRESSURE" in
  shed-first) [ -e "$HOME_DIR/${HOOK_SHED_FIRST_FILE}" ] && exit 0;;
  shed-second) [ -e "$HOME_DIR/${HOOK_SHED_SECOND_FILE}" ] && exit 0;;
  retain) [ -e "$HOME_DIR/${HOOK_SHED_RETAIN_FILE}" ] && exit 0;;
esac
if [ "$1" = "--send" ]; then
  PROVIDER="$2"
  if [ "$#" -ge 5 ]; then
    EVENT="$3"; PRESSURE="$4"; FILE="$5"
  else
    # Compatibility for a sender already detached while Salidium replaced the relay script.
    EVENT="Unknown"; PRESSURE="retain"; FILE="$3"
  fi
  # Bound old/external pending files too, not just stdin captured by this version of the relay.
  PAYLOAD_SIZE=$(wc -c < "$FILE" 2>/dev/null | tr -d ' ')
  case "$PAYLOAD_SIZE" in ''|*[!0-9]*) PAYLOAD_SIZE=0;; esac
  if [ "$PAYLOAD_SIZE" -gt ${MAX_INGEST_PAYLOAD_BYTES} ]; then
    printf '%s' '${shellQuote(truncatedPayload)}' > "$FILE" 2>/dev/null || exit 0
    PAYLOAD_SIZE=$(wc -c < "$FILE" 2>/dev/null | tr -d ' ')
  fi
  DAEMON_JSON="$HOME_DIR/daemon.json"; SPOOL_DIR="$HOME_DIR/spool"; PENDING="$SPOOL_DIR/pending"
  if [ -r "$DAEMON_JSON" ]; then
    PORT=$(sed -n 's/.*"port": *\\([0-9]*\\).*/\\1/p' "$DAEMON_JSON" | head -n1)
    TOKEN=$(sed -n 's/.*"token": *"\\([0-9a-f]*\\)".*/\\1/p' "$DAEMON_JSON" | head -n1)
    if [ -n "$PORT" ] && [ -n "$TOKEN" ]; then
      # The token travels to curl via a config on stdin, never on the command line (argv is public).
      printf 'header = "Authorization: Bearer %s"\\n' "$TOKEN" | curl -fsS -m 3 -K - -o /dev/null -X POST \\
        -H "Content-Type: application/json" --data-binary "@$FILE" "http://127.0.0.1:$PORT/hooks/$PROVIDER" \\
        && rm -f "$FILE" && exit 0
    fi
  fi
  mkdir -p "$PENDING" 2>/dev/null && chmod 700 "$SPOOL_DIR" "$PENDING" 2>/dev/null
  # Every sender owns one file. Publishing it with a same-directory rename is atomic, so a drain
  # can never observe interleaved or partially-written envelopes from concurrent hooks.
  READY="\${FILE%.json}.ready.json"
  # Serialize quota observation and publication across concurrent hook processes. Without this
  # small filesystem lock, many senders can all observe one remaining slot and overrun the hard
  # physical ceiling. A timed-out contender leaves its plain .json input durable for orphan drain.
  QUOTA_LOCK="$PENDING/${HOOK_QUOTA_LOCK_FILE}"
  QUOTA_REAPING="$PENDING/${HOOK_QUOTA_REAPING_DIR}"
  QUOTA_ATTEMPTS=0
  while :; do
    set -C
    if printf '%s\n' "$$" > "$QUOTA_LOCK" 2>/dev/null; then
      set +C
      break
    fi
    set +C
    QUOTA_ATTEMPTS=$((QUOTA_ATTEMPTS + 1))
    # Only one contender may reclaim a dead owner's lock. Without this guard, a late
    # contender can unlink a replacement lock acquired after another reclaimed it.
    if mkdir "$QUOTA_REAPING" 2>/dev/null; then
      LOCK_OWNER=''
      CURRENT_OWNER=''
      if [ -r "$QUOTA_LOCK" ]; then
      IFS= read -r LOCK_OWNER < "$QUOTA_LOCK"
      case "$LOCK_OWNER" in
        ''|*[!0-9]*) ;;
        *)
          if ! kill -0 "$LOCK_OWNER" 2>/dev/null; then
            # The old process may have removed its lock while exiting. Re-read after
            # proving it dead so we never remove the next live owner's replacement.
            [ ! -r "$QUOTA_LOCK" ] || IFS= read -r CURRENT_OWNER < "$QUOTA_LOCK"
            if [ "$CURRENT_OWNER" = "$LOCK_OWNER" ]; then
              rm -f "$QUOTA_LOCK" 2>/dev/null
            fi
          fi;;
      esac
      fi
      rmdir "$QUOTA_REAPING" 2>/dev/null
    fi
    [ "$QUOTA_ATTEMPTS" -lt 5000 ] || exit 0
    sleep 0.01
  done
  release_quota_lock() {
    CURRENT_OWNER=''
    [ ! -r "$QUOTA_LOCK" ] || IFS= read -r CURRENT_OWNER < "$QUOTA_LOCK"
    if [ "$CURRENT_OWNER" = "$$" ]; then
      rm -f "$QUOTA_LOCK" 2>/dev/null
    fi
  }
  trap 'release_quota_lock' EXIT
  trap 'exit 0' HUP INT TERM
  # Measure the backlog with the shell alone. An earlier version summed every envelope with a
  # wc/tr pair per file, which made the cost of delivering one hook proportional to the queue it
  # was joining: a backlog made each sender slower, which grew the backlog. Globbing into the
  # positional parameters counts the same files with no subprocess at all. An unmatched glob stays
  # literal and reports one word, so test it before trusting the count.
  set -- "$PENDING"/*.ready.json
  [ -e "$1" ] || shift $#
  PENDING_COUNT=$#
  set -- "$PENDING"/*.ready.json.processing
  [ -e "$1" ] || shift $#
  PENDING_COUNT=$((PENDING_COUNT + $#))
  write_pressure_marker() {
    MARKER="$1"; REASON="$2"
    if [ ! -e "$MARKER" ]; then
      MARKED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
      set -C
      printf '{"reason":"%s","provider":"%s","event":"%s","pressure":"%s","firstDroppedAt":"%s","exactCount":null}\\n' \\
        "$REASON" "$PROVIDER" "$EVENT" "$PRESSURE" "$MARKED_AT" > "$MARKER" 2>/dev/null
      set +C
    fi
  }
  case "$PRESSURE" in
    shed-first)
      if [ "$PENDING_COUNT" -ge ${MAX_HOOK_SHED_FIRST_PENDING_FILES} ]; then
        write_pressure_marker "$HOME_DIR/${HOOK_SHED_FIRST_FILE}" "pressure"
        rm -f "$FILE"
        exit 0
      fi;;
    shed-second)
      if [ "$PENDING_COUNT" -ge ${MAX_HOOK_SHED_SECOND_PENDING_FILES} ]; then
        write_pressure_marker "$HOME_DIR/${HOOK_SHED_SECOND_FILE}" "pressure"
        rm -f "$FILE"
        exit 0
      fi;;
  esac
  if [ "$PENDING_COUNT" -lt ${MAX_HOOK_PENDING_FILES} ] || \\
    { [ "$PRESSURE" = "lifecycle" ] && [ "$PENDING_COUNT" -lt ${MAX_HOOK_ABSOLUTE_PENDING_FILES} ]; }; then
    mv "$FILE" "$READY" 2>/dev/null && exit 0
  fi
  if [ "$PRESSURE" = "lifecycle" ]; then
    write_pressure_marker "$HOME_DIR/${HOOK_BREAKER_FILE}" "lifecycle-reserve-full"
  else
    write_pressure_marker "$HOME_DIR/${HOOK_SHED_RETAIN_FILE}" "ordinary-capacity-full"
  fi
  rm -f "$FILE"
  exit 0
fi
PROVIDER="\${1:-claude-code}"
# Provider ids can contain the namespacing slash, but a slash in FILE creates an unintended
# directory and makes the hook silently discard its stdin. Tilde and underscore cannot occur in a valid
# provider id, so this is an injective, filename-safe encoding with an unambiguous separator.
# A provider id has at most one slash, so parameter expansion encodes it without a subprocess. The
# earlier \`printf | tr\` substitution expanded to nothing when the process table was full, and the
# envelope it named carried no provider the drain could ever attribute.
# An id with a second slash is not a provider id; its encoding would keep a slash, so refuse it.
case "$PROVIDER" in
  */*/*) exit 0;;
  */*) PROVIDER_FILE="\${PROVIDER%%/*}~\${PROVIDER#*/}";;
  *) PROVIDER_FILE="$PROVIDER";;
esac
PENDING="$HOME_DIR/spool/pending"
mkdir -p "$PENDING" 2>/dev/null && chmod 700 "$HOME_DIR/spool" "$PENDING" 2>/dev/null
FILE="$PENDING/\${PROVIDER_FILE}_$(date -u +%s)-$$-$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \\n').json"
# Read at most limit + one byte and replace an oversized record with a small valid marker. Closing
# stdin with the relay bounds work too; an attacker cannot make this hook drain an arbitrary body.
head -c ${MAX_INGEST_PAYLOAD_BYTES + 1} > "$FILE" 2>/dev/null || exit 0
PAYLOAD_SIZE=$(wc -c < "$FILE" 2>/dev/null | tr -d ' ')
case "$PAYLOAD_SIZE" in ''|*[!0-9]*) PAYLOAD_SIZE=0;; esac
if [ "$PAYLOAD_SIZE" -gt ${MAX_INGEST_PAYLOAD_BYTES} ]; then
  printf '%s' '${shellQuote(truncatedPayload)}' > "$FILE" 2>/dev/null || exit 0
fi
[ -s "$FILE" ] || { rm -f "$FILE"; exit 0; }
# Detach into a new session so the agent's teardown (which kills the hook's process group) cannot
# interrupt delivery. If detaching is unavailable the daemon still drains the pending file later.
if command -v setsid >/dev/null 2>&1; then
  setsid sh "$0" --send "$PROVIDER" "$EVENT" "$PRESSURE" "$FILE" >/dev/null 2>&1 </dev/null &
elif command -v perl >/dev/null 2>&1; then
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- sh "$0" --send "$PROVIDER" "$EVENT" "$PRESSURE" "$FILE" >/dev/null 2>&1 </dev/null &
else
  nohup sh "$0" --send "$PROVIDER" "$EVENT" "$PRESSURE" "$FILE" >/dev/null 2>&1 </dev/null &
fi
exit 0
`;
  writePrivateTextAtomic(path, script, { mode: 0o700 });
  return path;
}
