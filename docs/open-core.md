# Open-core boundary

Salidium has one canonical repository: `twinkling-reality/salidium`. This repository contains the
complete local product and is licensed under the root MIT license.

## What stays in the public core

Everything needed to run Salidium locally stays here:

- the CLI and provider setup
- Claude Code and Codex adapters
- canonical events, reducers, verification, redaction, and evidence provenance
- the local daemon, SQLite storage, recovery paths, and loopback API
- the interface, site, and documentation
- local explanations, explanation preferences, and local personalization
- the minimized sync contract, local outbox, consent, export inspection, and deletion-fence logic

A developer must be able to inspect, build, test, and use the local product without an account or a
hosted Salidium service. Local capabilities will not be removed or deliberately weakened to create
a paid tier.

## What may be commercial later

A future hosted service may provide capabilities that inherently require managed infrastructure or
coordination, such as:

- accounts and billing
- cross-device and team synchronization
- hosted retention and sharing
- organization administration and access control
- managed integrations, support, and service guarantees

That service would live in a separate private repository and depend on versioned interfaces from
this public core. It must not copy, fork, or privately diverge the current local product code.

## Repository and licensing rule

There is no private product area inside this repository and no second repository containing a copy
of its current code. The root MIT license covers the entire current tree. Any future hosted-service
repository must keep the dependency direction one way: hosted service to public core.

If a hosted capability needs a new reusable event, adapter contract, storage boundary, or local UI
surface, that general interface belongs here first. Service credentials, account data, billing
logic, organization policy, and hosted operational code do not.

`@salidium/sync-contract` is the first deliberately publishable library. It is narrow: strict
runtime schemas, digest and batch rules, compatibility fixtures, acknowledgements, deletion
receipts, and reconciliation inventories. It does not export canonical events, reducers,
`SalidiumStore`, provider adapters, local evidence paths, or network code. The local implementation
remains inspectable here in `packages/sync`, with SQLite authoritative and synchronization off until
a person creates a scoped consent grant and a destination using a released compatible contract.
