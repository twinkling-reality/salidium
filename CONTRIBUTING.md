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

### Screenshots

Every image in the README and the documentation is a screenshot of the running product, produced by
`scripts/capture-demo.mjs`, `scripts/capture-docs.mjs` and `scripts/capture-tour.mjs`. Each boots
the seeded fixture in `scripts/demo-daemon.mjs`, drives the real interface, and writes into
`apps/site/public`. Read `scripts/capture-context.mjs` before changing any of them: the fixture's
clock, timezone and locale are pinned and the shutter refuses a frame until two agree, so two runs
of unchanged code produce identical bytes. Prove that before committing a capture change, and do
not commit churn you cannot attribute to a real change. The tour needs an ffmpeg with GIF support
on the path; the one Playwright bundles is built without it.

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
