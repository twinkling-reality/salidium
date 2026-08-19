# Architecture

This document describes the technical contract of the public local product. It intentionally omits
private development measurements, personal session data, and operational notes.

## Design principles

Salidium is built around five rules:

1. **Observed facts and agent claims are different things.** A command result can establish that a
   check passed; an agent sentence can only establish that the agent said it passed.
2. **Evidence remains attributable.** Derived facts retain provider, session, record, and source
   references so a reader can inspect the supporting record when it is still available.
3. **Unknown is a valid result.** Missing or ambiguous evidence is not converted into success.
4. **The deterministic report works locally.** Storage, reduction, HTTP serving, and the interface
   do not require a Salidium account or hosted service.
5. **Provider-specific input stops at the adapter boundary.** The rest of the product consumes a
   canonical event protocol.

## System flow

```text
provider hooks ──▶ failure-safe relay ─┐
                                      ├─▶ adapter ─▶ canonical events ─▶ SQLite
provider session files ─▶ tailer ─────┘                              │
                                                                      ▼
                                                reducer ─▶ run state + change log
                                                                      │
                                           loopback HTTP/SSE ─▶ CLI and interface
```

Hooks give low-latency notification. Provider session files are the durable source and support
history import, restart recovery, and richer records. The reducer reconciles both channels rather
than treating arrival order as truth.

## Package boundaries

- `packages/protocol` owns runtime-validated events, provenance, semantic changes, and wire shapes.
- `packages/core` owns pure reduction, projections, verification parsing, review rules, replay, and
  redaction.
- `packages/adapter-kit` defines adapter-facing contracts.
- `packages/adapters/*` translate provider hooks and session records into canonical events.
- `packages/daemon` owns discovery, ingestion, persistence, explanation scheduling, and the
  authenticated loopback server.
- `packages/ui` renders the report and folds live changes from the daemon.
- `packages/cli` owns setup, recovery commands, text output, and the single published bundle.
- `apps/site` contains the public website and documentation surface.

Workspace packages are not published independently. The npm CLI bundle includes the runtime pieces
and built interface it needs.

## Canonical events and state

Provider adapters emit events with deterministic identifiers, exact UTC millisecond timestamps,
provider provenance, and the smallest useful payload. Explicit RFC 3339 provider offsets are
normalized at the adapter boundary. A transcript record with a missing or invalid timestamp emits
only a deterministic ingest warning at the parser's observation time; it is not assigned an epoch
or neighboring provider time. Examples include session and turn boundaries, agent messages, tool
calls and results, file edits, verification runs, permissions, and usage reports.

Hook and durable-session records use channel-specific identifiers. When both describe the same
activity, the reducer uses information content first and durable provider records as the tie-break.
That rule makes hook-first and transcript-first ingestion converge on the same state.

`applyEvent(state, event)` is deterministic and produces semantic changes as well as the next run
state. Checkpoints carry a reducer version. When reducer semantics change, persisted events can be
replayed to rebuild compatible state and history.

The state model preserves distinctions that matter to a reader:

- reported, inferred, and directly observed evidence
- running, passed, failed, partial, and unknown outcomes
- root-agent and delegated-agent activity
- current work and historical changes
- ordinary review items and conflicting terminal evidence

Contradictory terminal results are merged into an explicit source conflict rather than allowing the
first arrival to win.

## Storage, durability, and recovery

The daemon stores sessions, events, changes, checkpoints, source cursors, and summaries in SQLite.
Writes use transactions and WAL mode. An event batch is durable before its source cursor advances,
so a crash can cause replay but should not skip accepted input.

Session roots are rediscovered after startup. This covers a provider directory that appears only
after onboarding. File watching is a latency optimization; periodic scans remain the recovery path.
Explicit re-ingestion writes durable per-file jobs. Those exact paths run before age-limited
discovery, survive crashes, and remain retryable when a provider file is temporarily missing.
The evidence-schema migration queues both every source cursor and every distinct provider-file path
preserved in event provenance. This recovers old sessions whose cursor row was lost, so fingerprint
and legacy Claude collision repair does not depend on a user discovering a maintenance command.

The session event stream replays only from a contiguous persisted cursor. If a client is more than
50,000 events behind, requests a cursor ahead of the store, or encounters a retained-history gap,
the daemon returns a typed resnapshot response before opening SSE. The interface then discards the
old stream generation, loads a fresh snapshot, and reconnects from its new sequence.

Hook delivery is asynchronous and must never block the coding agent. If the daemon cannot be
reached, each hook invocation writes its own spool envelope and atomically renames it ready. The
daemon atomically claims ready files before ingestion. Legacy shared spool files remain readable for
upgrade recovery, but new senders never concurrently append to one record.

User settings and provider settings are replaced with same-directory temporary files and atomic
renames. Existing invalid explainer settings fail closed so corruption cannot silently resume model
calls. Missing settings still receive the documented first-run default.

The store rejects a schema created by a newer Salidium version. Older schemas are migrated in one
offline transaction before hooks or the HTTP listener start; derived checkpoints and change logs are
replayed when their reducer contract changes.

Session retention defaults to `forever`. A user can opt into 30, 90, or 365 days; after startup
discovery has had time to identify live work, the daemon removes complete inactive sessions in
bounded hourly batches while preserving source cursors and tombstones so old provider files cannot
resurrect deleted sessions. Currently loaded and pinned sessions are excluded; stored status is not
trusted as the only liveness signal. Aggregate token usage is rolled forward before automatic
expiry. `salidium retention compact` performs an integrity-checked offline compaction after a
free-space preflight; cleanup itself leaves pages available for SQLite to reuse. Large new checkpoints use
a versioned fast gzip encoding; existing plaintext checkpoints remain readable, and corrupt cache
rows are discarded in favor of replaying the authoritative event log.

Structured and launcher logs use bounded numbered rotation. Logs contain operational fields rather
than transcript content.

The CLI and daemon exchange version metadata. A compatible current daemon can be reused; an older
daemon must be restarted before the current CLI treats it as its own service.

## Provenance and raw evidence

An event may carry a source reference containing the provider file, line, record identifier, and a
SHA-256 identity for the trimmed provider record. Opening raw evidence re-reads that local record,
checks its identity, and applies output redaction before returning it.

If the source file was deleted, rotated, or rewritten, Salidium returns an explicit unavailable or
changed-source reason. It does not display whatever unrelated record now occupies the old line.
Older stored records may lack a fingerprint until they are reingested. The schema upgrade queues
every cursor and event-referenced provider file durably for that repair; missing files remain
visible and retryable.
Legacy Codex rows without either an inline or sidecar fingerprint fail closed rather than treating
the current file line as historical evidence. Fingerprint backfill only succeeds when the parsed,
redacted event still matches the immutable stored event apart from its fingerprint and sequence.

Structural suppression runs before general text redaction for credential dumps and reads of
sensitive files. General redaction then replaces recognized secrets with stable placeholders so a
repeated secret remains recognizable without revealing it. Provider records are not copied into a
hosted Salidium service.

## Verification and claims

Verification parsing recognizes common test, build, typecheck, and lint commands and reads the
runner outcome from tool results. A command name alone is not proof. Unsupported wrappers, truncated
output, missing exit information, and contradictory results remain unknown or require review.

Agent prose is classified conservatively into attributed statements such as intent, discovery,
approach, completion, or limitation. Unclassified prose remains available in the record but is not
forced into a report section. `salidium audit-claims` lets a user measure those rules against their
own local sessions without sending the corpus elsewhere.

## Optional generated explanation

The deterministic report does not require a model. The optional explainer invokes the user's chosen
installed Claude Code or Codex CLI with a bounded, redacted evidence packet and a runtime-validated
output schema. The invocation disables tools and treats session content as untrusted data.

Explanation scheduling captures an immutable evidence sequence before the asynchronous invocation.
Events that arrive while a request is in flight cannot make an older explanation claim a newer
evidence position. Failures are recorded as failures, and explanation can be disabled completely.

The provider CLI may contact its own service and consume the user's plan or API allowance. Salidium
does not hide that network boundary or describe generated text as observed fact.

## Local security boundary

The daemon binds to `127.0.0.1` and requires a random bearer token stored in `daemon.json`. Requests
also enforce local host and origin rules. The state directory is created with owner-only
permissions, and sensitive files use owner-only modes.

Hook installation invokes an absolute relay path. The relay uses a trusted shell, resets its
environment and path, bounds request time, and sends authentication through curl configuration on
standard input instead of process arguments.

This protects the local service from ordinary cross-origin access and accidental disclosure. It is
not a sandbox against another process already running with the same operating-system user account.

There is no Salidium telemetry in the local product. A future hosted service must be an explicit,
separate trust boundary; see [open-source-boundary.md](open-source-boundary.md).

## Extension boundaries

The adapter boundary separates provider parsing from canonical reduction. Provider identifiers are
runtime-validated; built-ins use reserved names and extensions use a namespaced `owner/name`. The
daemon registers versioned provider descriptors explicitly, rejects duplicate or incompatible
descriptors, and does not search the current project or `node_modules` for executable code. A new
provider still needs file matching, parsing, deterministic identifiers, provenance, hook mapping
where supported, synthetic fixtures, and reconciliation tests.

That registry is an internal and embedding seam, not a claim that the installed CLI supports
third-party plug-ins. The CLI currently ships and configures only Claude Code and Codex. A safe
external provider system first needs a separately published stable adapter SDK, one descriptor that
also declares setup, display, and capabilities, runtime contract tests, explicit user-declared
absolute manifests, and process isolation with narrowly granted roots and hook capabilities.
Salidium will not auto-discover project dependencies: a transcript reader executing an arbitrary
package found in the observed repository would cross the product's trust boundary.

Persistence follows a different rule. `SalidiumStore` is an internal and test boundary, but SQLite
remains the sole authoritative event store used by the CLI. Replacing that authority at runtime
would make transactions, replay, migrations, retention, and raw-evidence guarantees depend on a
plug-in. Future external storage should therefore consume a versioned outbox, export, or replication
stream while SQLite retains local authority, rather than substitute an arbitrary backend.

### Intelligence sync foundation

Store schema 6 adds empty `sync_*` and `intelligence_*` tables. The migration performs no historical
backfill, creates no identity or destination, and enables no network activity. A destination creates
a stable random replica identity and two independently ordered durable lanes: data for puts and
control for consent, revocation, deletion, and scope fences. Control can therefore overtake data
that was queued while a device was offline. Senders read only committed SQLite rows; live registry
listeners are not an authority because they can fire before the local transaction commits.

The export unit is never a canonical event, checkpoint, `RunState`, or provider record. Those forms
contain prompts, commands, diffs, output, working directories, transcript paths, and source
identifiers. A strict allowlisted intelligence item contains bounded semantic fields and opaque
evidence descriptors. The local evidence map retains the provider lookup separately. Unknown fields
are rejected, not silently stripped. Secret redaction remains defense in depth and is not treated as
export minimization.

The contract vocabulary distinguishes observations, attributed claims, decisions, intentions,
commitments, outcomes, entities, relationships, explicit and inferred preferences, durable memory,
and inference. It separates verification state from calibrated probability, and working memory is
not durable. Phase 0 deliberately produces only explicit user-confirmed decision threads: selected
option, rejected alternatives, rationale, owner, scope, status, lifecycle, and corrections or
supersessions. Existing agent-message classification and model output cannot promote themselves to
a decision.

Every operation has a local stream and replica namespace, lane position, stable operation id,
predecessor, and canonical content digest. A receiver must treat the same position and same digest as
replay, and the same position with different content as a security conflict. Batch acknowledgement
means durable transport acceptance only. Deletion completion is a separate receipt covering hosted
projections, search, embeddings, caches, and the backup restore fence; local tombstones remain until
that fact can be reconciled.

Reusable contracts needed by a future hosted service belong in this repository. Accounts, billing,
team synchronization, hosted retention, organization administration, and managed-service operations
do not.

## Known limitations

- Claude Code and Codex own their session formats; adapter updates may be needed when those formats
  change.
- Native Windows history import is supported, but the live hook relay currently requires POSIX
  `sh` and `curl`.
- Raw evidence depends on local provider files. The upgrade can recover fingerprints only while the
  provider source still exists; deleted source cannot be reconstructed.
- Claim and verification classifiers are conservative heuristics and must be evaluated on diverse
  corpora. Unknown results are expected.
- Retention is opt-in and physical database compaction is offline; the default keeps session history
  forever.
- The installed CLI does not yet load third-party provider packages. The descriptor and store
  factory surfaces are internal and embedding contracts, not an executable plug-in marketplace.
- Large per-session change histories are served as a whole rather than cursor-paged.
- The schema-6 outbox has no destination UI or network sender yet and syncs nothing by default.
- Raw evidence is local. A second device may receive the confirmed decision and an explicit
  source-unavailable state, never a claim that an opaque evidence reference is remote proof.
- Phase 0 defines transport and lifecycle invariants, not demonstrated retrieval quality or product
  value. Cross-device recall remains gated on a released contract and an evaluated hosted consumer.

These limitations are product constraints, not reasons to weaken the evidence model. Until a case
can be supported, the report should say less or say unknown.
