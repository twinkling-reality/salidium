# Releasing and rollback

The public npm artifacts are the bundled `salidium` CLI and the narrow
`@salidium/sync-contract` interoperability package. All other workspace packages remain private.
The website is separate and neither release workflow deploys it.

## Prepare

1. Update the root and CLI versions together and summarize user-visible changes.
2. Run `pnpm install --frozen-lockfile`, `pnpm audit --audit-level high`, `pnpm lint`, `pnpm build`,
   and `pnpm test` from a clean checkout.
3. Inspect `npm pack --dry-run` from `packages/cli`, then install that tarball into a temporary home
   and exercise `salidium --version`, first run, `doctor`, and `stop`.
4. Confirm CI has succeeded on the current `main` commit, then create and review a tag named exactly
   `v<package version>` at that same commit.

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
it into a directory outside the monorepo, rejects workspace dependencies, imports the public runtime
surface, and validates the retained v1 fixture before a protected publisher receives the checksummed
tarball.

For the first scoped package version, use the same short-lived bootstrap process and exact
confirmation `bootstrap @salidium/sync-contract@<version>`, then configure npm trusted publishing
for workflow `release-sync-contract.yml` and remove the token. Publishing, tagging, pushing, or
promoting a distribution tag always requires explicit maintainer approval. Private consumers must
pin a released version and digest and must never depend on a sibling path, tarball from an
unreleased checkout, branch, or copied source.

## Roll back

npm versions are immutable, so correct a bad release with a new patch version. Immediately deprecate
the affected version with an actionable message, prepare and test the patch through the same tag and
workflow, then move the `latest` distribution tag only after the clean-home smoke test passes. Use
`npm unpublish` only for an urgent security or legal incident and only when npm policy permits it.

If website copy promoted a broken version, restore the last known-good site deployment or remove the
promotion until the patch is available. Record the affected version, impact, deprecation, replacement
version, and verification in the release notes.
