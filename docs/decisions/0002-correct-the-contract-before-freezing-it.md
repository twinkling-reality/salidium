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

## Open decisions that publication would foreclose

These are design questions, not defects, and each one becomes a breaking change the moment a version
ships. They are recorded here rather than settled unilaterally.

1. `exportDigest` is recomputable from the sibling fields it accompanies, so it commits to nothing.
   Give it something a receiver cannot recompute, or remove it.
2. `EvidenceReference` carries no scope, sensitivity, or expiry, so the derived-scope rule the threat
   model treats as core (intersection of scopes, maximum sensitivity, earliest expiry) is not
   computable by a receiver. Add the fields or record that the rule is producer-asserted in v1.
3. `SyncAckV1` can reject an operation but cannot express terminal refusal, so a permanently refused
   operation stalls its lane. Any fix must be lane-asymmetric: letting a destination tell a client to
   skip past a `consent.revoke` or `item.delete` hands it the ability to suppress exactly the
   operations a user relies on.
4. `item.delete` carries `deleteThroughRevision`; `scope.delete` carries no fence at all, and there
   is no cross-lane watermark, so a standalone scope deletion has undefined ordering against queued
   puts.
5. There is no replica generation, so a restore from an older local backup is indistinguishable from
   a fork and reuses lane positions with different content, which this project's own threat model
   classifies as a security conflict.
6. `audience` is not representable and is not derivable from `personal | project` scope. Phase 1 is
   personal-only so nothing needs it yet, but Phase 3 does.
7. There is no wire representation for whether a recalled item helped, which is the measurement the
   Phase 2 gate in [the evaluation protocol](../evaluation-protocol.md) is built on.

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
  fixture is evidence about a released version precisely because the code cannot rewrite it.
- **Treat the free-form prose fields as minimized because secrets are redacted.** Reproduced the
  opposite: paths, commands, diff hunks, names, and identifiers typed into a rationale cross intact.
  Redaction is defense in depth. The control is the consent preview, which does not exist yet, and
  the documentation now says so instead of implying otherwise.
