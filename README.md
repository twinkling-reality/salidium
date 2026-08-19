# Salidium

**Understand what your coding agent did.** Salidium turns Claude Code and Codex sessions into a
clear, evidence-linked report of what changed, why, what was verified, and what needs you.

```bash
npx salidium
```

Salidium is [MIT-licensed](LICENSE), open source, and local-first. The report, event store, and
interface run on your machine with no Salidium telemetry. Raw transcripts stay local. Optional
generated explanations send a bounded, redacted excerpt through your installed agent CLI, which
may contact its provider; they can be turned off.

## See the work without reading every line

```text
Agent response                         Salidium report
──────────────────────────────         ──────────────────────────────
"The cursor advanced before the        WHY
storage transaction committed..."  →   Evidence could be lost before storage was durable.

"I now queue the record, flush,         HOW
then advance the cursor."           →   Queue the record. Flush storage. Advance the cursor.

test/build output                   →   VERIFIED  42 tests passed
unsupported agent claim             →   REVIEW    Claim needs evidence
```

Salidium gives you:

- **What changed** across the agent's work and files.
- **Why and how**, with reported reasoning kept clearly attributed.
- **Verified results** parsed from real test, build, typecheck, and lint output.
- **Left and Review** for unfinished work, failures, unknowns, and claims needing a person.
- **Evidence and Rewind** to inspect the original record or reconstruct an earlier moment.

Supported agents: **Claude Code** and **Codex**. On first run, Salidium finds them, shows the local
settings it wants to update, asks permission, and opens the local interface. Node.js 24 or newer is
required.

## Trust model

The complete account-free local product lives in this repository. A hosted Salidium service may
later provide cross-device or team coordination, but the local product does not require it and raw
provider evidence remains local by default. Read the
[open-source and hosted-service boundary](docs/open-source-boundary.md) for the exact public and
private split.

Optional generated explanations send a bounded, locally redacted excerpt through the Claude or
Codex CLI you selected; that CLI may contact its provider and use your plan or API allowance. Set
`SALIDIUM_EXPLAINER=off` to disable them. The fact-based report still works.

## Learn more

- [Using Salidium](docs/using-salidium.md): setup, report guide, commands, privacy, and recovery
- [Architecture](docs/architecture.md): evidence, replay, storage, and extension boundaries
- [Long-term intelligence](docs/long-term-intelligence.md): memory, retrieval, consent, and evaluation
- [Evaluation protocol](docs/evaluation-protocol.md): how a future recall claim would have to be proven
- [Contributing](CONTRIBUTING.md) and [security policy](SECURITY.md)

## Development

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run from source with `pnpm salidium`. The public CLI is bundled as one self-contained script; the
separately releasable `@salidium/sync-contract` contains only strict interoperability schemas.
