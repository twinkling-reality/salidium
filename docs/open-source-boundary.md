# Open-source and hosted-service boundary

Salidium is an MIT-licensed, open-source, local-first product. The canonical public repository,
`twinkling-reality/salidium`, contains the complete product needed to inspect coding-agent work on
one machine. It works without an account or hosted Salidium service.

## Complete public local product

Everything needed for local use stays public:

- the CLI and provider setup
- Claude Code and Codex adapters
- canonical events, reducers, verification, redaction, and evidence provenance
- the local daemon, SQLite storage, recovery paths, and loopback API
- the interface, site, documentation, and local explanations
- local personalization, retention, session export, and deletion controls

The minimized sync contract and the local outbox are public too, but they are groundwork rather
than a local capability: nothing in the CLI, daemon, or interface reaches them, they are not part of
the published CLI bundle, and they give a person using Salidium today nothing they can turn on. They
are listed here because they must stay public, not because they do anything yet.

Local capabilities will not be removed or deliberately weakened to create a paid tier. A developer
must be able to inspect, build, test, and use this product without a Salidium account.

## Private hosted coordination

A separate proprietary service may provide capabilities that inherently require hosted
infrastructure or coordination:

- accounts and billing
- cross-device and team synchronization
- hosted retention and sharing
- organization administration and access control
- managed integrations, support, and service guarantees

Those hosted operations are not open source, and this repository does not claim otherwise. The
hosted repository may depend only on released, versioned public contracts. It may not copy, fork,
mirror, or privately diverge the local product.

## Repository and licensing rules

The root MIT license covers the entire current public tree. There is no proprietary product area
inside this repository and no private copy of its current source. The dependency direction remains
one way: hosted service to released public contract.

Reusable events, adapter contracts, storage boundaries, schemas, and local user controls land here
first. Hosted credentials, account data, billing, organization policy, and service operations stay
private.

`@salidium/sync-contract` is the first deliberately publishable library. It contains strict runtime
schemas, digest and batch rules, compatibility fixtures, acknowledgements, deletion receipts, and
reconciliation inventories. It does not export canonical events, reducers, `SalidiumStore`,
provider adapters, local evidence paths, or network code. Its local implementation remains
inspectable in `packages/sync`, with SQLite authoritative and synchronization off until a person
creates scoped consent and connects a released compatible destination.
