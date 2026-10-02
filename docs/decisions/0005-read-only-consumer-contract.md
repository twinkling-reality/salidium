# ADR 0005: A read-only consumer contract for local tools

- Status: accepted for implementation; publication requires explicit approval
- Date: 2026-09-26

## Context

Tools that launch coding-agent sessions on the same machine, such as a local control plane or an
editor integration, want to show Salidium's understanding of a session next to the work they
started: the verdict, the changed files, the verification state, the review items, and the
explanation of why and how. Salidium had no legitimate way to give it to them.

- The `/api` surface is the private protocol between the daemon and its own interface. ADR 0001
  rejected publishing `@salidium/protocol` because it is session-oriented and carries sensitive
  fields, and that reasoning applies to serving it to other programs.
- The only credential is the owner token in `daemon.json`. It changes on every start and it can
  delete sessions, change policy, ingest hook events, and cause model calls. Handing it to another
  tool hands over all of that.
- `SessionView`, the projection the interface renders, has no runtime schema and no version. The
  browser export (`{format: 'salidium.session-report', version: 1}`) embeds it whole, which
  includes the user's prompt, full agent messages, command lines, command output excerpts, and
  internal event ids.
- The architecture already says external consumers should read a versioned export while SQLite
  keeps local authority.

## Decision

Add a consumer contract: a versioned, read-only, local interface that any tool may use, with its
own credential, its own URL space, and a separately packaged schema.

### Surface

Everything lives under `/consumer/v1`. The major version is in the path; each document also names
its `format` and `version`.

| Method and path | Credential | Returns |
| --- | --- | --- |
| `GET /consumer/v1/discovery` | none | `salidium.consumer-discovery` v1 |
| `GET /consumer/v1/sessions?limit=N` | consumer | `salidium.session-list` v1 |
| `GET /consumer/v1/sessions/lookup?provider=P&sessionId=S` | consumer | `salidium.session-lookup` v1, or 404 `session-not-observed` |
| `GET /consumer/v1/sessions/{id}/report` | consumer | `salidium.session-report` v2 |
| `GET /consumer/v1/feed` | consumer | server-sent `salidium.session-feed` v1 messages |

Errors are `salidium.consumer-error` v1 documents, including a handler failure (500 `internal`) and
the loopback guard's refusals (421 `host-not-allowed`, 403 `origin-not-allowed`), so everything
under `/consumer` answers in the contract's shape. Every other method is refused with 405 before
authentication is considered. The loopback bind, Host check, Origin check, and cross-site refusal
run first and are unchanged in what they accept and refuse; only the body of a refusal under
`/consumer` differs. Telemetry remains absent.

Lookup takes the provider id and the provider's own session id, which is the key any tool that
launched a session already holds. A 404 there means "not observed yet": a session launched a moment
ago may not have reported. It does not distinguish a session Salidium never saw from one the person
deleted.

### Credential

A consumer credential is created on purpose, for one named tool, with
`salidium consumer create <label>`, listed with `salidium consumer list`, and revoked with
`salidium consumer revoke <id>`. The token is printed once. Only its SHA-256 is stored, in the
owner-only `consumer-credentials.json` beside `daemon.json`. It survives restarts because it is not
derived from the daemon process.

The credential opens `/consumer/v1` and nothing else, and the owner token does not open
`/consumer/v1`. The consumer routes are dispatched before the owner check and have their own
authentication, so a future owner route cannot become reachable by forgetting a scope check: the
default for a consumer credential is deny. The owner token is unchanged.

The file is the authority. The CLI edits it under a small lock whether or not the daemon runs, and
the daemon re-reads it when its metadata changes, so a revocation applies to the next request and
closes an open feed within two seconds. An unparseable file authorizes no one. There is a hard limit
of 32 credentials.

### Discovery

While it runs, the daemon writes `$SALIDIUM_HOME/consumer.json` (default `~/.salidium`) and serves
the same document without a credential at `/consumer/v1/discovery`. It lists every major version the
daemon serves, each with its minor version and base URL, plus the Salidium version and a per-start
`instanceId`. A client uses the entry for the major it implements and ignores the rest, so a later
major never hides an earlier one. The endpoints under a base URL are fixed by its major version and
are not repeated in the document. It holds no secret. A consumer compares the file's `instanceId` with the endpoint's before sending a token, so a
port reused by another process after Salidium stopped does not receive it. The file is removed on a
clean stop. The default port remains 47822.

### What the report carries

The session report is the formalized successor of the browser export. It keeps that export's
envelope and section vocabulary, and version 2 is its first schema-backed version. It carries
Salidium's findings, not the session's content:

| Crosses | Does not cross |
| --- | --- |
| Salidium's own wording: verdict, labels, glances, check descriptions, the kind of work in progress | the user's prompts, including the prompt-derived title and "Working on: ..." |
| observed identifiers and counts: paths, SHAs, line counts, exit codes, token counts | full agent messages, subagent briefs (even as a file's reason) and replies, thinking |
| short attributed statements the agent made: classified sentences and the opening line of its final report | command lines and command output excerpts, including a running command's title |
| the fragment that is a review finding, such as a destructive command segment, clipped | tool inputs, turn and activity lists, event ids, provider file paths and line references |
| the optional generated explanation, labelled as generated | anything a raw-record drill-through would open |

Exclusion is structural: there is no contract field for any item in the right column, and the
mapping from the private projection is written field by field. Text that crosses passes the
redactor again at the boundary, as defense in depth for records ingested before a rule existed.
Tests plant canaries in every excluded place and a secret in a sentence that does cross, and fail if
a canary appears or the secret is not redacted.

The session title is carried only when the provider supplied one. Salidium's interface falls back to
the first line of the first prompt, and that fallback is a prompt. Summaries now record which of the
two a title is; one written before that distinction reads as a prompt and is withheld.

### Truthfulness

Every derived value keeps its provenance class: observed, reported, inferred, planned, or explained.
A waiting state is observed when it came from a permission request, a provider notification, or a
question tool call, and reported when Salidium read the question in the agent's message; the verdict
follows it. A file's reason is always reported. Checkpoints written before waiting states recorded
their provenance read a question as reported, the weaker claim.
File coverage ("a passing check ran after this change") is always `inferred`. The explanation is
always `explained`, carries the evidence position it was written from, and says whether it still
covers the newest evidence. Every property is always present; a value Salidium does not have is
`null`, and token usage that was never observed is `null` rather than zeroes.

Mappings from Salidium's internal vocabularies to the contract's enumerations are exhaustive records,
so a new internal value fails the type check instead of leaking into a closed enumeration.

### Reads change nothing

Loading a session coordinator writes a checkpoint on a cold load, keeps the session in memory, and
makes it "loaded", and loaded sessions are exempt from retention. A tool polling reports would
therefore decide what retention may delete. Consumer reads use a separate registry path that serves
a live coordinator when one exists and otherwise replays from the newest checkpoint into a small
private cache, without loading, persisting, or registering anything. No consumer path can schedule
an explanation.

### Change feed

The feed carries notifications, not state. Each connection starts with `resync`, meaning "discard
what you think you know and re-read the list". `session.changed` names the session, its native
identity, its new `evidenceSeq`, status, and explanation status; the consumer fetches the report if
the sequence is newer than what it holds. `session.removed` follows deletion and retention.
`heartbeat` arrives every fifteen seconds. `closing` precedes a revocation or shutdown. There is no
replay: after any disconnect the consumer reconnects and receives `resync`. A reader that falls more
than 1 MiB behind is disconnected rather than buffered without bound.

### Versioning, compatibility, and deprecation

The zod schemas in `@salidium/consumer-contract` are the source of truth. The JSON Schema files in
`schema/v1/` are generated from them; a test fails when the committed files differ, and another
validates every retained fixture against the committed files alone, which is what a consumer in
another language has.

Within major version 1:

- A minor version may add object properties and feed message types. It never removes, renames, or
  retypes a property, never changes nullability, never adds a value to an enumeration, and never
  loosens a bound. A maximum length or count may shrink but never grow, because an older consumer's
  validator would reject the longer value.
- Consumers must ignore properties and feed message types they do not know. The published JSON
  Schema leaves objects open so an older consumer's validator accepts a newer document.
- A consumer that relies on a property added in a later minor checks the `minor` of its entry in discovery.
- Salidium's own tests hold the producer to the closed form: each served document must equal its
  own parse, so nothing undeclared is emitted.
- Once a minor version is published, its schemas are copied unchanged into
  `schema/v1/released/<major.minor>/`, and current documents must validate against every released
  copy. Retained fixtures are write-once from publication.

Deprecation: a breaking change is a new major version served at a new path, alongside the old one.
When `/consumer/v2` ships, every `/consumer/v1` response carries `Deprecation` and `Sunset` headers,
the release notes and documentation announce the date, and v1 remains served for at least six
months and at least two Salidium minor releases. It is removed only in a release whose notes say so.
The published package's affected major is deprecated on npm with a pointer to its successor.

### Packaging

`@salidium/consumer-contract` holds the types, runtime schemas, JSON Schema, and retained fixtures.
It depends on zod only; it does not depend on or re-export `@salidium/protocol`, canonical events,
reducer state, or any daemon code. Its version was `1.0.0-rc.0`, a candidate for wire version 1,
until a real consumer had exercised the wire; wire 1.0 was then frozen unchanged as `1.0.0`. CI
packs it and consumes it outside the workspace. A manual-only release workflow mirrors the sync
contract's, except that it stages the version for a maintainer's 2FA approval rather than
publishing it. Nothing is published without the owner's explicit approval.

### Minor version 1.1

The first additive minor answers two questions a consumer could not: which revision the work
belongs to, and which repository holds each changed file. A session's root is where it started,
not where it wrote; agents edit linked worktrees and other checkouts.

- `report.revision` carries `HEAD` and the branch at the first session start and at the latest turn
  end, from Salidium's own git snapshots, which now name the boundary that triggered them. A
  snapshot recorded before that, or a session not watched live, anchors nothing: `null`.
- `changes.files[].repository` carries the working tree that holds the file, the path inside it,
  and for a linked worktree the repository it belongs to. Salidium resolves it when the change is
  live from Git's pointer files alone (a `.git` directory with `HEAD`, or a `.git` file's
  `gitdir:` and that directory's `commondir`), bounded in depth and bytes read, never running git,
  never reading file contents, and never reporting anything under another user's home. Anything
  it cannot establish is `null`. Paths and branches cross whole and redacted, never clipped.
- Discovery lists the providers the daemon instance observes, so a consumer can tell "not
  observed by this instance" from "not reported yet". The list is fixed for an instance's life,
  as the enabled providers are, and changes only with a restart and a new `instanceId`.

## Consequences

Salidium takes on a compatibility obligation for the meaning of its report, not only its shape. An
internal refactor now has a second reader to keep correct, and the exhaustive mappings and
exact-parse tests are the cost of noticing.

The credential is a bearer token. The threat model already states that loopback authentication is
not a sandbox against other processes running as the same user; a consumer credential does not
change that, and it is narrower than the owner token any such process could already read.

The feed does not announce status changes that happen through time alone. A session that stops
reporting mid-turn reads `working` until fifteen minutes pass and then `idle`, with no new evidence
and so no notification. A consumer that shows status re-reads on heartbeat or on demand.

A cold report read replays at most one checkpoint interval of events, and more after a reducer
version change until the interface loads that session and writes a new checkpoint. The private cache
holds eight replayed states.

Two formats now share the name `salidium.session-report`. Version 1 remains the interface's download
button, the person's own full-fidelity copy, unschematized and not a contract. Version 2 is the
contract. A reader distinguishes them by `version`.

## Confirmed with a first consumer

A local control plane that launches agent sessions reviewed this contract before it was frozen and
confirmed the design rather than changing it:

- It knows a Claude Code session id before launch, because it chooses one, and a Codex session id
  only after launch. It treats `session-not-observed` as "not yet" and correlates through the native
  identity that `session.changed` already carries, so the contract needs no pre-registration.
- It needs none of the excluded fields. It observes commands and output for the sessions it hosts
  directly, and wants Salidium's findings rather than a second copy of the content.
- It reads feed first: one connection per daemon instance after the `instanceId` check, lookups and
  reports on `resync`, a report fetch when `evidenceSeq` increases, and a reconnect with backoff on
  `closing` or after three missed heartbeats. It does not poll, and re-reads a report on demand to
  cover status that changes through time alone.
- It will not use every field, but nothing needs removing: the contract serves any tool, not one.
- Its end-to-end run against a real daemon found four places where the first labelling guidance and
  the source disagreed and a handful of gaps. Before the freeze they were resolved as recorded
  above: waiting provenance, reasons that are always reported, working states in Salidium's own
  words, error documents for every response, a discovery document that lists every served major,
  no provider processes in the test kit, and the rule that bounds never loosen.
- Its launch identities match Salidium's keys. The Claude Code session id it chooses reaches the CLI
  as `--session-id`. For Codex `exec`, the thread id equals the rollout file's id, which is what
  Salidium keys on; for the Codex app server the same holds indirectly, since the thread's rollout
  path is named by its id. A thread that never receives a turn writes no rollout and is never
  observed, which is correct: there is no work to report. That a Codex hook's `session_id` equals
  the thread id is an assumption of Salidium's own hook and rollout reconciliation, not something
  this contract adds, and it has not been checked against a live Codex hook here.

## Rejected alternatives

- **Serve `SessionView` or publish `@salidium/protocol`.** Rejected in ADR 0001, and the projection
  contains prompts, command lines, and output.
- **Give tools the owner token, or add a read-only flag to it.** It changes on every start, and any
  scope added later to shared routes fails open the first time a new route forgets to check it.
- **Put consumer routes under `/api` behind a scope check.** Same failure mode: one prefix, two
  credentials, and escalation by omission. A separate prefix makes deny the default.
- **Strict objects and literal minor versions, as in the sync contract.** That boundary is a hosted
  receiver that must fail closed on unknown fields to prevent over-collection. Here Salidium is the
  producer and consumers only read. Closed evolution would force every local tool to upgrade in
  lockstep for each added field, and over-exposure is controlled where it can be, in the producer's
  exact-parse and canary tests.
- **Carry the prompt-derived title, the verification command, or the failure excerpt.** Each is
  session content. A person who needs them opens Salidium's own interface.
- **Store credentials in SQLite.** A schema migration and the store's single-writer rule for a small
  set of records the CLI must edit whether or not the daemon runs.
- **Put the report in the feed, or offer replay with `Last-Event-ID`.** Notifications are idempotent
  pointers to a document the consumer can fetch; replaying them adds state and no information.
- **Webhooks.** Salidium would become an outbound caller, which the local product does not do.
- **Unauthenticated reads.** The Origin check stops browsers, not local processes. Reading a
  person's work requires their explicit, revocable consent per tool.

## Deferred

- Managing consumer credentials in the interface. The CLI covers create, list, and revoke; a panel
  needs an owner API and a way to show a token once, which is more than cheap.
- Restricting a credential to repositories or to sessions a tool launched.
- Recording when a credential was last used.
- Telling a deleted session apart from one never observed in lookup.
- Cursor paging for the session list, and a `since` filter for polling.
- A feed notification for status that changes through time alone.
- A link from a report into Salidium's own interface, which today needs the owner token. The first
  consumer does not need one: its displays are not on the machine running Salidium.
- Whether the browser download should become version 2.
- Publishing the package, which requires a real consumer to have exercised the wire first and the
  owner's explicit approval.
