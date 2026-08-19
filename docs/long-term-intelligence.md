# Long-term intelligence foundation

This document records what the current product can honestly support and the smallest path from
local evidence to useful continuity. It is an architecture and evaluation contract, not a promise
that Phase 0 already learns or recalls context.

## Evidence-backed audit

The public product already has strong raw ingredients. Provider adapters create deterministic event
identities and preserve source provenance. The reducer distinguishes observed verification from
agent-reported claims, makes contradiction visible, and can abstain. SQLite is the authoritative
event and lifecycle store. Redaction, offline retention, Forget tombstones, replay, reingest, and
raw-evidence inspection are implemented and tested.

Those ingredients are not a durable intelligence model. `CanonicalEvent` and `RunState` are local
session structures, not replication records. The claim classifier extracts attributed report kinds
from agent prose; it cannot establish that the user made a decision. Transcript hashes identify
content but do not authenticate its issuer. Redaction targets credential-shaped text and preserves
ordinary confidential text and many paths by design. Current local retention is session-level;
Forget preserves some cursors, tombstone identifiers, usage aggregates, and provider-owned raw
files. A model-generated explanation is intentionally non-authoritative.

Therefore Phase 0 adds a new contract rather than widening any of those structures.

## Semantic model

The public schema keeps concepts structurally distinct:

- observation: directly observed evidence with verification state
- claim: a named speaker's reported statement
- decision: a user-confirmed choice, rejected alternatives, rationale, owner, scope, and status
- intention: a plan that may never become a commitment
- commitment: a user-owned obligation with lifecycle
- outcome: a later result linked to the item it evaluates
- entity and relationship: bounded graph structure without collapsing statements into nodes
- explicit preference and inferred preference: separate authority and confidence rules
- memory: promoted episodic, semantic, decision, procedural, or preference material
- inference: a probabilistic proposition that always remains labelled as inferred

Verification (`verified`, `unverified`, `disputed`, `unknown`) is not a number. Confidence is a
calibrated probability with a method version and applies only to probabilistic inference. Repeating
the same provider text does not create independent evidence. Every durable item records authority,
independence group, effective interval, sensitivity, finite retention, consent revision, lifecycle,
and correction/contradiction links.

Working memory is session-local and never enters the durable item union. Model evidence alone may
not establish an observation, decision, explicit preference, or procedure. Procedures require an
allowlisted representation and explicit review before any future execution surface exists.

## Smallest end-to-end product slice

The first producer is an explicit **Save and sync this decision** action, not automatic extraction.
Its preview shows the exact bounded fields, account and destination, project or personal scope,
audience, sensitivity, retention, the fact that raw evidence stays local, and how to revoke or
delete. Sync consent is off by default and separate from permission to edit provider hooks or invoke
an explainer.

The complete future loop is create, preview and consent, durable local enqueue, receive on a second
device, display a visible dismissible resumption card, inspect why it was recalled and whether raw
source is locally available, correct or supersede, export, revoke, and delete. A recalled decision is
reported context, not silent prompt material or a replacement for an ADR, issue, or repository doc.

Phase 0 implements the released contract candidate and local durable outbox only. Until a released
version is pinned by the private repository, this must be described as a protocol alpha, not
cross-device intelligence.

## Retrieval and lifecycle policy

Future retrieval must first enforce authenticated tenant, current membership, consent epoch, scope,
sensitivity, expiry, status, supersession, and deletion. Those filters run before keyword or vector
candidate generation and every cache key includes the same boundary. A derivation inherits the
intersection of all evidence scopes, maximum sensitivity, and earliest expiry; it can never broaden
visibility.

Within the eligible set, rank by kind-specific relevance, effective time, freshness, authority,
independent evidence, outcome quality, and contradiction state. Show why a record was recalled.
Prefer abstention over a semantically similar item from another project or time. Surface conflicts
and negative outcomes; never choose an unqualified winner. Superseded, deleted, revoked,
out-of-scope, or expired decisions are ineligible, and rejected alternatives can never render as the
chosen option.

Correction, supersession, retraction, expiration, revocation, and deletion are append-only ordered
operations. Revocation synchronously fences retrieval and new derivations, then drives asynchronous
purge. Deletion traverses evidence lineage through structures, memories, inferences, embeddings,
search, caches, materializations, exports, and backup fences. Restore replays tombstones before data
is served. Survivor inventories and deletion service levels must be explicit; neither SQLite
compaction nor provider-owned raw file deletion can be implied.

## Evaluation contract

Transport metrics prove plumbing only. Outbox drain rate, operation counts, replay success, and card
views are not evidence that work improved. Evaluate three layers independently:

1. Capture quality: chosen vs rejected accuracy, rationale and scope fidelity, correction and
   deletion success, and user understanding of the consent preview.
2. Retrieval quality: eligible-set precision, harmful recall, contradiction visibility,
   source-unavailable accuracy, abstention, and zero lifecycle/scope violations.
3. Downstream value: paired realistic resumption tasks against normal repository docs and search,
   independently adjudicated for accurate resumption, repeated investigation, incorrect
   recommendations, and time to verified progress.

Pre-register eligible resumptions and count no-recall cases in the denominator. Stratify by age,
project, source availability, conflict, outcome, and device. The value gate passes only when the
lower confidence bound for accurate-resumption improvement over the realistic baseline is above
zero with no increase in incorrect recommendations. Model judges and developer-written happy paths
alone are insufficient.

## Phases and gates

- Phase 0: public strict contract, compatibility fixtures, empty schema migration, explicit
  decision producer, durable minimized two-lane outbox, reconciliation inventory, and separate
  deletion receipts. Publish only after approval.
- Phase 1: private tenant-safe ingestion pinned to the released contract, authenticated device
  identity, audit, consent/revocation races, deletion lineage, and a second-device decision card.
- Phase 2: outcome capture, conservative retrieval evaluation, contradictions and staleness, then
  narrowly reviewed memory promotion.
- Phase 3: team scope only after personal scope proves isolation, deletion, inference inheritance,
  and useful calibrated abstention.

The release gate includes packed-artifact compatibility; unknown-field and oversize rejection;
path/prompt/command/diff/output canaries; duplicate, gap, conflict, lost-ack and cursor-ahead replay;
crash/offline revocation and deletion; cross-tenant and scope substitution; poisoned repetition,
staleness and prompt injection; identity revocation; audit leak scanning; backup restore fences; and
oldest/newest supported contract consumers. No gate may be replaced by a transport dashboard.
