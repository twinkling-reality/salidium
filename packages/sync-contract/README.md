# `@salidium/sync-contract`

Runtime-validated, experimental `0.x` contracts for Salidium's consent-gated intelligence outbox.
The package is intentionally independent of Salidium's canonical events, reducer state, daemon,
storage interfaces, provider adapters, and raw-evidence paths.

Version 1 supports personal continuity only. Authenticated service context, not payload fields,
determines the hosted tenant and principal. Raw transcripts, rollout records, prompts, commands,
outputs, diffs, local paths, provider identifiers, and raw-record hashes are not contract fields.

The schemas define the complete intelligence vocabulary, while Phase 0's local producer emits only
explicitly user-confirmed decision threads. Other item kinds are contract vocabulary for later,
separately evaluated producers; their presence is not permission to infer or upload them.
