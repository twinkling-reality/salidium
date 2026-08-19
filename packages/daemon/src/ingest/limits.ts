/** Maximum untrusted provider record or hook JSON accepted as one logical payload. */
export const MAX_INGEST_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Envelope allowance around one hook payload in the relay's newline-delimited spool. */
export const MAX_HOOK_SPOOL_RECORD_BYTES = MAX_INGEST_PAYLOAD_BYTES + 4096;

/** Total bytes written to one provider/day offline spool. */
export const MAX_HOOK_DAILY_SPOOL_BYTES = 50 * 1024 * 1024;

/** Valid JSON substituted by the relay when stdin exceeds the payload ceiling. */
export const TRUNCATED_HOOK_PAYLOAD_KEY = '_salidium_truncated_hook_payload';
