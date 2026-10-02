# `@salidium/consumer-contract`

The versioned, read-only contract a tool on the same machine uses to read what Salidium understood
about a coding-agent session: its verdict, changed files, verification state, review items, what
remains, and the optional generated explanation of why and how.

This package holds the contract, not a client: TypeScript types, zod runtime schemas (the source of
truth), JSON Schema files generated from them, and retained example documents. It has no I/O and no
network code, and it does not expose Salidium's internal events or state.

Status: `1.1.0`, wire version 1.1, which only adds to wire 1.0 (published as `1.0.0`).

## Consent first

A tool needs a credential the person creates for it:

```bash
salidium consumer create "my launcher"   # prints the token once
salidium consumer list
salidium consumer revoke <id>            # effective on the next request
```

The credential reads the contract below and nothing else. It cannot change settings, delete
sessions, send hook events, or cause a model call. It survives Salidium restarts until revoked.

## Finding the daemon

While Salidium runs, `$SALIDIUM_HOME/consumer.json` (default `~/.salidium/consumer.json`) holds a
`salidium.consumer-discovery` document. Its `contracts` array lists every major version served, each
with its minor version and base URL; use the entry whose `major` you implement and ignore the rest.
It also carries an `instanceId` that changes on every start. It contains no secret. The same document is served without a credential at
`GET /consumer/v1/discovery`. Before sending a token, read the file, fetch the endpoint, and check
that the two `instanceId` values match; otherwise the port may belong to something else. If the file
is absent, Salidium is not running.

## Endpoints

All requests are `GET` with `Authorization: Bearer <token>`, on `127.0.0.1` only.

| Path | Returns |
| --- | --- |
| `/consumer/v1/sessions?limit=N` | `salidium.session-list`: newest first, `limit` 1 to 2000 (default 200) |
| `/consumer/v1/sessions/lookup?provider=P&sessionId=S` | `salidium.session-lookup`, or 404 `session-not-observed` |
| `/consumer/v1/sessions/{id}/report` | `salidium.session-report` version 2; `{id}` percent-encoded |
| `/consumer/v1/feed` | server-sent events, one `salidium.session-feed` message per `data:` line |

`provider` is `claude-code`, `codex`, or a namespaced `owner/name`. `sessionId` is the provider's own
session id: Claude Code's `session_id`, or the Codex session id in its rollout file name. A lookup
404 right after launch usually means the session has not reported yet. A tool that learns a session
id only after launch, as with Codex, can also match the `native` identity on `session.changed`
instead of polling lookup.

Errors are `salidium.consumer-error` documents with a stable `error` code, including a 500
(`internal`) and the loopback guard's refusals (421 `host-not-allowed`, 403 `origin-not-allowed`).

## The feed

Every connection starts with `resync`: discard cached state and re-read the list. Then:

- `session.changed`: a report changed. Fetch it if `evidenceSeq` is greater than the one you hold.
- `session.removed`: the session was deleted or expired.
- `heartbeat`: every fifteen seconds.
- `closing`: the credential was revoked or Salidium is stopping.

There is no replay. After any disconnect, reconnect and handle `resync` again. Use `readFeedMessage`,
which returns `null` for a message type this version does not know.

Status can change through time alone: a session that goes silent mid-turn reads `working` for
fifteen minutes and then `idle`, without new evidence and so without a notification.

## Reading a report honestly

Every derived value carries a provenance class, and they are different facts:

- `observed`: recorded by a runtime or by Salidium, such as an exit code or a diff.
- `reported`: said by the agent or the user. An agent writing "tests pass" is `reported`.
- `inferred`: Salidium's deterministic heuristic, such as "a passing check ran after this change".
- `planned`: a plan step.
- `explained`: model-generated narrative. Never evidence.

Every property is always present. `null` means Salidium does not have the value; it is never an
omitted key. Verification outcomes include `unknown`, and exit codes may be `null` with an
observation of `unknown`; do not render either as success.

`waiting.provenance` says how Salidium knows the session is waiting: `observed` for a permission
request, notification, or question tool call, `reported` when it read the question in the agent's
message. The verdict's provenance follows it.

The report carries findings, not the session's content. There are no prompts, full agent messages,
command lines, command output, or raw records, and the session title is present only when the
provider supplied one. Text fields are short, redacted, and still untrusted input: escape them when
rendering.

## What 1.1 adds

Check that your discovery entry's `minor` is at least 1 before relying on any of these.

- `report.revision`: the repository read (`root`), the commit `HEAD` named and the branch when the
  session started (`atStart`, kept from the first start; a resume is not a start) and when its
  latest turn ended (`atLatestTurnEnd`). A session can move between repositories, so compare
  `root`, not only `session.repositoryRoot`. Each anchor is `null` when Salidium did not watch that
  boundary live.
- Paths, roots and branches in these fields cross whole or not at all: one that redaction would
  change, or that is too long, is `null` rather than altered.
- `changes.files[].repository`: the Git working tree that holds the file (`root`), the file's
  path inside it (`path`), and for a linked worktree the repository it belongs to (`mainRoot`).
  Agents often write outside the directory the session started in, so this can differ from
  `session.repositoryRoot`. Salidium reads it from Git's pointer files when the change happens,
  without running git; it is `null` for history imports and wherever no repository holds the file.
- `linesRemovedExact` on each changed file and on a session's `counts`: `false` when a provider
  replaced a file without recording what it held, so `linesRemoved` is a lower bound rather than
  a count. Claude Code and Codex always record it today.
- Discovery's top-level `providers`: the providers this daemon instance observes, as `{ id }`
  objects with the ids `lookup` takes. An id that is not listed is not observed until Salidium
  restarts with a new `instanceId`, so gate lookups on it rather than on the version. A 1.0 daemon
  does not send it: treat its absence as unknown.
- Discovery's top-level `experimental`: local contracts the instance serves that are not part of
  this one and carry no compatibility promise, each with a name, version and loopback base URL.
  Do not depend on one without checking it yourself.

## Compatibility

The major version is in the path. Within major version 1:

- Later minor versions may add object properties and feed message types, and nothing else. Ignore
  what you do not know. The JSON Schema leaves objects open for this reason.
- Properties are never removed, renamed, retyped, or made nullable, enumerations never gain
  values, and bounds never loosen: a maximum length may shrink but never grow.
- If you rely on a property added after 1.0, check `minor` in your discovery entry.

A breaking change is a new major version at a new path, served alongside the old one for at least
six months and two Salidium minor releases, announced with `Deprecation` and `Sunset` headers.

## Testing a consumer

Two ways, neither of which touches anyone's real data.

**Recorded fixtures.** Each minor version has one real document of every kind and every feed
message type, captured from a daemon serving synthetic sessions: 1.0's in `fixtures/v1/`, and each
later minor's in `fixtures/v1/<major.minor>/`. They are MIT-licensed like the rest of
Salidium; copy them into your own tests.

**A real, isolated daemon.** From a Salidium checkout, run:

```bash
pnpm install --frozen-lockfile && pnpm build
node scripts/consumer-test-daemon.mjs
```

It uses a temporary home and empty provider directories, installs no hooks, enables no provider
adapter (so it starts no provider process), fixes its clock at 2026-09-20T16:20:00.000Z, seeds the
same synthetic sessions (ended, waiting, and working), creates a credential, and prints one JSON line with `baseUrl`, `token`, `discovery`, and
the native identities to look up. It then accepts `message`, `forget`, `revoke`, and `stop` on stdin
to produce `session.changed`, `session.removed`, `closing`, and a clean shutdown. Each command is
acknowledged with a JSON line. Pass `--port N` for a fixed port.

To run the daemon itself isolated instead, set `SALIDIUM_HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME`
to empty temporary directories and `SALIDIUM_PORT` to a free port, then run `salidium daemon`.
Provider discovery reads those variables, not `HOME`. Neither `salidium daemon` nor `salidium start`
installs hooks; only first-run `salidium` and `salidium install-hooks` do.

## Contents

- `schema/v1/*.schema.json`: JSON Schema (draft 2020-12), importable as
  `@salidium/consumer-contract/schema/v1/<name>.schema.json`.
- `schema/v1/released/<major.minor>/*.schema.json`: each published minor version's schemas, copied
  unchanged. Every later document validates against all of them.
- `fixtures/v1/*.json` (1.0) and `fixtures/v1/<major.minor>/*.json` (later minors): real
  documents captured from a daemon serving synthetic sessions, to test a consumer against.
- Runtime exports: every schema (`SessionReportSchema`, `SessionListSchema`, and so on), their
  types, `readFeedMessage`, `consumerJsonSchema`, and `CONSUMER_CONTRACT`.
