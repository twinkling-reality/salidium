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

/** Sentinel written beside the spool once the relay has stopped accepting work. */
export const HOOK_BREAKER_FILE = 'hooks-off';

/** Valid JSON substituted by the relay when stdin exceeds the payload ceiling. */
export const TRUNCATED_HOOK_PAYLOAD_KEY = '_salidium_truncated_hook_payload';
