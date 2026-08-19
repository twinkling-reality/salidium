# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability, suspected credential, or accidentally
committed user data. Use GitHub's private vulnerability reporting for this repository:

https://github.com/twinkling-reality/salidium/security/advisories/new

Include the affected version or commit, operating system, reproduction steps, impact, and any safe
supporting material. Do not attach real transcripts, databases, tokens, provider settings, or other
people's data. Use a minimal synthetic reproduction whenever possible.

If a live credential is exposed, revoke or rotate it before attempting repository-history cleanup.
History removal is not a substitute for credential rotation.

## Supported versions

Before the first stable release, security fixes target the latest release and the current `main`
branch. After stable releases begin, this section will list the supported release lines explicitly.

## Security boundary

Salidium is a local application. Its daemon listens only on loopback, authenticates requests, and
stores state under the current operating-system account. It is not a sandbox against another
process already running as that same account. The optional explanation feature may invoke the
user's installed provider CLI and therefore may contact that provider; it can be disabled.

See [docs/architecture.md](docs/architecture.md) for the complete local trust and evidence model.
