# ADR 0002: Correct the sync contract before freezing it

- Status: accepted
- Date: 2026-08-19

## Context

`@salidium/sync-contract` was prepared for release and reviewed as if the remaining work were the
release mechanics. A four-lane adversarial review of the contract, the local outbox, and the release
path found defects that publication would have made permanent, and two that meant the artifact did
not work at all.

The decisive fact is that the registry still returns 404 for the package. Nothing depends on it. No
private consumer exists, because the repository boundary forbids one until a released version can be
pinned. Every irreversible consequence below is irreversible only from the moment of publication, so
the unpublished state is the remaining degree of freedom and is worth spending deliberately.

Confirmed by reproduction, not by inspection:

- The packed tarball advertised a `development` export condition resolving to `./src/index.ts`,
  which `files` does not ship. Any consumer requesting that condition, including this monorepo's own
  test configuration, got `ERR_MODULE_NOT_FOUND`. The release workflow's consumer check resolved
  `default` and passed.
- `sealSyncOperation` digested the pre-validation input and returned the post-validation object, so
  any operation relying on a schema default failed the package's own `verifySyncOperationDigest` and
  was rejected by its own `assertSendableBatch`.
- The model-only promotion guard was keyed on `kind` while the semantics live in `layer`, so an
  all-model `memory` with `layer: 'decision'` asserted what a `decision` may not. The threat model
  names model-only promotion a release blocker.
- The local producer defaulted absent evidence to a synthetic `user-explicit` reference, which
  manufactured the exact authority the contract requires a decision to have.
- `independenceId` was minted fresh per citation, so one record cited a hundred times read as a
  hundred corroborating sources, inverting the anti-amplification property.
- One retained fixture existed, a control-lane `consent.put`. The data lane, both deletions, and
  every ancillary message had no frozen coverage, which is why the digest defect survived a
  413-test suite.

## Decision

Fix the defects above on the branch, capture a retained fixture for every operation type and every
top-level message, and hold publication.

The export map describes the tarball and nothing else; workspace-only resolution moves to build
configuration. `contentDigest` is defined over the validated operation, and both sealing and
verification normalize before digesting. The model-only rule is stated three ways: kinds that assert
a fact, kinds that put words in the authenticated user's mouth, and the epistemic status any item may
claim. Evidence is supplied rather than invented. Independence is a property of the source record.
Contract text rejects control, bidi, and zero-width characters; the local producer strips them so a
person's paste buffer is not an error. Durable memory must name what it was promoted from, so
deletion lineage does not stop at the item boundary.

Strictness stays. Every message remains a strict object and the wire version remains a literal.

## Consequences

Evolution is not additive, and ADR 0001 no longer claims it is. Adding a field is a new minor
version and a coordinated consumer bump, which is affordable only while the consumer set is small and
known. That cost is accepted deliberately: the hosted boundary requires unknown fields to fail
closed, and a permissive extension bag would be an over-collection channel in the one place the
design is built to prevent one.

Retained fixtures are write-once and excluded from the formatter. They record what a released wire
version accepted, so they are written while that version is prepared and never regenerated. A
fixture produced by the code under test proves only that the code agrees with itself.

The packed artifact is now verified in CI rather than only at release, under every condition its
export map advertises, by the same committed script the release workflow runs.

## Design decisions taken before the freeze

Each of these becomes a breaking change the moment a version ships, so they were settled while the
package was still absent from the registry and schema 6 still absent from every user's database.

1. **`exportDigest` is removed.** It was computed over exactly the sibling fields it travelled with,
   so any receiver could recompute it from the record it accompanied. It authenticated nothing while
   looking like it authenticated evidence, and the operation's own `contentDigest` already covers
   those fields in transit. The local map keeps an equivalent digest to bind its private row.
2. **Derived scope stays producer-asserted, and says so.** Adding scope, sensitivity, and expiry to
   an evidence reference was rejected: a receiver holds none of the evidence, so it could not check
   the copies, and an unverifiable field reads as a checked constraint. The obligation is documented
   instead, and enforcement belongs where the evidence actually is.
3. **Terminal refusal is acted on, and is lane-asymmetric.** A non-retryable rejection may be
   stepped over on the data lane so it drains, and never on the control lane, which stops until a
   person resolves it. A destination able to say "skip that one" about `consent.revoke`,
   `item.delete`, or a scope fence could suppress precisely the operations a user depends on. A
   cursor that moves backwards is reported and never followed.
4. **`scope.delete` carries `deleteThroughDataPosition`.** It is the only happens-before signal
   between the lanes. A consent revision can also no longer change scope or purpose: a grant is its
   scope, and moving it stranded items captured under the old one and deleted the wrong one on
   revocation.
5. **Operations are namespaced by `replicaGeneration`.** The idempotency key is now (tenant, stream,
   replica, generation, lane, position). A replica restored from an older backup declares a new
   generation and resends what it holds, which is a fact a destination can act on, rather than
   reusing positions with different content, which its own threat model says is an attack.

## Deferred with reasons

- **`audience` is not representable.** Phase 1 is personal-only and nothing can populate an audience
  correctly yet. Adding a field with no producer and no policy behind it manufactures the false
  assurance items 1 and 2 were removed for. It is a Phase 3 prerequisite and a known v2 cost.
- **There is no wire representation for whether a recalled item helped.** That is the Phase 2
  measurement in [the evaluation protocol](../evaluation-protocol.md), and it is not yet clear it
  belongs on this wire at all rather than in the hosted service's own records. Deciding it before
  running the evaluation would be guessing.

## Rejected alternatives

- **Add `src` to `files` so the `development` condition resolves.** Reproduced as still broken: Node
  refuses type stripping inside `node_modules` with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`,
  with or without the flag. It replaces one failure with a less obvious one.
- **Override `exports` through `publishConfig`.** Verified that `npm pack` does not apply it, so the
  packed artifact the release workflow checksums would differ from what is published, breaking the
  chain of custody between the unprivileged verify job and the publisher.
- **Add a reserved `extensions` bag to restore additive evolution.** Directly contradicts the
  hosted requirement that unknown fields fail closed, and creates an unvalidated channel into records
  whose entire purpose is minimization.
- **Publish now and fix forward in 0.2.0.** npm versions are immutable and provenance-backed
  releases are the thing private CI pins. Publishing an artifact that fails its own digest check,
  and that no consumer has exercised, spends the only irreversible move available for no gain.
- **Regenerate the fixtures from the current code at test time.** Proves only self-consistency. A
  fixture is evidence about a released version precisely because the code cannot rewrite it. They
  were regenerated once here, while the version was still being prepared, which is the last moment
  that is honest.
- **Add a reserved extension slot or signature field for a future need.** Considered for
  authenticity and rejected for the same reason as items 1 and 2 above: a field nothing populates
  and nothing verifies is not optionality, it is a claim. Per-operation authenticity is a
  transport-layer concern for the life of wire version 1.
- **Treat the free-form prose fields as minimized because secrets are redacted.** Reproduced the
  opposite: paths, commands, diff hunks, names, and identifiers typed into a rationale cross intact.
  Redaction is defense in depth. The control is the consent preview, which does not exist yet, and
  the documentation now says so instead of implying otherwise.
