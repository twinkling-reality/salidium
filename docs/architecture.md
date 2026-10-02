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
- `packages/consumer-contract` owns the versioned read-only contract for other local tools. It
  depends on nothing else in the workspace; see [Consumer contract](#consumer-contract).
- `packages/core` owns pure reduction, projections, verification parsing, review rules, replay, and
  redaction.
- `packages/adapter-kit` defines adapter-facing contracts.
- `packages/adapters/*` translate provider hooks and session records into canonical events.
- `packages/daemon` owns discovery, ingestion, persistence, explanation scheduling, and the
  authenticated loopback server.
- `packages/ui` renders the report and folds live changes from the daemon.
- `packages/cli` owns setup, recovery commands, text output, and the single published bundle.
- `apps/site` contains the public website and documentation surface.

Workspace packages are not published independently, apart from the two contract packages
(`@salidium/sync-contract` and `@salidium/consumer-contract`), which exist to be depended on. The npm
CLI bundle includes the runtime pieces and built interface it needs.

## Canonical events and state

Provider adapters emit events with deterministic identifiers, exact UTC millisecond timestamps,
provider provenance, and the smallest useful payload. Explicit RFC 3339 provider offsets are
normalized at the adapter boundary. A canonical record family with a missing or invalid timestamp
emits only a deterministic ingest warning at the parser's observation time; it is not assigned an
epoch or neighboring provider time. Valid timestamp-free provider bookkeeping that Salidium does
not interpret is ignored instead of becoming a permanent warning. Examples include session and turn
boundaries, agent messages, tool calls and results, file edits, verification runs, permissions, and
usage reports.

Provider adapter contract version 2 requires a declared hook event budget. Each subscribed event is
named once, assigned a pressure class, and paired with the fixed and per-tool-call traffic model that
adapter registration validates. This makes a provider's collection cost reviewable before its hooks
can run.

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

Operational policy is a versioned sparse document in `operations-config.json`. Owner-only,
same-directory atomic replacement retains `operations-config.previous.json` as a recovery copy.
Effective resolution applies shipped defaults, stored choices, and then compatible environment
overrides, and reports the source of every value. Existing `settings.json` explainer preferences and
SQLite retention metadata migrate into this single authority. Invalid current and previous files
fall back to safe defaults, including explanations off, so corruption cannot silently resume model
calls. Provider settings use the same atomic replacement discipline but are not Salidium policy.

The store rejects a schema created by a newer Salidium version. Older logical schemas are migrated
in one offline transaction before hooks or the HTTP listener start; derived checkpoints and change
logs are replayed when their reducer contract changes. Schema 8 creates bounded token-usage read
models and a durable preparation cursor without traversing the historical event archive inside that
startup transaction. After the listener starts, a separate worker advances that cursor in bounded
batches. A crash or deliberate stop leaves the cursor resumable. Historical retention, compaction,
and storage optimization remain deferred or blocked until preparation is complete.

New physical stores use 16 KiB pages. `events` is an ordinary rowid table with a unique
`(session_id, seq)` primary-key index, and JSON payloads at or above 1 KiB use a versioned fast gzip
BLOB. Checkpoints use binary plaintext or gzip BLOBs while retaining legacy text decoding. An
existing physical layout is not a startup migration: `salidium storage optimize` creates a separate
same-directory store, copies every current-schema table, verifies per-table row counts, logical
event and checkpoint SHA-256, and SQLite integrity, syncs it, and atomically replaces the old file. A
hard-linked rollback copy remains until the replacement reopens successfully.

Session retention defaults to `forever`. A user can opt into 30, 90, or 365 days; after startup
discovery has had time to identify live work, the daemon removes complete inactive sessions in
bounded hourly batches while preserving source cursors and tombstones so old provider files cannot
resurrect deleted sessions. Currently loaded and pinned sessions are excluded; stored status is not
trusted as the only liveness signal. Aggregate token usage is rolled forward before automatic
expiry. `salidium retention compact` performs an integrity-checked offline compaction after a
free-space preflight; cleanup itself leaves pages available for SQLite to reuse. New checkpoints use
a versioned binary fast gzip encoding; existing plaintext and base64 checkpoints remain readable,
and corrupt cache rows are discarded in favor of replaying the authoritative event log.

Structured and launcher logs use bounded numbered rotation. Logs contain operational fields rather
than transcript content.

## Local operations

One versioned operations contract joins policy, health, maintenance, alerts, diagnostics, CLI, API,
and the Ingest & Storage rail. The older collection and explainer endpoints remain compatibility
views, not parallel authorities.

Recurring health work reads queue file metadata, SQLite and WAL file sizes, the bounded gap ledger,
maintenance state, and hook configuration. It does not read queue payloads or scan stored events.
Queue inspection stops at its hard file ceiling; if that ceiling is crossed, totals are unavailable
rather than partial. Schema 7 introduced aggregate samples, which are pruned by the configured local
time window plus an absolute 17,280-row cap. Queue velocity, drain rate, storage growth, and time to
empty require two exact observations separated by at least ten seconds and remain labelled
estimates.

Local alerts cover queue age and growth, database size, new gap fingerprints, daemon health,
maintenance failure, and hook-trust change. A bounded owner-only ledger records active,
acknowledged, and recovered episodes. Only state transitions are notification-eligible;
deduplication, cooldown, and acknowledgement prevent repeated polling from becoming repeated
notification. The shipped native sink is opt-in and launches only a trusted operating-system
notification helper with minimized title/detail arguments. It introduces no telemetry or resident
process of its own. When disabled or unavailable, the same ledger remains visible through the API,
UI, and CLI.

The optional macOS always-on layer is a separate supervision boundary. Two owner-scoped
LaunchAgents run a stable copied CLI runtime and a small AppKit status item. Both restart only after
an unsuccessful exit, so a crash recovers while an intentional stop remains stopped. The status
item reads the owner-only `daemon.json`, authenticates to the loopback operations endpoint, and
shows aggregate operational fields; it does not read events or transcript payloads. Menu actions
invoke the copied CLI directly without a shell. LaunchAgent files carry a sanitized executable
search path and local paths, but no bearer token. Install and update compile the helper into a
staging directory and swap it only after compilation succeeds. Disable and uninstall target the two
fixed labels; uninstall leaves the state database, queue, settings, and reports intact.

Queue drain and store optimization share a durable maintenance state machine and atomic directory
lock. Optimization preflight requires completed historical usage preparation, exact queue totals, an
empty queue, and sufficient same-volume free space before the daemon stops. The workflow pauses
collection, checkpoints WAL, copies and optimizes, verifies counts, logical digests and integrity,
reopens the replacement, and restores the prior pause state. Stale locks become explicit recovery
state. Failure leaves queue files and the pre-operation store recoverable rather than erasing
ambiguous state.

`salidium doctor --bundle --dry-run` displays the allowlisted diagnostic manifest without writing or
checking the database. Bundle generation adds an on-demand quick check, aggregate health and alert
state, effective policy, versions, and bounded log tails. Recursive redaction removes secrets and
identifying paths; transcript contents, raw events, prompts, commands and output, and tokens are not
inputs to the bundle.

The daemon core depends on `OperationalConfigBackend`, `AlertSink`, and `SalidiumStore` interfaces.
The shipped implementations remain a private local file, an opt-in native notification sink, and
SQLite. These are test and extension boundaries; they do not introduce a second authority or imply
that hosted providers can replace local evidence durability.

The CLI and daemon exchange version metadata. A compatible current daemon can be reused; an older
ordinary daemon is restarted before the current CLI treats it as its own service. An enabled macOS
always-on installation owns a stable copied runtime instead, so a newer CLI refuses to replace that
daemon implicitly and directs the user to run `salidium service install` first.

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

The `ollama` backend is the route on which nothing crosses that boundary. The daemon itself sends
the same evidence packet to a local Ollama's `/api/chat` over loopback HTTP; there is no agent CLI
in between. The address is the literal `127.0.0.1` or `::1`, from the default or from `OLLAMA_HOST`
only when that names a loopback address (`localhost` is mapped to `127.0.0.1`, never resolved).
Redirects are refused, the response body is bounded by the CLI routes' output ceiling, and the call
shares their concurrency limit, timeout, and cancellation. A model is required and is chosen from
the installed list in `/api/tags`; Salidium never pulls one. Ollama cloud models, which Ollama
proxies to ollama.com, are excluded: `cloud`-tagged names are refused, and each call first asks
`/api/show` and refuses a model described as remote. The guarantee is about Salidium's connection;
whatever listens on the loopback port is trusted as Ollama. The request asks for the JSON Schema
as Ollama's `format` first; on the 501 "structured output is unavailable" answer that MLX builds
give, it retries once with the schema stated in a system message and remembers that per model. The
runtime validation is unchanged, and the explanation's generator label names the model.
`ollama` is chosen only explicitly: `auto` never selects it, and selecting it never falls back to
a CLI when it cannot run.

Personalization is a separate presentation layer. One bounded reader-authored note is kept in an
owner-only local file. An explicit Personalize action saves the note and sends it with the
already-generated technical Why/How diagram to the selected explanation agent. The returned
wording is held in browser memory only: it is not appended to session events, checkpoints, exports,
or a sync outbox. The original technical wording remains available, and clearing the profile removes
the local preference file and cancels work in flight.

## Local security boundary

The daemon binds to `127.0.0.1` and requires a random bearer token stored in `daemon.json`. Requests
also enforce local host and origin rules. The state directory is created with owner-only
permissions, and sensitive files use owner-only modes.

Hook installation invokes an absolute relay path. The relay uses a trusted shell, resets its
environment and path, bounds request time, and sends authentication through curl configuration on
standard input instead of process arguments.

A second, narrower credential exists for other local tools. A consumer credential is created by the
person for one named tool, stored only as a SHA-256 digest in the owner-only
`consumer-credentials.json`, and revoked from the CLI. It opens the read-only `/consumer/v1` routes
and nothing else, and the owner token does not open those routes. The consumer routes are
dispatched before the owner check with their own authentication, so the default for a consumer
credential anywhere else is deny. See [Consumer contract](#consumer-contract).

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

Operational integration follows the same containment rule. A future configuration provider must
implement the versioned backend contract and preserve explicit source and revision semantics. A
future alert destination receives already-minimized transition records through `AlertSink`; it does
not receive events, transcripts, prompts, or store access. Neither seam is active in the shipped
local product.

### Consumer contract

Other tools on the same machine read Salidium through a versioned, read-only contract rather than
the private `/api` protocol or the owner token. [ADR 0005](decisions/0005-read-only-consumer-contract.md)
records the decision; this is the durable shape.

- **Surface.** `GET /consumer/v1/discovery` without a credential; with a consumer credential,
  `/sessions`, `/sessions/lookup?provider=&sessionId=`, `/sessions/{id}/report`, and `/feed`
  (server-sent events). Every other method is refused. Loopback, Host, Origin, and cross-site checks
  run first and are unchanged.
- **Identity.** Sessions are addressed by native identity, the provider id plus the provider's own
  session id, which a tool that launched a session already has.
- **Documents.** `salidium.session-list` v1, `salidium.session-lookup` v1,
  `salidium.session-report` v2, `salidium.session-feed` v1, `salidium.consumer-discovery` v1, and
  `salidium.consumer-error` v1. Every property is always present; unknown values are `null`.
- **Minimization.** The report is a field-by-field projection of the interface's `SessionView` that
  carries findings, not content: Salidium's own wording, observed identifiers and counts, short
  attributed statements, review finding fragments, and the optional generated explanation, each with
  its provenance class. Prompts, full messages, command lines, output, tool inputs, event ids, and
  provider file references have no field; a working session is described by the kind of work, not
  its command. Text is redacted again at the boundary.
- **No side effects.** Consumer reads never load a session coordinator, write a checkpoint, count a
  session as loaded for retention, or schedule an explanation.
- **Discovery.** The daemon writes `consumer.json` beside `daemon.json`, listing every major
  version it serves with its base URL, plus a per-start instance id, and removes it on a clean stop.
  It holds no secret. Everything under `/consumer`, refusals included, answers with contract
  documents.
- **Feed.** Notifications, not state: `resync` on every connection, then `session.changed` with the
  new evidence sequence, `session.removed`, `heartbeat`, and `closing`. No replay; a reader more than
  1 MiB behind is disconnected.
- **Compatibility.** The zod schemas in `@salidium/consumer-contract` are the source of truth; the
  committed JSON Schema is generated from them and checked in tests. Within a major version changes
  are additive only, consumers ignore what they do not know, and the producer is held to the exact
  declared shape.

The consumer credential file is the authority, not the daemon. The CLI edits it under a lock whether
or not the daemon is running, and the daemon re-reads it when its metadata changes.

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
not durable. Phase 0's internal producer accepts only explicit user-confirmed decision threads:
selected option, rejected alternatives, rationale, owner, scope, status, lifecycle, and corrections
or supersessions. Existing agent-message classification and model output cannot promote themselves
to a decision.

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
- The consumer feed does not announce a status that changes through time alone, such as a silent
  session turning from working to idle, and consumer credentials cannot yet be limited to particular
  repositories or managed in the interface.
- The schema-6 outbox has no destination UI or network sender yet and syncs nothing by default.
- Raw evidence is local. A second device may receive the confirmed decision and an explicit
  source-unavailable state, never a claim that an opaque evidence reference is remote proof.
- Phase 0 defines transport and lifecycle invariants, not demonstrated retrieval quality or product
  value. Cross-device recall remains gated on a released contract and an evaluated hosted consumer.

These limitations are product constraints, not reasons to weaken the evidence model. Until a case
can be supported, the report should say less or say unknown.
