# Changelog

## 0.8.3 - 2026-10-08

- Find `git` and the other programs Salidium runs when the daemon runs as the macOS service. The
  service's working directory is `/`, and the check that keeps a project's own binaries away from
  the daemon read that directory as containing every path, so `/usr/bin/git` and every other
  executable were refused. Under the service, sessions recorded no git snapshots, so reports and
  the "Where it sits" panel had no commit to anchor work to, the project map could not read a
  repository, and the explainer could not find `claude` or `codex`. A Windows drive root such as
  `C:\` no longer matches every path on that drive either.
- Show an OpenCode tool call as soon as it is running or finished, rather than once the whole step
  finishes. A read, edit or command now appears while the model is still working through the step.
  Its text, reasoning and usage still wait for the step to finish, so a partial message is never
  stored, and reading the finished step again does not duplicate what was already shown.
- An OpenCode session with a hosted explainer (Claude or Codex) now says its explanation is
  unavailable instead of that none has been attempted, since a hosted explainer never explains an
  OpenCode session. The local Ollama explainer still can. This is reported on every read,
  including for sessions stored earlier, and a changed explainer choice applies without a restart.
  An explanation that failed or was unavailable is now saved even when the session has no new
  event to store.

## 0.8.2 - 2026-10-02

- Read a session's activities, files and subagents by own entry only, so a call id or path named
  `constructor`, `toString` or `__proto__` is recorded like any other instead of crashing the
  reducer or reaching `Object.prototype`, including in a state scrubbed back on the timeline.
- The consumer boundary no longer gives a secret it finds the number of a placeholder stored in a
  later field. It numbers what it finds past every placeholder stored anywhere in the report or
  list entry it is building, so a placeholder never names two secrets there. It uses one redactor
  per report or entry rather than one for the daemon's life, so numbers no longer depend on which
  session or request came first. A secret found only at the boundary gets a new number even when a
  stored placeholder in the same report stands for it, and placeholders in two list entries are
  numbered by their own sessions. A placeholder number above 1,000,000,000 is not one of
  Salidium's and is not reserved.

## 0.8.1 - 2026-10-02

- Redact credentials written as JSON, YAML, HTTP headers, and environment variables. The key
  rules needed the separator right after the key, so the closing quote of a JSON key hid
  `{"password":"..."}`, `"api_key": "..."` and `{"Authorization":"Bearer ..."}` from them. Now
  covered: quoted keys, including JSON escaped inside a JSON string as a raw provider record holds
  it; quoted values with escaped quotes, replaced whole so a redacted JSON document still parses;
  `Authorization` with a Bearer, Basic or Token scheme, `Proxy-Authorization`, `X-Api-Key`,
  `X-Auth-Token`, `X-Access-Token`, `Private-Token` and `X-Goog-Api-Key` headers, also after a
  prefix such as `HTTP_AUTHORIZATION=`, `requestAuthorization:` or `http.extraheader=`, in curl commands and logs; and
  `NAME=value`, `export NAME="value"` and compose `NAME: value` forms, read to the end of the
  value. A key that names a credential with a quoted value, or an environment variable's name, is
  enough evidence for a value of six characters, so `{"password":"hunter2"}` and
  `DB_PASSWORD=hunter2` are redacted. Other values keep the earlier bar. A repeated secret keeps
  one placeholder whether it is bare, quoted, or escaped, though a header and a key-value pair
  still get separate placeholders. A placeholder already in a text keeps its number when that text
  is redacted again. The consumer boundary redacts a document's fields one at a time, though, so a
  secret it finds first can still share a number with a placeholder stored in a later field.
  Not covered: an unquoted lowercase key with a short value (`password: hunter2` in YAML,
  `password=hunter2` in an ini file); a quoted value containing whitespace beyond the leading run
  the earlier rules read; the part of an unquoted environment value after a `,` or an unclosed
  `[`, which reads as the end of the pair; values made only of letters, `.`, `_` and `-` other
  than a Basic credential; keys after a colon, as in an `.npmrc` `//host/:_authToken=`; YAML
  block scalars; URL query parameters; command-line flags such as `--password value`; and
  cookies.
- Events stored before this release are not redacted again. Stored events are immutable, and
  `salidium reingest --all` re-reads provider files but never rewrites an event it already holds,
  so older rows keep their earlier redaction in the session view, search, the owner API, and what
  the explainer is sent. Text that crosses the consumer contract and raw records opened as
  evidence are redacted with the current rules when they are read, so they are covered. A
  reingested record whose redaction now differs from its stored event is not fingerprinted, and
  its raw evidence may keep asking to be re-ingested. `salidium forget <id>` removes a session
  whose stored text holds a secret.
- Reads of sensitive files stay out of stored events and the raw view however a tool spells the
  path. Salidium used to compare a path as given, so `file:///repo/%2Eenv`, `.ENV`, `.env.`,
  `/repo//./.env`, `src/../.ssh/id_rsa` or `.env::$DATA` read the file without suppression. It now
  compares every spelling a tool might open: as a `file:` URI's path, percent-decoded, with
  separators, `.` and `..` segments, trailing dots and whitespace, NTFS streams and Windows drive
  prefixes normalized, and without regard to case. The comparison is lexical and never touches the
  filesystem. A URI (a `file:` value, or a `uri`, `url` or `href` argument) that cannot be decoded
  counts as sensitive; in an ordinary path a `%` that is not a valid escape is literal, so
  `docs/100%.md` stays visible. This applies to Claude Code, Codex and OpenCode alike.
- More reads count as reads of a sensitive file: a search inside one (Grep over `.env`), a command
  that fails after printing one (`cat .env; exit 1`), a file moved out of a sensitive path, a Codex
  `view_image`, the MCP filesystem tool `read_media_file`, and an MCP path argument too long to keep
  whole.
- More shell commands count as printing a sensitive file: through `sudo`, `env`, `command`, `nice`,
  `time`, `timeout`, `nohup` or `xargs` (option clusters such as `sudo -Eu root` included); with
  readers such as `tac`, `nl`, `base64`, `xxd`, `od`, `hexdump` and `strings`; by input
  redirection (`< .env cat`); across a line continuation; by a glob that carries enough of a
  sensitive name (`.env*`, `.e*`, `*.pem`, `cred*`, `id_*`, `~/.kube/*`, but not `*.json` or
  `package*.json`); as `git show <rev>:.env` or `git cat-file -p <rev>:.env`; and inside `$(...)`,
  `bash -c` or `find -exec`. A grep, sed or awk pattern, `git log -S` or `--grep`, and filters such
  as `--exclude=.env` are not read as paths, and `set -e` or `export FOO=1` no longer hide a
  command's output; only a bare `set` or `export` counts as a dump.
- Known limits: a recursive search of a directory that merely contains a sensitive file
  (`grep -r KEY .`), output lines whose `path:` prefix names a sensitive file, names reached by
  indirection (`f=.env; cat "$f"`), PowerShell, `cmd` and interpreter readers, `yq` given only a
  file (`yq secrets.yaml`, `yq .env`), Claude Code's Grep `glob` argument, `git show :0:.env`, and Windows 8.3
  short names are not recognized.

## 0.8.0 - 2026-10-02

- Experimental: see where a session's work sits in its repository. A session's report gains
  **Where it sits**, which places each changed file in its module, shows what it imports and what
  imports it, and can widen to the modules that depend on them. Everything shown is read from
  committed Git objects at the commit the session was observed at: the latest turn end, else the
  start. Nothing is matched by name, no model is called, and a file that is not in the map at that
  commit says so in plain words. JavaScript and TypeScript are mapped file by file; C# is placed
  by assembly only.
- Salidium reads a repository only after you allow it: `salidium map allow <repository>`,
  `salidium map list`, `salidium map revoke <repository>`, and `salidium map show` to print a
  map. A linked worktree is allowed through its main repository. Allowing records the repository's
  Git directory and a later read is refused if it changed. Tools you have given a consumer
  credential can read the committed structure of a repository you allow, at `/project-map/v0`,
  listed under discovery's `experimental`. Maps are built on request only, never at startup,
  bounded in size and time, and a repository Git could be tricked into reading elsewhere for
  (alternates, a crafted `commondir`, symlinked object stores) is refused.
- The experimental documents `salidium.project-map` v0 and `salidium.execution-links` v0 carry no
  compatibility promise yet. Consumer contract 1.1 is unchanged.
- **Where it sits** stays cheap while it is open: it checks only the text it shows, serves the same
  document again while nothing in the session or the allowed repositories changed, refetches at
  most once every 15 seconds while a session is changing, and rate limits commit lookups, which it
  remembers per allowed repository.
- Two writers can no longer edit `consumer-credentials.json` at once. A lock left by a process that
  died is taken over in one exclusive step instead of being removed by path, and an owner file
  that cannot be read yet is treated as unknown rather than dead. Older releases still respect the
  lock.
- Tests that wait for a canceled Ollama request now wait on what they observe, not fixed delays.

## 0.7.0 - 2026-10-02

- Observe OpenCode 2.x sessions, read only, as the provider `salidium/opencode`. Experimental and
  off by default; turn it on with `salidium config set providers.enabled
  claude-code,codex,salidium/opencode` or the providers setting in Ingest & Storage. Salidium reads
  OpenCode's own store (`$XDG_DATA_HOME/opencode/opencode.db`, else
  `~/.local/share/opencode/opencode.db`) through a read-only connection that cannot reach its
  credential or account tables, and never connects to an OpenCode server, installs a plugin, or
  changes OpenCode's configuration. Reports cover turns, messages, file changes with line counts,
  commands with their exit codes, reads and searches, subagents, and token usage. A consumer looks
  a session up by provider `salidium/opencode` and OpenCode's own `ses_` id. Verified against
  OpenCode 2.0.18. When OpenCode replaces a whole file it does not record what the file held, so
  the removed line count is only a lower bound and consumer contract 1.1 says so
  (`linesRemovedExact: false`).
- Each command in a Codex code-mode session shows once. With hooks on, a command used to appear
  twice, as the code cell and as the hook's own record. From Codex 0.149, which records every
  process it starts, each process is its own command with its own exit code and output, and the
  cell that ran it is a step. So `npm test` and `npm run lint` in one cell pass or fail separately,
  where together they read unknown. Rollouts from Codex builds before 0.149, or that name no
  version, read as before.
- Let a local Ollama model write the Why and How explanation, with nothing leaving the machine.
  Choose **Local model** under Models & Usage, or `salidium config set explainer.backend ollama`,
  then pick one of the models Ollama already has installed; there is no default model and Salidium
  never downloads one. The daemon calls Ollama directly at `127.0.0.1:11434`, accepts `OLLAMA_HOST`
  only when it names a loopback address, refuses redirects, and bounds the reply like the CLI routes.
  `auto` never chooses it, and when it cannot run nothing else is tried in its place. Builds that
  cannot hold an answer to a JSON Schema (Ollama's 501, as MLX builds give) are asked once more with
  the schema in the request. Ollama cloud models, which Ollama forwards to ollama.com, are neither
  offered nor used. Personalize uses the same route when it is selected.
- Opening an older session right after upgrading no longer holds Salidium up. A new release that
  changes how sessions are read used to replay a stored session in one piece the first time it was
  opened, and a large one could stall hooks, the CLI and `salidium stop` for seconds. Salidium now
  brings stored sessions up to date in the background after it starts, newest first, in small
  slices that let everything else run between them, pausing while collection is paused or
  maintenance runs. `salidium status` shows it as "Updating session history: n of m". A session
  you open before it is reached is updated on opening, as before. Checkpoints left by the older
  release are removed as each session is updated. SQLite reuses that space inside the file; run
  `salidium retention compact` if you want the file itself to shrink. On a large store the
  background pass takes minutes, and Salidium answers throughout, more slowly than usual while it
  runs. Once a session has been updated it opens as quickly as before the upgrade.
- Salidium no longer runs `git status` in the repositories agents work in. A repository's own
  configuration can make `git status` run commands, so a repository an agent was working in could
  have run code as Salidium. Repository snapshots now read only the top-level directory, HEAD and
  branch, with an environment that passes no `GIT_` variable, and no longer list uncommitted files.
- A turn end that came right after a commit could go without a repository snapshot. Every turn end
  now gets one, and each snapshot records which boundary it was taken at.
- Stop a full process table from writing hook envelopes that name no provider. The relay built the
  provider part of a queued file's name in a subprocess, and when that fork failed it wrote
  `_<time>-<pid>-<random>.json` and carried on. The drain read those as a disabled provider and
  kept them forever, which held the queue's oldest item at the day they were written. The relay now
  names the provider without a subprocess, and refuses an id with more than one slash. An envelope
  that still names no provider is quarantined unread with an `.unattributed` suffix, up to 1,000
  quarantined files, and each drain pass that quarantines any records one collection gap without a
  loss count.
- Recover the relay's quota lock after a sender dies while reclaiming it. A reaper that the shell
  abandoned mid-reclaim, for example when it could not fork under a full process table, left its
  reaping directory in the spool for good, and every later sender that met a dead owner's lock then
  waited out its whole attempt budget. The daemon now removes a reaping directory dated more than
  five minutes from now in either direction and leaves the lock itself to the relay's owner check.
  Recovery needs the daemon running; while it is down, spooling senders still spend their attempt
  budget. A reaper paused for longer than five minutes, by SIGSTOP or a sleeping laptop, could
  overlap another, which at worst puts a few files over the pending ceiling and never loses data.
- Count quarantined files apart from waiting work in `salidium maintenance queue`, and measure queue
  age, the drain result, and the storage optimization precondition from waiting work only.
- Consumer contract 1.1, for tools that read Salidium's reports (`@salidium/consumer-contract`
  1.1.0, additive to 1.0). A report says which commit a session started from and stood at after
  its latest turn, in which repository, and which Git working tree holds each changed file,
  including a linked worktree outside the directory the session started in. Salidium reads that
  from Git's own pointer files while the change happens, without running git or reading file
  contents, under the same setting as git snapshots. Line counts say when a removed count is only
  a lower bound. Discovery lists the agents the daemon watches and any experimental local
  contracts it serves.
- To bring sessions recorded before this release in line, run `salidium reingest --all`. For Codex
  code-mode sessions it adds each process's exit code without adding a second row. Sessions
  stored before this release keep their cells as commands, and where a hook had already recorded a
  process, those older sessions keep the duplicate they had: removing it would mean retracting
  checks and history already derived from it. If you use the macOS always-on service, run
  `salidium service install` first so the service runs the new copy.
- Downgrade note: once the explainer backend is set to `ollama`, Salidium 0.6.x cannot read
  `operations-config.json`. It uses the previous saved copy when that is readable and otherwise
  falls back to safe defaults for every setting, with explanations off. Set the backend back to
  `auto`, `claude` or `codex` before downgrading to keep your choices.

## 0.6.1 - 2026-10-02

- Record file changes from current Codex builds. Since Codex 0.144, applied patches are written as
  `FileChange` items instead of patch events, so sessions from those builds reported "No files
  changed" even when they made commits. Salidium now reads those items, including patches applied
  inside code-mode cells and file moves.
- Read each Codex command's exit code from its `CommandExecution` item, so a test, build, or lint
  run in a recent Codex session shows whether it passed instead of unknown. Commands in code-mode
  cells written with a quoted `"cmd"` key are recognized too.
- After upgrading, run `salidium reingest --all` so sessions recorded before this release are read
  again with these rules. If you use the macOS always-on service, run `salidium service install`
  first so the service runs the new copy.
- Add a validation record for an evidence-linked project map, `docs/project-map-validation.md`,
  with its prototype scripts. It is an experiment: nothing in the CLI or daemon serves it.

## 0.6.0 - 2026-09-26

- Add a read-only consumer contract, so a tool on the same machine can read Salidium's session
  reports without the owner token. It lives under `/consumer/v1` with its own credential, created
  with `salidium consumer create <label>`, listed with `salidium consumer list`, and revoked with
  `salidium consumer revoke <id>`. The credential survives restarts and cannot write, delete,
  configure, ingest hook events, or cause a model call. A report carries findings with their
  provenance and no prompts, full messages, command lines, or output. Discovery is
  `~/.salidium/consumer.json`, which holds no secret. See ADR 0005.
- Add `@salidium/consumer-contract` with the contract's types, runtime schemas, generated JSON
  Schema, and retained fixtures, published separately from the CLI as a `1.0.0` release candidate.
- Say how Salidium knows a session is waiting. A permission request, a notification, or a question
  tool call is observed; a question Salidium only read in the agent's final message is the agent's
  word, and the verdict now labels it reported instead of observed.

## 0.5.0 - 2026-09-09

- Add `--no-resume`, so a caller can run a command without clearing a pause the reader asked for.
  Implicit resume exists to clear a marker whose owner has died: a pause is a lease that the running
  daemon expires, so a daemon that crashed while paused leaves collection stopped with nothing able
  to restart it, and ADR 0003 makes the next ordinary command that recovery step. The flag is for a
  caller that has already seen the daemon answer, and so cannot be in that case, and whose surface
  cannot show the reader that recovery happened.
- Never resume collection from a private worker entrypoint. The daemon schedules that work itself,
  so it must not be a way to begin recording again on a Salidium that was deliberately paused.
- Stop the menu bar from resuming a pause you asked for. It only offers actions after a live health
  response, so it can never be in the crashed-daemon case implicit resume recovers from, and it
  sends command output to the null device, so choosing **Open Salidium** on a paused Salidium
  started recording again with nothing anywhere saying so. It now passes `--no-resume`. **Store One
  Batch Now** no longer appears while paused either, where draining is a no-op and only appeared to
  work because running the command resumed collection first.
- Say what is happening in the menu bar instead of reporting readings. It led with a row naming the
  application, which the icon it was opened from had already established, and then six equal rows of
  internal state, one of which was the daemon's own process id and another of which was a queue
  depth whose normal value is zero. It now leads with one sentence in the words the alert already
  uses, followed by the action that answers it. A finished maintenance operation is no longer shown
  as though it were still running, the queue row appears only when work is actually waiting, and the
  alert count is replaced by what the alert says.
- Tell the truth about whether work is being recorded. `Recording · On` meant only that the pause
  marker was absent, so it stayed on while a provider's hooks were invalid or no longer trusted. The
  menu now reads per-provider hook state and names what is wrong in the words the interface already
  uses, so hooks that need repair are not reported as a provider that is not connected. A provider
  that is not installed, or that you disconnected on purpose, is not a fault and is not mentioned.
- Draw the menu-bar icon as the Salidium mark, as a template image, so macOS renders it on light and
  dark menu bars and while the menu is open. It was a generic filled checkmark with template mode
  turned off and a colour applied by hand, which identified no application and opted out of that
  rendering. State is now a change of shape, not of colour alone, which is also the only option a
  template image leaves: the system paints it one colour, so an amber badge and a red one would
  arrive identical.
- Show what local storage is doing in the menu rather than only how large it is, with a bar against
  the configured warning size and the growth per day at the current rate, which the interface
  already computed and the menu did not.
- Show that a menu action is running. Choosing an item closes the menu, so **Store Waiting Files
  Now** ran the CLI for up to thirty seconds with nothing on screen to say so. The mark now fades
  slowly while a command runs, and reopening the menu leads with what is happening. Reduce Motion
  turns off the fade and keeps the line.
- Answer what is actually using the space. Salidium could say the store was three gigabytes and how
  fast that was growing, but nothing anywhere could say what was in it, so the only available
  response to a large store was to delete history and hope. `salidium storage composition` and the
  **Local operations** panel now measure it: recorded sessions, replay checkpoints, provenance
  records, reusable space, and the remainder of indexes and page overhead, with the projects that
  account for it ranked beneath. The remainder is a subtraction and says so. On the store this was
  built against, replay checkpoints were half a gigabyte of a three gigabyte file, which storage
  optimization rebuilds and nothing had ever reported.
- Measure that composition on a worker. It reads the header of every stored event, which is ten
  seconds on a large store, and `node:sqlite` is synchronous: on the daemon's own loop that would be
  ten seconds of hooks going unanswered and spooling to disk. The daemon spawns that worker through
  the same command surface everything else uses, which is why no private worker entrypoint clears a
  pause: without that, asking what was using the disk would have quietly restarted a deliberate one.
- Measure the store from a worker this package owns when the daemon is embedded. Reaching the
  measurement through the CLI works for the published single file, where the CLI is the only entry
  point that exists, and fails for anything that calls `startDaemon` directly: there
  `process.argv[1]` is the host's own entry point, so the daemon spawned that instead and reported
  that the measurement produced no result. It now prefers a worker beside the compiled daemon and
  falls back to the CLI when that file is absent, which is exactly the packaged case.
- Say why the daemon would not start. A refused start reported only the name of the log file that
  held the reason, so the whole message was an instruction to go and read something; it now carries
  the reason itself, such as `listen EADDRINUSE: address already in use`, and keeps the path.
- Handle a failed menu action as a state rather than a moment. The alert said "Salidium could not
  complete that command" over a sentence ending in an absolute path, named neither what you had
  asked for nor what to do next, and left nothing behind once dismissed: the menu went back to
  "Not running" with no sign that a start had just been refused. It now names the action, offers
  **Show Log**, and keeps the reason in the menu until the next attempt or until the daemon starts.

## 0.4.1 - 2026-09-07

- State a recovered alert in its own words. Every alert now carries wording for both of its edges,
  so the desktop notification and the **Local alerts** list say the condition is over instead of
  repeating the sentence that raised it; the macOS all-clear for a queue backlog read "Recovered:
  The durable queue is growing" and asked the reader to go investigate it. Alert wording is plainer
  throughout, and a notification about a cleared condition no longer asks for anything.
- Report sizes in the decimal units the operating system uses, on every surface. The menu bar and
  the local interface disagreed about one number because one was decimal and the other binary; both
  now agree with each other and with Get Info.
- Show how fast local storage is growing and how much room is left before the warning, in
  `salidium status` and the **Ingest & Storage** rail, rather than only raising an alert on arrival
  at the limit.
- Change the default storage warning from 5 GiB to 5 GB, so the threshold is a round number in the
  units it is now shown in. This warns about seven percent earlier; `alerts.databaseSizeBytes`
  overrides it and a stored choice is unaffected.
- Say why a derived measurement is unavailable. Drain rate and time to empty reported that they
  needed two samples while the line above them reported eighty-four; they are absent because the
  queue is not shrinking or is already empty, which is what they now say.
- Rename the menu-bar drain action to **Store One Batch Now**, which is what one press does, and
  show collection, queue, storage, and alert state in the same words the interface uses. Internal
  state values no longer reach either surface unlabelled.

## 0.4.0 - 2026-09-05

- Add a versioned local-operations contract across the interface and CLI: effective policy with
  source precedence, exact-or-unavailable health measurements, durable maintenance state, alert
  acknowledgement and recovery, opt-in native notifications, and bounded redacted diagnostics.
- Add an optional macOS always-on LaunchAgent and native menu-bar control. The installed runtime is
  copied and versioned, updates roll back safely, launcher logs rotate, and disabling or removing
  the service preserves local reports and settings.
- Bound live collection under backlog pressure with fixed per-payload limits, serialized queue
  ceilings, tiered event shedding, a lifecycle reserve, resumable batched drain, and a durable gap
  ledger whenever loss is observed but cannot be counted exactly.
- Add lossless offline storage optimization, compressed event/checkpoint storage, materialized token
  accounting, and schema 8. An upgrade from 0.3.0 migrates transactionally, then prepares historical
  usage in bounded resumable background batches while the daemon remains responsive; retention and
  optimization wait until the preparation is complete.
- Harden automatic process execution against project-controlled and shared-writable PATH entries,
  pin native OS helpers, bound Codex trust probing, redact identifying diagnostic fields, and retain
  envelopes for temporarily disabled providers.
- Verify the self-contained npm artifact as installed, ship third-party notices and native sources,
  require full-engine CI evidence for protected publication, and expand release checks for upgrades,
  platform lifecycle, the site, secrets, and private-data claims.

## 0.3.0 - 2026-08-24

- Add optional personalization for generated Why and How explanations. Terms stay in an owner-only
  local profile, every model call is explicit, and the original evidence-backed explanation remains
  available.
- Add versioned JSON report export with the projected report and its evidence references, without
  provider transcript records or personalized presentation text.
