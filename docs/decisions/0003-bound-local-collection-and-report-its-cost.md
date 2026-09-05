# ADR 0003: Bound local collection and report its cost

- Status: accepted
- Date: 2026-09-04

## Context

The hook relay allowed the offline queue to make each new hook progressively more expensive. On an
affected machine the result was hundreds of relay processes and severe process-table pressure while
the product reported only that provider hooks were configured. A file-count ceiling and bounded
drain passes stop that feedback loop, but they leave product choices about stopped collection,
pressure loss, hook repair, storage migration, retention, and pause recovery.

Three guarantees cannot hold together for an outage of arbitrary length: finite local storage,
non-blocking hooks, and lossless acceptance of every event. When the finite bound is reached,
Salidium must preserve the coding agent and describe the evidence gap rather than imply complete
coverage.

A plain marker checked by POSIX shell also cannot both expire from wall-clock time while the daemon
is absent and remain a zero-subprocess fast path. Expiry therefore has an explicit recovery limit
instead of a claim the implementation cannot keep.

## Decision

1. `salidium stop` stops new hook collection. It preserves and accounts for work already queued.
   A later start may recover durable provider transcripts, but the stopped interval remains an
   explicit collection gap wherever hook-only evidence could be absent.
2. The relay never blocks the coding agent under pressure. It sheds `PreToolUse` before
   `PostToolUse`, reserves capacity for lifecycle events, and never presents an inferred loss count
   as observed. If an absolute terminal bound prevents preservation, completeness is unknown and a
   first-class collection-gap record says so.
3. Codex hook repair is supported only through an explicit setup or repair action, and only after
   the relay bounds, event-budget declaration, and cost visibility are in place. Daemon startup does
   not silently change provider settings or trust state.
4. The lossless storage redesign applies directly to new stores. Existing stores are rewritten only
   through an explicit offline copy-and-swap operation with free-space preflight, integrity checks,
   recovery of the original, and reproducible verification against representative stores before
   release. A daemon startup must not turn into an unannounced large rewrite.
5. Size-based destructive retention is deferred until lossless waste is reclaimed and the product
   can preview what a byte target would actually delete. Database file size is not treated as an
   exact measure of deletable session content.
6. An ordinary pause is a 24-hour lease. The running daemon clears it when it expires, and an
   ordinary CLI command implicitly resumes collection. State-preserving lifecycle and offline
   maintenance commands do not. The relay keeps the zero-subprocess marker check. If the daemon
   crashes while paused and no ordinary command is run, automatic wall-clock expiry is not
   guaranteed; the next ordinary command must preserve the stopped interval in the collection-gap
   ledger while it resumes collection.

## Consequences

Stopping and pressure shedding can create evidence gaps. Those gaps are product data, not merely
log messages. Reports and operational surfaces must distinguish an observed gap from an exact drop
count, which may be unavailable under concurrent saturation.

Lifecycle traffic receives protected capacity, but an infinite outage cannot have a finite,
lossless, non-blocking queue. At the terminal bound Salidium protects the host and marks lifecycle
completeness unknown. This is a deliberate fail-safe boundary, not a claim that lifecycle data can
never be lost under any physical condition.

Codex repair is sequenced after the safety work because enabling a previously inactive hook set
increases load. The durable rollout tailer remains the recovery source while repair is pending.

Existing large stores require an explicit maintenance window. Retention deletion is not offered as
the first remedy for bytes that can be reclaimed without deleting evidence.

The zero-subprocess paused path is favored over pretending a marker can expire by itself after the
only process able to clear it has died. Starting or running an ordinary Salidium command clears that
stale state; commands whose purpose is to preserve lifecycle state, including service inspection,
do not implicitly resume collection.

## Rejected alternatives

- Keep collecting while `stop` has removed the only consumer: preserves a hidden cost under a name
  that says the system is stopped.
- Block hooks when the queue is full: transfers the collection failure into the coding agent and
  risks process-table starvation.
- Drop the oldest envelope without classifying it: can discard lifecycle ordering while retaining
  redundant low-fidelity tool observations.
- Report a guessed number of dropped events: violates the product rule that displayed counts are
  observed counts.
- Repair Codex hooks silently at startup: changes external provider configuration and increases
  load without an explicit action.
- Rewrite every existing store during ordinary startup: makes availability and recovery depend on
  free disk space and a long authoritative-store migration.
- Add size retention before lossless compaction: deletes user evidence while recoverable internal
  waste remains.
- Claim crash-proof pause expiry with a marker-only shell test: no clock advances inside that test
  while the daemon is absent.
