# ADR 0004: Unify local operations behind versioned contracts

- Status: accepted
- Date: 2026-09-04

## Context

Salidium already had durable collection gaps, queue bounds, pause and stop controls, hook checks,
retention, and a verified storage rewrite. Their state was split among environment variables,
`settings.json`, SQLite metadata, CLI-only observations, and UI-specific projections. Adding alerts
or monitoring independently to those surfaces would create conflicting answers to basic questions
such as which policy is active, whether a count is exact, or what should happen after an interrupted
maintenance run.

Operational data also has a different privacy and durability profile from session evidence. Health
trends need aggregate numbers, not event bodies. Configuration needs recoverable replacement, but
must not become a second event authority. Diagnostics need a strict allowlist and independent
redaction. None of these requirements justify another resident process or a network dependency.

## Decision

1. `packages/protocol` owns version 1 contracts for effective configuration, health snapshots,
   queue inspection, maintenance state, local alerts, and diagnostic manifests. Every machine JSON
   response includes a contract or schema version. The daemon, HTTP API, CLI, and interface consume
   these same runtime-validated shapes.
2. `operations-config.json` is the single authority for user-set operational policy. It uses a
   versioned sparse schema, monotonically increasing revision, owner-only atomic replacement, and a
   recoverable previous copy. Resolution applies shipped defaults, then stored values, then
   compatible environment overrides. The response reports the source of every effective value.
   Existing explainer settings and SQLite retention metadata migrate once into this authority.
3. Only useful policy is configurable: history and retention windows, enabled providers, explainer
   choices, health history, alert thresholds and cooldown, and operations-detail preference. Relay
   breakers, lifecycle reserves, payload limits, trust bypasses, SQLite layout, and compression
   thresholds remain code-reviewed invariants.
4. Health samples contain only aggregate queue, store, gap, daemon, collection, and maintenance
   state. Recurring samples use file metadata and SQLite/WAL sizes; they never read queued payloads
   or scan event rows. Queue totals are exact up to a hard scan ceiling. Beyond that ceiling the
   total becomes unavailable instead of becoming a partial count presented as fact. History is
   bounded by time and by 17,280 rows. Rates require two exact samples at least ten seconds apart
   and are always labelled derived.
5. Maintenance is one durable state machine:

   ```text
   idle -> pause -> drain -> checkpoint -> optimize -> verify -> resume -> completed
              \----------------------------------------------------------> failure
   failure -> recovery -> a valid continuation phase
   ```

   An atomic directory lock permits one maintenance owner. A live owner blocks a second operation.
   A dead or ownerless lock converts unfinished durable state to `recovery` before work continues.
   Queue drain is bounded and repeatable. Storage optimization checks exact queue state and free
   space, checkpoints WAL, verifies integrity and logical equality, atomically replaces the store,
   and restores the pre-operation pause state. A failure preserves queued input and the original
   store; it is never reported as completion.
6. Alert policy is evaluated locally from health transitions. Deduplication keys prevent repeated
   observations from generating repeated notifications; acknowledgement persists until recovery;
   cooldown applies to a new episode; recovery is its own transition. The core depends on an
   `AlertSink` interface. The shipped transport is an opt-in, best-effort native desktop
   notification containing minimized alert metadata; it can be replaced without contaminating
   policy evaluation.
7. Configuration persistence similarly has an `OperationalConfigBackend` interface. The shipped
   file backend is the only implementation and the only authority. This is an extension seam, not
   a premature hosted configuration service.
8. Diagnostic bundles use an allowlisted manifest and a separately testable recursive redactor.
   They include version data, effective policy with source labels, aggregate health and alerts,
   bounded operational log tails, and an on-demand SQLite quick check. They exclude raw events,
   transcripts, prompts, commands and output, tokens, secrets, and identifying paths. Previewing the
   manifest performs no integrity query and writes no bundle.

## Concurrency and restart behavior

Configuration writes may carry an expected revision. A stale API writer receives a conflict and
must reload before trying again. Same-directory rename makes readers see either the previous or next
complete configuration. An invalid current file falls back to the previous valid copy; if neither
is valid, safe defaults apply and optional model calls remain off.

Health history is disposable aggregate telemetry local to the user's machine. Losing its newest
sample affects only estimates; it cannot affect ingestion or stored evidence. The sample interval
and retention are re-read from effective policy, and an absolute row cap remains in force even if a
future migration accepts a broader time window.

Maintenance state is progress evidence, not permission to assume a step succeeded. After a crash,
the durable phase and stale-lock recovery identify the interrupted boundary. Copy-and-swap storage
verification retains its existing rollback guarantees. An already optimized store is an idempotent
completed operation and does not pause collection or drain the queue.

## Consequences

Operators receive the same answer in text, JSON, API, and the Ingest & Storage rail. Exact values
and estimates cannot be confused by presentation code. Automation has stable versioned documents,
while older collection and explainer endpoints remain compatibility projections.

The local daemon performs a small amount of additional bounded work. It stores aggregate health
rows and a maximum of 100 alert episodes. There is still no Salidium telemetry, required
cross-platform tray, second daemon, or required cloud account. The optional macOS menu-bar process
is a user-installed control and supervision layer, not another event or policy authority.

The configuration-backend and alert-sink interfaces permit future integrations, but SQLite remains
the authoritative event store and the local file remains the shipped configuration authority. A
future hosted product must cross the separate trust boundary intentionally rather than substituting
itself into ingestion, maintenance, or evidence durability.

## Rejected alternatives

- Keep separate CLI and UI health calculations: they would drift on availability and estimate
  semantics.
- Sample event rows for health trends: it adds unbounded recurring work and unnecessary exposure to
  session content.
- Treat a capped queue scan as an exact partial total: it turns a safety bound into a false fact.
- Run optimization while the daemon writes: it weakens the already-verified copy-and-swap contract.
- Clear stale maintenance files silently: it erases the only durable evidence of an interrupted
  phase.
- Expose every internal constant as configuration: it lets ordinary preferences defeat collection
  and storage safety invariants.
- Add a tray or watchdog as a requirement: the browser is only a control panel, native
  notifications cover daemon-observed transitions, and CLI control remains available without a
  resident platform-specific shell. Detecting the daemon's own death requires an external
  supervisor.

The shipped macOS-only always-on option supplies that external supervisor and a menu-bar shell when
the user explicitly installs it. It remains optional, separate from the version 1 operations
contract, and does not make a resident platform process a requirement for local operations on other
systems.
