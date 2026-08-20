# ADR 0001: Publish a minimized intelligence sync contract

- Status: accepted for implementation; publication requires explicit approval
- Date: 2026-08-19

## Context

The local protocol is private, session-oriented, and contains sensitive fields. The released CLI is
bundled and intentionally has no import surface. The hosted repository may depend only on a
released, versioned public contract, while local SQLite must remain authoritative.

## Decision

Create the separately versioned public `@salidium/sync-contract` package and the public-source,
private-workspace `@salidium/sync` implementation. The contract exports strict runtime validators
for minimized items, immutable consent revisions, two-lane operations, bounded batches,
acknowledgements, deletion receipts, and reconciliation inventories. It exports no canonical event,
reducer, store, provider, raw evidence, or transport implementation.

Schema 6 adds empty sync tables with no backfill or connection. Phase 0 produces only explicit
user-confirmed decision threads. The outbox is written in the same local SQLite authority and read
only after commit. Control-lane consent and deletion can overtake data. Evidence paths and provider
ids remain in an opaque local map and never enter serialized operations. Publishing is a manual
provenance-backed approval gate; the private consumer starts only after it can pin that release.

## Consequences

The public contract incurs real compatibility cost, so it begins experimental at 0.x with retained
fixtures. Evolution is not additive and should not be described that way: every message is a strict
object and the wire version is a literal, so a field added later is rejected by an already-released
consumer. That is deliberate, because the hosted boundary requires unknown fields to fail closed and
a permissive extension bag would be an over-collection channel. The cost is that adding a field is a
new package minor version and a coordinated consumer bump, which is affordable only while the
consumer set is small and known. It is the reason the release gate keeps a retained fixture for
every operation type and message before a version ships, and the reason publishing before a real
consumer has exercised the wire is expensive rather than merely early.

Transport acceptance and deletion completion stay distinct. Cloud tenant identity is absent from
payloads because it must come from authentication context. The broad
semantic vocabulary prevents future collapse of claims, decisions, preferences, and inferences, but
does not activate unimplemented producers.

## Rejected alternatives

- Publish `@salidium/protocol`: exposes local session internals and creates unsafe coupling.
- Sync canonical events, checkpoints, transcripts, or `RunState`: over-collects raw content and
  mistakes secret redaction for export minimization.
- Consume a workspace path, branch, copied types, or unpublished tarball privately: violates the
  repository boundary and makes provenance and compatibility unverifiable.
- Subscribe to live session listeners: can observe state before the authoritative transaction.
- Replace SQLite with hosted storage through `SalidiumStore`: weakens local replay, retention, and
  raw-evidence guarantees.
- Start with automatic decision mining, summaries, or a generic vector store: manufactures
  authority and cannot prove decision lifecycle semantics.
- Call an outbox a product slice: proves transport, not accurate or useful resumption.
