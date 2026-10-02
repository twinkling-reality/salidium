/** Maximum untrusted provider record or hook JSON accepted as one logical payload. */
export const MAX_INGEST_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Envelope allowance around one hook payload in the relay's newline-delimited spool. */
export const MAX_HOOK_SPOOL_RECORD_BYTES = MAX_INGEST_PAYLOAD_BYTES + 4096;

/**
 * Ready envelopes the offline spool may hold before the relay stops adding to it.
 *
 * A count, not a byte total, because files are what the relay's own work is proportional to: a
 * sender that has to measure the backlog pays per file, so a byte ceiling high enough to be
 * generous is also high enough that reaching it costs more than the disk it was protecting. Each
 * payload is already individually bounded by MAX_INGEST_PAYLOAD_BYTES, so bounding the count
 * bounds the spool.
 */
export const MAX_HOOK_PENDING_FILES = 2000;

/** Start dropping the most redundant pre-tool hook observations at this queue depth. */
export const MAX_HOOK_SHED_FIRST_PENDING_FILES = 1000;

/** Start dropping redundant successful tool-result hook observations at this queue depth. */
export const MAX_HOOK_SHED_SECOND_PENDING_FILES = 1500;

/** Capacity held back from ordinary hooks for lifecycle events. */
export const MAX_HOOK_LIFECYCLE_RESERVE = 200;

/** Physical terminal bound after the lifecycle reserve has also filled. */
export const MAX_HOOK_ABSOLUTE_PENDING_FILES = MAX_HOOK_PENDING_FILES + MAX_HOOK_LIFECYCLE_RESERVE;

/** Sentinel written once even the protected lifecycle reserve is exhausted. */
export const HOOK_BREAKER_FILE = 'hooks-off';

/** Marker checked by the relay before it reads stdin or starts a sender. */
export const HOOK_PAUSE_FILE = 'hooks-paused';

/** A running daemon removes an ordinary pause after this lease. */
export const HOOK_PAUSE_LEASE_MS = 24 * 60 * 60 * 1000;

/** Pressure sentinels are durable evidence that at least one observation was not collected. */
export const HOOK_SHED_FIRST_FILE = 'hooks-shed-first';
export const HOOK_SHED_SECOND_FILE = 'hooks-shed-second';
export const HOOK_SHED_RETAIN_FILE = 'hooks-shed-retain';

/** The relay's quota lock, beside the envelopes it serializes publication of. */
export const HOOK_QUOTA_LOCK_FILE = '.quota-lock';

/** The directory a relay makes to become the one contender allowed to reclaim a dead owner's lock. */
export const HOOK_QUOTA_REAPING_DIR = `${HOOK_QUOTA_LOCK_FILE}.reaping`;

/**
 * Age at which the daemon treats a reaping directory as abandoned. A live reaper holds it across a
 * few shell builtins and two short commands, so this is far beyond any real reclaim.
 */
export const STALE_HOOK_QUOTA_REAPING_MS = 5 * 60_000;

/**
 * Suffix for a pending envelope whose name carries no valid provider id. It stays beside the queue,
 * outside every pattern the relay counts or the drain claims.
 */
export const UNATTRIBUTED_SUFFIX = '.unattributed';

/**
 * Quarantined files the drain will keep beside the queue. A quarantined file has left the relay's
 * quota count, so without this bound quarantine would reopen the physical ceiling ADR 0003 closed.
 * It also keeps the relay's hard bound plus every quarantined file inside the queue status scan
 * ceiling, so queue totals stay exact. Past it, unattributed envelopes stay where they are.
 */
export const MAX_QUARANTINED_FILES = 1000;

/**
 * Spool envelopes recovered in one drain pass before the daemon yields.
 *
 * The drain is synchronous and each payload reaches the reducer and SQLite, so an uncapped pass
 * over a large backlog holds the event loop for as long as it takes: the daemon stops answering
 * exactly when a user is trying to recover, and the CLI's readiness probe times out against a
 * daemon that is working normally. A pass that hits this cap schedules the next one immediately
 * rather than waiting for the poll interval, so a backlog still drains promptly.
 */
export const MAX_SPOOL_DRAIN_BATCH = 200;

/** Valid JSON substituted by the relay when stdin exceeds the payload ceiling. */
export const TRUNCATED_HOOK_PAYLOAD_KEY = '_salidium_truncated_hook_payload';
