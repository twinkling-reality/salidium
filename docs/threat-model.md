# Intelligence synchronization threat model

## Assets and boundaries

Protected assets include local raw evidence, minimized decision records, consent and deletion state,
tenant membership, device identity, retrieval results, derived memories and indexes, audit trails,
release provenance, and encryption/signing keys. Boundaries are the provider-owned raw file, local
SQLite authority, the minimized outbox, the released npm contract, authenticated network ingress,
tenant storage and derivation workers, retrieval, administration, backups, and support access.

Local loopback bearer authentication is single-user process isolation and is not hosted identity.
The hosted tenant, principal, roles, and device must come from verified request credentials, never a
payload field. Every row, key, relationship, queue, object, index, cache, audit event, and background
job is tenant-qualified, with database row policy as defense in depth. Support uses expiring,
reviewed, fully audited break-glass access.

## Principal threats and controls

### Cross-tenant access and inference leakage

Attackers substitute logical ids, exploit pooled connection context, poison shared caches or
indexes, remove membership mid-request, or infer hidden records through counts and timing. Enforce
current authorization on every operation; partition before candidate generation; include tenant,
scope, consent epoch, and policy version in worker payloads and cache keys; use indistinguishable
denials and bounded responses. Derived scope is the intersection of evidence scopes, sensitivity is
the maximum, and expiry is the minimum.

### Over-collection and consent drift

Canonical events contain prompts, commands, queries, diffs, output, working directories, and source
paths. Never serialize them. Strict allowlists reject unknown keys and size violations. Consent is an
immutable revision with purpose, destination, scope, allowed kinds, sensitivity and retention
ceilings, effective period, and policy versions. Every operation cites it. Ingress, derivation, and
retrieval recheck the current epoch. Revocation fences reads synchronously and control operations can
overtake queued data.

### Replay, collision, and downgrade

Per replica and lane, require contiguous positions and predecessor ids. Same position and same
digest is an idempotent replay; different digest is a security conflict and audit event. Reject
cursor-ahead acknowledgements, negotiate supported contract versions, refuse unsafe downgrade, cap
batches, and apply backpressure. Corrections and deletes are ordered operations, never mutation of
history.

### Poisoned, stale, or falsely repeated intelligence

Content hashes are identity, not issuer authentication. Authenticate enrolled devices and keep
channel fidelity separate from authority. Group dependent evidence so copied claims do not amplify.
Keep model output non-authoritative, evidence as inert data, and procedural representations
non-executable. Track active, disputed, corrected, superseded, retracted, expired, and deleted states
with validity intervals. Contradictions force visibility or abstention. Redaction placeholders are
not durable identities because local numbering can be reused after restart.

### Incomplete deletion and resurrection

Deletion follows lineage through ledger, projections, inference, memories, search, embeddings,
caches, materializations, queues, dead letters, logs, exports, and backup fences. Tombstones survive
until a separate completion receipt covers every promised sink and are replayed before a restored
backup serves data. Document retained audit facts and service-level timing. Do not promise forensic
erasure of SQLite pages or deletion of provider-owned files.

### Compromised identity or service

Use enrolled proof-of-possession device keys, short-lived audience-bound tokens, immediate device
and session revocation, reauthentication for export/delete/admin, and short-lived workload identity
with service-specific roles. No service principal has universal cross-tenant access. Rotate keys,
rate-limit replays, and alert on conflicts and abnormal ranges.

### Supply-chain and audit compromise

Publish only the narrow contract from a manual, protected, provenance-enabled workflow. Pin actions,
checksum the artifact between unprivileged verification and publisher jobs, install it outside the
monorepo, prohibit workspace/git/path dependencies, verify the package digest privately, and test
oldest/newest supported versions. A server still rejects raw or unknown fields from a compromised
client. Audit authorization decisions, consent, accepted ranges and conflicts, membership, memory
lifecycle, retrieval reason codes, export, deletion stages, restore fences, keys, service identities,
and contract releases—but never payload content, paths, raw ids, tokens, or unbounded exceptions.

## Required adversarial tests

The ship matrix covers two tenants with identical ids; id substitution on every API; pooled
connections, jobs, indexes and caches; membership removal mid-flight; timing/count leakage; queued,
in-flight, retrying and offline consent revocation; scope narrowing and expiry; duplicate and every
ordering of operations; gaps, lost acknowledgements, malicious digest collisions and downgrade;
delete-before-create and stale upsert after delete; backup restoration; raw-field canaries in every
event kind; 100 repeated false claims against one authenticated observation; prompt-injection text;
model-only promotion; stale and contradicted retrieval; mixed personal/team scope; stolen, expired,
revoked and wrong-audience credentials; break-glass expiry; provenance mismatch and dependency
confusion; and secret/PII/path canaries across every log and audit event.

Any cross-tenant result, forbidden-field upload, rejected-as-selected decision, lifecycle
resurrection, model-only promotion, or missing deletion fence is a release blocker.
