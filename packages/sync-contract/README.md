# `@salidium/sync-contract`

Runtime-validated, experimental `0.x` contracts for Salidium's consent-gated intelligence outbox.
The package is intentionally independent of Salidium's canonical events, reducer state, daemon,
storage interfaces, provider adapters, and raw-evidence paths.

Version 1 supports personal continuity only. Authenticated service context, not payload fields,
determines the hosted tenant and principal. Raw transcripts, rollout records, prompts, commands,
outputs, diffs, local paths, provider identifiers, and raw-record hashes are not contract fields.

Read that as a statement about structure, not about content. There is no field for a transcript, so
nothing can extract one into a record; the schema rejects unknown fields rather than stripping them.
But a decision carries free-form prose that a person wrote, and whatever they typed there is what
crosses. The local producer removes credential-shaped text and hidden characters as defense in
depth, which is not the same as minimization: a path, a command, a diff excerpt, a colleague's name,
or a customer identifier typed into a rationale is content the schema has no way to recognize. The
control for that is the consent preview showing the exact payload before it is enqueued, and every
consumer must treat all text fields as untrusted input to escape at render, search, and index
boundaries.

The schemas define the complete intelligence vocabulary, while Phase 0's local producer emits only
explicitly user-confirmed decision threads. Other item kinds are contract vocabulary for later,
separately evaluated producers; their presence is not permission to infer or upload them.

## Receiver obligations

These are requirements on anyone consuming the contract, not implementation notes. A receiver that
skips them is not interoperable and, in several cases, is not safe.

- **Validate, then verify.** `contentDigest` is defined over the operation *after* schema validation,
  with `contentDigest` itself removed. Never digest the bytes as received: fields with schema
  defaults, such as `links` and `aliases`, are materialized by validation, so a producer that omits
  one and a producer that spells it out send the same operation. `verifySyncOperationDigest`
  validates internally so that both agree.
- **Derive the tenant and principal from authenticated request context.** No payload field selects
  them. `streamId`, `replicaId`, `originReplicaId`, and every id in an item are client-chosen and
  must be namespaced under the authenticated tenant before use, or one account can address another
  account's stream.
- **Treat same position plus same digest as replay, and same position plus different digest as a
  security conflict**, per lane and per replica. Do not overwrite.
- **Fence deletions against later arrivals.** `item.delete` carries `deleteThroughRevision`;
  `item.put` for that item at or below that revision must stay rejected after the tombstone exists,
  including when the delete arrives on the control lane before the put arrives on the data lane.
  `scope.delete` carries `deleteThroughDataPosition`, the producer's highest data-lane position when
  deletion was requested. Keep it: it is the only happens-before signal between the lanes, and a put
  arriving later but produced at or below that position is still covered. A put above it was
  produced after the request and is not.
- **Recheck consent at ingest, not only at capture.** An operation cites the grant revision that was
  current when it was produced. An offline device can present operations authorized by a grant that
  has since been revoked, and the receiver, not the producer, is the authority on that.
- **Treat a derivation's scope as producer-asserted, not receiver-verified.** The rule a derived
  record inherits the intersection of its evidence scopes, the maximum sensitivity, and the earliest
  expiry is real, but an evidence reference is an opaque handle to material the receiver never holds,
  so the receiver cannot check it. Version 1 deliberately does not carry producer-asserted copies of
  those properties, because a field a receiver cannot verify reads as a checked constraint and is
  not one. Enforce the rule where the evidence actually is, and record derived scope as asserted.
- **An acknowledgement means durable transport acceptance and nothing else.** It does not mean the
  record was projected, indexed, retrievable, or deleted. Deletion completion is a separate receipt
  covering every named sink.

## Status

Experimental `0.x`. The wire version is pinned to `1` and every message is a strict object, so an
added field is a new package minor version and a coordinated consumer bump rather than a silent
extension. Pin an exact version and integrity hash. Retained fixtures under `fixtures/` are the
compatibility evidence for a wire version and are never edited after that version ships.
