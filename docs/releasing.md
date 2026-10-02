# Releasing and rollback

The public npm artifacts are the bundled `salidium` CLI and two narrow interoperability packages,
`@salidium/sync-contract` and `@salidium/consumer-contract`. All other workspace packages remain
private.
The website is separate and neither release workflow deploys it.

## Prepare

1. Update the root and CLI versions together and summarize user-visible changes.
2. From a clean checkout run `pnpm install --frozen-lockfile`, `pnpm audit --audit-level high`,
   `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test`.
3. Run `pnpm test:e2e:full`. This must exercise the real daemon in Chromium, Firefox, and WebKit;
   an ordinary push run that covers Chromium alone is not equivalent release evidence.
4. From `apps/site`, run `npm ci`, `npm audit --audit-level=high`, `npm run lint`, `npm test`, and
   `npx wrangler deploy --dry-run`. This validates the release documentation without deploying it.
5. Inspect `npm pack --dry-run` from `packages/cli`, then create the actual tarball once and record
   its SHA-256. Install that exact file outside the monorepo with scripts disabled and fresh
   temporary Salidium and provider homes. Exercise `salidium --version`, first run, authenticated
   and unauthenticated HTTP behavior, `doctor`, the operations CLI, interface assets, and `stop`; do
   not substitute a workspace command for this test.
6. Test a fresh home and an upgrade copy independently. Create the upgrade source with the released
   `salidium@0.3.0`, ingest only synthetic fixtures, and stop it cleanly at schema 6. Open a copy with
   the exact candidate tarball and verify the transactional schema-8 upgrade, responsive collection
   and control while **Preparing token history** is shown, correct eventual usage totals, and no
   missing or duplicate sessions. Interrupt historical usage preparation, restart, and verify that
   it resumes from its durable cursor. Confirm retention, compaction, and optimization remain blocked
   until preparation finishes and work normally afterward.
7. On macOS, install the exact candidate tarball and exercise `service install`, `status`, `disable`,
   `enable`, update over a 0.3.0 copied runtime, and `uninstall`. Verify the menu-bar readings and
   actions, a successful deliberate stop that stays stopped, recovery after an unsuccessful exit,
   separately opt-in native alert and recovery notifications, and preservation of the event store,
   queue, settings, and reports. Finish with the candidate service healthy and collection active.
8. Inspect the complete diff and packed file list for credentials, transcripts, databases, logs,
   provider settings, raw prompts, identifying paths, private measurements, and internal release or
   account state. Check generated and binary files rather than relying only on text search.
9. Confirm a manually dispatched full-browser CI run, including the site job, succeeded for the exact
   current `main` SHA. Do not use an older scheduled run or a Chromium-only push run as the release
   gate. Then create and review a tag named exactly `v<package version>` at that same commit.

For the first public launch, do not change the existing development repository from private to
public: deleted historical files and old workflow references can remain retrievable. Preserve and
checksum a private full-history bundle, create the public repository from one reviewed snapshot
commit, and push no old branches, tags, or other refs. From an anonymous account, clone the public
repository and repeat the secret/private-data scan before creating the release tag. Enable private
vulnerability reporting, secret scanning and push protection, and protect `main` and release tags.

## Publish

Use the **Release CLI** GitHub Actions workflow. It is manual-only: it has no push, pull-request, or
tag trigger. Dispatch it from current `main`, enter the existing version tag in `release_tag`, and
type `publish salidium@<version>` exactly. The job repeats audit, lint, build, test, tarball smoke
checks, and tag/version checks before publishing with npm provenance. Build and smoke testing run
without an npm credential or OIDC permission. A separate protected job receives only the checksummed
tarball and owns the publish identity.

npm requires a package to exist before a trusted publisher can be configured. For the first release
only, first make the final source repository public, then create a granular token with the shortest
available expiry, **All Packages** read/write access, and bypass-2FA permission. A nonexistent
package cannot yet be selected as a package-specific scope. Store the token as `NPM_BOOTSTRAP_TOKEN`
in the reviewer-protected `npm-release` GitHub environment, select `bootstrap-token`, and type
`bootstrap salidium@<version>`. Once that version is verified, configure the package's trusted
publisher for `twinkling-reality/salidium`, workflow `release.yml`, environment `npm-release`, and
publish permission. Delete the bootstrap secret and revoke the token immediately. All later releases
use `trusted-publisher`; do not keep a standing publish token. In npm package publishing access,
enable **Require two-factor authentication and disallow tokens** so the trusted publisher is the
only normal release path.

Afterward, verify from an anonymous shell with `npm view salidium@<version>` and a clean temporary
home with `npx salidium@<version> --version`. Verify public documentation and repository links
separately before promoting the website; the workflow does not change repository visibility or
deploy the site.

### Sync contract

The contract has an independent `0.x` version and tag `sync-contract-v<version>`. Before tagging,
review schema compatibility, retain old fixtures, and run the full suite. Dispatch **Release sync
contract** from current `main` with `next` while the API is experimental and type
`publish @salidium/sync-contract@<version>` exactly. Its verification job packs the library, installs
it into a directory outside the monorepo, rejects workspace dependencies, checks that every
`exports` condition resolves to a file the tarball actually contains, imports the public runtime
surface under both the default and `development` resolution paths, and validates every retained
fixture and every sync operation type before a protected publisher receives the checksummed tarball.

Both resolution paths matter because the failure they catch is invisible to a single import: a
condition whose target is missing from `files` installs cleanly and breaks only for the consumer
that requests that condition.

Fixtures under `packages/sync-contract/fixtures/<wire version>/` are write-once. They record what a
released wire version accepted, so they are added while that version is being prepared and are never
edited or regenerated afterwards. A fixture produced by the code under test proves only that the
code agrees with itself, and a fixture written after publication cannot testify about what shipped.

For the first scoped package version, use the same short-lived bootstrap process and exact
confirmation `bootstrap @salidium/sync-contract@<version>`, then configure npm trusted publishing
for workflow `release-sync-contract.yml` and remove the token. Publishing, tagging, pushing, or
promoting a distribution tag always requires explicit maintainer approval. Private consumers must
pin a released version and digest and must never depend on a sibling path, tarball from an
unreleased checkout, branch, or copied source.

### Consumer contract

The consumer contract's package version tracks its wire version: `1.x` is wire version 1, and the
package minor version is the contract minor version that discovery reports. Wire 1.0 was frozen as
`1.0.0`, identical to the `1.0.0-rc.0` a real consumer exercised. Its tag is
`consumer-contract-v<version>` and its workflow is **Release consumer contract**, dispatched from
current `main` with the exact confirmation `publish @salidium/consumer-contract@<version>`. The
verification job packs the library, installs it outside the monorepo, checks that every `exports`
target is shipped, that each shipped JSON Schema file equals what the shipped runtime generates, and
that every retained fixture validates both under the runtime schemas and under the JSON Schema files
alone, under both resolution conditions. CI runs the same check on every push.

The package's npm trusted publisher is staged-only ("Allow npm publish" is off), so the workflow
runs `npm stage publish`, which first shipped in npm 12.0.0. The unprivileged verification job
fetches that npm at a pinned version, before any dependency code runs, and checks it against the
registry's published integrity; the publish job, which holds the OIDC identity, receives it beside
the package, checks it again against the same pin read from the workflow file rather than against
anything the verification job reported, and runs it from the tarball without installing or fetching
anything. To move to a newer npm, change `NPM_CLI_VERSION` and `NPM_CLI_INTEGRITY` (the pinned
`npm view npm@<version> dist.integrity`) together. A staged version is not installable. Every release therefore needs a second,
human step: a maintainer signs in to npmjs.com, opens **Staged Packages**, checks the staged version
and its provenance against the workflow run, and approves it with 2FA (or runs
`npm stage approve <stage-id>`, which also prompts for 2FA). Reject a staged version that does not
match. The package's first version was bootstrapped with a short-lived token that has been revoked;
the workflow no longer has a token path.

Before tagging:

1. Run `node scripts/write-consumer-contract.mjs --schema` after `pnpm build` and confirm the diff to
   `schema/v1/` is empty or only adds. Within a major version a release may add properties and feed
   message types, and nothing else.
2. For the first release of a minor version, its fixtures must describe that version: 1.0's are in
   `fixtures/v1/`, and each later minor's in `fixtures/v1/<major.minor>/`, which `--fixtures`
   writes for the contract's current minor. It boots a real daemon on a temporary home with inert
   stand-ins for the built-in providers and records what it serves from synthetic sessions.
   Fixtures are write-once from publication. Before the first publication only, a minor's set may
   be removed and regenerated, for example after the Salidium version it records changes. Older
   sets stay, and the tests hold each to its own released schemas.
3. When a minor version is frozen for publication, copy its `schema/v1/*.schema.json` unchanged
   into `schema/v1/released/<major.minor>/` in the same change that sets the package version. The
   contract tests then require every retained fixture and every document the daemon serves in its
   tests to validate against every released copy, which is how "an older consumer keeps working"
   is enforced rather than promised. The same change records the SHA-256 of that version's
   fixtures in the contract tests, which fail if a released fixture's bytes ever change.

A breaking change is a new major version at a new path, served alongside the old one under the
deprecation policy in ADR 0005.

## Roll back

npm versions are immutable, so correct a bad release with a new patch version. Immediately deprecate
the affected version with an actionable message, prepare and test the patch through the same tag and
workflow, then move the `latest` distribution tag only after the clean-home smoke test passes. Use
`npm unpublish` only for an urgent security or legal incident and only when npm policy permits it.

If website copy promoted a broken version, restore the last known-good site deployment or remove the
promotion until the patch is available. Record the affected version, impact, deprecation, replacement
version, and verification in the release notes.
