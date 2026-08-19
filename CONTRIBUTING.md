# Contributing

Thank you for helping improve Salidium. This repository is the complete MIT-licensed, open-source,
local-first product. The exact public and hosted split is documented in the
[open-source and hosted-service boundary](docs/open-source-boundary.md).

## Development

Requirements: Node.js 24 or newer and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Changes to provider adapters should include synthetic provider records and tests for deterministic
identifiers, provenance, redaction, and hook/session-file reconciliation. Changes to reduction or
history semantics should include replay tests and, when required, a reducer-version update.

## Data and repository hygiene

Never commit real provider transcripts, rollout files, hook payloads, SQLite databases, logs,
screenshots containing session data, provider settings, credentials, or raw user prompts. Replace
names, paths, repository identifiers, tokens, timestamps, and message bodies with synthetic values.

Do not publish private corpus sizes, costs, timing measurements tied to a person or machine, or
internal release and account operations. Reproducible benchmark methodology and synthetic results
are welcome when they are needed to justify a product boundary.

Put local handoffs, audits, corpus measurements, and planning notes under `.private/`, or use a
`.private.md` or `.internal.md` suffix. Those locations are ignored. Public architecture decisions
belong in `docs/` and should describe the durable contract rather than a private work diary.

Before opening a pull request, review the entire diff—including generated and binary files—and run
the checks above. Report suspected vulnerabilities or accidental private data through
[SECURITY.md](SECURITY.md), not a public issue.

## Contributions and licensing

By submitting a contribution, you agree that it is provided under this repository's MIT license
and that you have the right to submit it. Do not include code or data whose license or ownership is
unclear.
