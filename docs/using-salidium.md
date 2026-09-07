# Using Salidium

## Start locally

Salidium requires Node.js 24 or newer because its daemon uses the built-in `node:sqlite` module.

```bash
npx salidium
```

On first run, Salidium detects Claude Code and Codex from their local commands or state directories.
It shows the settings files it wants to update and asks one combined permission question. Approved
connections are merged with existing settings; unrelated hooks are preserved. If Salidium changes
Codex hooks, approve them once in `/hooks` before Codex runs them.

The same setup asks about the optional written Why and How. **Local only** is selected by default
and makes no model calls. **When done** makes one call after a session ends or goes quiet. **Each
reply** refreshes the explanation after every agent reply.

Later runs start or find the daemon and reopen the interface. A non-interactive terminal never waits
for input or changes provider settings unless `--yes` is present. Use `--no-open` when a browser
should not open.

The browser tab is a control panel, not the background service. Closing it does not stop Salidium
or collection. Run `salidium open` to return to the same local service, `salidium status` to see its
process ID, loopback address, state directory, queue, store size, and alerts, or
`salidium status --watch` for a live terminal view. Pause, resume, drain, restart, and stop remain
available from the CLI without a browser window.

### Always-on mode on macOS

Closing the browser leaves an already-running daemon alone, but by itself it cannot restart a
process after a crash or the next login. Install the optional macOS supervisor and menu-bar control
to cover those cases:

```bash
salidium service install
```

The menu-bar icon shows healthy, needs-attention, critical, or stopped state. Its menu shows the
daemon PID, collection state, queue and storage readings, retention, active-alert count, and
maintenance state. Readings are exact when they can be observed within the safety ceiling and say
unavailable rather than displaying a partial count as fact. The menu can open Salidium, start or
stop it, pause or resume collection, drain the queue toward empty for a bounded interval, refresh,
and open the local data folder. Native alert notifications remain a separate opt-in setting;
always-on mode does not enable lock-screen notifications.

The service starts at login and macOS relaunches it after an unsuccessful exit. A deliberate
`salidium stop` is a successful exit and stays stopped; **Start Salidium** in the menu or
`salidium start` starts that same supervised service again. `salidium status` includes its loaded
state, and `salidium service status` reports the login service and menu bar directly.

The installer copies the current packaged CLI and UI into `~/.salidium/service/current`, then
compiles the small AppKit menu helper locally with Apple's Swift compiler. It fails before changing
the active login service if the compiler is unavailable; install Xcode Command Line Tools and retry
in that case. Re-run `salidium service install` after upgrading Salidium to replace the stable copy.
LaunchAgent files contain only executable and state-directory paths, never the daemon bearer token.
Supported `SALIDIUM_*` environment overrides that are present during installation are copied into
the private LaunchAgent so login startup has the same policy; re-run installation after changing an
environment override.

`salidium service disable` stops both login items but keeps them available for
`salidium service enable`. `salidium service uninstall` removes only the copied service runtime and
Salidium's two LaunchAgent files. Both commands leave reports, settings, queues, and the event store
in `~/.salidium`. Version 1 of this always-on layer is macOS-only; the CLI remains the fallback on
other operating systems.

### Upgrading from 0.3.0

Install 0.4.x normally and keep the same `SALIDIUM_HOME`. The first 0.4.x daemon start upgrades the
version 0.3.0 schema in one transaction before hooks or the HTTP listener start. It does not rewrite
the historical event archive as part of that transaction.

After the listener starts, a separate worker prepares the all-time token ledger from historical
events. **Models & Usage** shows **Preparing token history** while this is running; collection,
status, stop, and the local interface remain responsive. Progress is stored durably in bounded
batches, so stopping the daemon or losing the process resumes from the saved cursor on the next
start. Automatic retention is deferred, and retention application, compaction, and storage
optimization refuse to run, until preparation is complete.

An installed macOS always-on service runs a stable copy of the packaged CLI and interface. After
upgrading the package, run `salidium service install` to stage and activate the new copy before
starting or restarting that service. The update preserves the event store, queue, settings, reports,
and other local data; installation enables and starts the updated login items.

## Running and stopping

Run `npx salidium` again the next day. It starts the background service if needed, reuses it if it is
already running, and opens the page with its current token. `salidium status` reports both the service
and the active explanation mode.

`salidium stop` pauses new collection before it stops the background service. Work already in the
queue stays there and the command prints its exact observed file count and bytes. The pause is a
24-hour lease. A later ordinary Salidium command resumes collection, and `salidium resume` does so
explicitly. Lifecycle commands whose purpose is to preserve state (`pause`, `stop`, and every
`service` command) and coordinated `storage optimize` do not implicitly resume it. If the daemon
crashes while paused and no ordinary command runs, the marker cannot clear itself. The next ordinary
command resumes collection and preserves that interval in the collection-gap ledger instead of
silently forgetting it.

Use `salidium pause` to stop new hook and transcript observations without stopping the interface.
Use **Ingest & Storage** in the interface for the same control and its **Local operations** view:
queue and store readings that are exact or explicitly unavailable, clearly labelled rate estimates,
maintenance and alert state, safe local policy, hook connection state, and the collection-gap
ledger. Completed pause and stop intervals remain in that ledger because hook-only evidence from the
interval may be absent. Disconnect removes only Salidium-owned hook entries and preserves other
tools in the provider settings.

To prevent model calls without stopping local reports, run `salidium explanations off`. The change
applies immediately and survives restarts.
It also cancels an explanation already generating. `salidium explanations when-done` and
`salidium explanations each-reply` opt back in.

## Read a report

- **What** shows the work in progress and the changes the agent made.
- **Why** keeps your ask and the agent's reported discoveries attributed.
- **How** presents the plan and approach the agent described.
- **Approach changed** shows an earlier path, its replacement, and the reported reason.
- **Verified** comes from actual test, build, typecheck, and lint output.
- **Left** contains unfinished, failing, or unknown work.
- **Review** calls out claims and actions that still need a person.

Evidence opens coverage, checks, changes, activity, and the original local record. Rewind
reconstructs the report at an earlier moment. **Models & Usage** holds explanation timing, model
choices, and provider-reported tokens. **Ingest & Storage** shares that inspector slot and accounts
for local collection cost. **Personalize** appears in the toolbar when a generated
explanation is available and adapts that explanation in place; History shows how the session unfolded.
When the record cannot support a conclusion, Salidium leaves it unknown.

The session list groups work as **Needs you**, **Working**, and **Recent**. Light, dark, and system
themes are supported and the choice is remembered locally.

**Export** saves the current live report as versioned JSON. It contains the projected report and
its evidence references, not provider transcript records. Rewind changes what you see on screen;
export still saves the complete current report.

## Local data and optional explanations

The daemon, SQLite event store, deterministic report, and interface run on your machine. Salidium
has no telemetry. Existing provider transcripts from the last seven days are imported on first run;
set `SALIDIUM_HISTORY_DAYS` to a whole number zero or greater to change that window. State lives in
`~/.salidium` with private directory and file permissions.

### Local operations and policy

`salidium status` is a one-shot health snapshot. `salidium status --watch` refreshes the same view;
use `--interval=SECONDS` from 0.5 to 60 to choose the display interval. Queue depth, oldest item,
store and recovery-log bytes, gaps, daemon and pause state, maintenance, and hook configuration are
observations. Queue velocity, drain rate, storage growth, and time to empty appear only when enough
bounded samples exist and are labelled estimates. `Store outlook` restates two of those as a
decision: roughly how much the store gains in a day at the rate just measured, and how far it is
from the size that raises the `alerts.databaseSizeBytes` notice. Both halves are projections, and a
rate measured while agents are busy does not continue overnight. `--json` returns the version 1
operations contract; `--quiet` returns only its exit meaning.

`salidium config show` prints each effective setting and whether it came from a shipped default, the
stored file, or an environment override. Change one supported value with
`salidium config set KEY VALUE`; remove that choice with `salidium config reset KEY`, or restore all
shipped defaults with `salidium config reset`. Environment overrides remain in force and are named
as such. History window, Git enrichment, and enabled-provider changes take effect after restart;
retention, alert thresholds, health history, and explainer choices apply live. UI detail sets the
initial fold state the next time the rail mounts. The Ingest & Storage rail exposes the most useful
safe preferences. Low-level relay, trust, payload, SQLite, and compression limits are intentionally
not preferences.

Provider lists use comma-separated identifiers, for example
`salidium config set providers.enabled claude-code,codex`. Use `none` to disable every provider
adapter after restart without changing provider-owned hook files.

`salidium maintenance queue` lists bounded queue metadata without reading payloads.
`salidium maintenance drain` asks the running daemon to make bounded batches durable; repeat or add
`--wait=SECONDS` to wait for empty. `salidium maintenance optimize --dry-run` reports the queue and
free-space preflight. The actual optimize flow drains, pauses, stops, checkpoints, performs the
verified copy and replacement, restarts, and returns collection to its prior state. The older
`salidium storage optimize` spelling is an alias. `salidium maintenance status` shows the durable
phase after completion, failure, or crash recovery.

Local alerts are visible in status and the rail. They cover an aging or growing queue, database
size, new collection gaps, daemon health, failed maintenance, and hook-trust changes. An alert
carries wording for both of its edges, so a recovery is announced in its own words rather than in
the ones that raised it. Acknowledge an
episode in the rail or with `salidium maintenance acknowledge ALERT_ID`. Acknowledgement lasts until
recovery; repeated samples do not create repeated alerts, and cooldown applies before a later new
episode can notify again.

Native desktop notifications are opt-in because notification previews can appear on a lock screen.
Enable them in **Local policy** or with
`salidium config set alerts.nativeNotifications true`. Notifications contain only the minimized
alert title and detail, never transcript text, prompts, commands, tokens, or filesystem paths, and
fire only for a new or recovered episode. Salidium uses the operating system's local notification
facility on macOS, Windows, and Linux when one is available. Delivery is best effort and respects
OS notification permissions. A daemon cannot report its own crash after it has exited. On macOS,
always-on mode supplies crash recovery and a separately supervised menu-bar status; elsewhere use
`salidium status --watch` or the operating system's service supervisor when that guarantee is
required.

Preview diagnostic contents with `salidium doctor --bundle --dry-run`. Generate the private JSON
bundle with `salidium doctor --bundle`; use `--output=PATH` to choose its destination. Its manifest
lists the version data, effective configuration, aggregate health and alerts, integrity result, and
bounded operational log tails it includes. Raw events, transcripts, prompts, commands and output,
tokens, secrets, and identifying paths are excluded or redacted by default. Existing output files
are never overwritten.

Optional visual explanations use the installed Claude Code or Codex CLI you select. When enabled,
Salidium sends that CLI a bounded, locally redacted summary of the ask, attributed statements, file
names, and check outcomes at the cadence you chose. The CLI may contact its provider and consume
your plan or API allowance. The invocation disables tools, treats evidence as untrusted data, and
accepts only a bounded runtime-validated result. Generated text cannot decide Verified, Left, or
Review.

Open **Models & Usage** in the session toolbar. **Models** names the work and explanation models.
**Explanation** chooses which agent writes it and when. **Choose a model** opens a short list that
adapts to that agent: the current coding model and known provider choices are shown when they apply.
Typing a model name is kept under **Other model** for installations with a model Salidium has not
seen. **Usage** keeps session tokens separate from the explanation ledger across all runs. The same
control is available before the first session exists, so defaults can be set up front.

The selected **Local only**, **When done**, or **Each reply** mode is visible in the rail. In Local
only mode the agent and model controls stay hidden because neither can be used.

Claude explanations default to the named Haiku model shown in the panel. Without an exact choice,
Codex chooses its own model and Salidium labels the result **Automatic** instead of exposing CLI
terminology or guessing a model name.

Session usage belongs to the coding-agent session being read. Explanation usage is explicitly
labelled all-time. Token figures are observed counts, not a currency estimate.

### Personalize Why and How

Choose **Personalize** in the session toolbar. Once this browser tab has a current personalized
version, the same control reads **Personalized**. It opens a compact composer above Why with one
**Terms and examples** field for what you know, comparisons that help, or terms you use.

The save state stays visible under the field as **Not saved**, **Unsaved changes**, or **Saved on
this machine**. **Apply** saves the terms and makes one explicit call to the selected explanation
agent. When a call cannot be made, including in Local only mode, the button reads **Save terms** and
stores them without generating anything. **Delete saved terms** removes the saved terms and their
owner-only `~/.salidium/personalization.json` file, and removes the personalized presentation.

Applying creates one browser-only personalized version for that report. Applying again replaces it;
versions do not stack. A filled icon-button switch labelled **Original** and **Personalized** moves
between the technical and personalized versions. Reloading the page keeps the saved terms but
discards the personalized presentation, so choose **Apply** again to recreate it. Note-derived
examples are labelled **In your terms**.

The call sends the saved terms with the existing generated Why and How; it does not resend the
transcript, prompts, commands, diffs, or raw records. Personalized presentations are never folded
into Verified, Left, Review, history, checkpoints, raw evidence, session exports, or the intelligence
sync outbox. The selected agent CLI may contact its provider when you explicitly personalize, under
that provider's own data policy. Deleting the saved terms cannot delete a record kept by that agent.

Set `SALIDIUM_EXPLAINER` to `auto`, `claude`, `codex`, or `off` to enforce a helper choice when the
daemon starts. `SALIDIUM_EXPLAIN_MODEL` similarly enforces a model override. Environment choices
lock the matching controls in the interface until the override is removed. With explanations off,
nothing is sent to an agent and the deterministic report remains available.

## Commands

| Command | Purpose |
| --- | --- |
| `salidium` | Connect detected agents on first run, then start and open Salidium. |
| `salidium start` / `salidium daemon` | Start in the background or run in the foreground. |
| `salidium open` | Open the running interface with the current token. |
| `salidium install-hooks` | Connect detected agents manually. |
| `salidium uninstall-hooks` | Remove only Salidium-owned hook entries. |
| `salidium doctor` | Check the local setup and report problems. |
| `salidium doctor --bundle [--dry-run]` | Preview or write a redacted local diagnostic bundle. |
| `salidium pause` / `salidium resume` | Pause or resume every new collection path. |
| `salidium show` | Print a report as text. |
| `salidium audit-claims` | Inspect classifier behavior against your local store. |
| `salidium reingest --all` | Re-read provider files after adapter improvements. |
| `salidium retention` | Preview or set local history retention. |
| `salidium retention apply` | Apply one bounded cleanup batch while the daemon is stopped. |
| `salidium retention compact` | Integrity-check and reclaim reusable database pages offline. |
| `salidium storage` | Inspect the event layout and SQLite page size. |
| `salidium config show` / `set` / `reset` | Inspect or change versioned policy with effective-value sources. |
| `salidium maintenance queue` / `drain` | Inspect bounded queue metadata or drain durable work safely. |
| `salidium maintenance optimize [--dry-run]` | Preflight or run the coordinated verified storage workflow. |
| `salidium maintenance status` | Show durable maintenance completion, failure, or recovery state. |
| `salidium maintenance acknowledge <alert>` | Acknowledge one alert episode until it recovers. |
| `salidium storage optimize` | Alias for the coordinated lossless optimization workflow. |
| `salidium pin [session]` / `unpin [session]` | Add or remove an automatic-retention exemption. |
| `salidium forget <id>` | Remove a session and prevent source-file resurrection. |
| `salidium status [--watch]` | Show or monitor daemon, hook, queue, store, estimate, alert, and gap state. |
| `salidium service install` / `status` | Install or inspect macOS login startup, crash recovery, and menu-bar control. |
| `salidium service enable` / `disable` | Turn installed macOS always-on mode on or off without deleting data. |
| `salidium service uninstall` | Remove only the macOS service runtime and LaunchAgents; keep local data. |
| `salidium explanations` | Show or change model-call frequency. |
| `salidium restart` | Restart Salidium and reopen the interface. |
| `salidium stop` | Pause collection, account for the queue, and stop the local daemon. |
| `salidium --version` | Print the installed version. |

## Classifier behavior

The claim classifier is deliberately conservative. A statement it cannot place remains available in
the original record but appears under no unsupported heading. `salidium audit-claims` reports the
distribution by rule, messages that produced no claim, and deterministic samples for human review.
Its behavior can vary across providers and writing styles, so local measurement is more honest than
a universal accuracy claim.

```bash
salidium audit-claims --only=discovery --sample=20
salidium audit-claims --json
```

## Current limitations

Claude Code and Codex own their session formats, so adapters may need updates. Native Windows
history import works, but the live hook relay currently requires POSIX `sh` and `curl`. Raw evidence
can be inspected only while the provider-owned source file exists. Exact loss counts are unavailable
when the host is too saturated to record each drop. Local retention is session-level, and physical
SQLite rewrites are explicit offline operations.

New stores use 16 KiB SQLite pages, an ordinary rowid `events` table, gzip BLOB event payloads above
1 KiB, and binary checkpoints. Existing stores are never rewritten during startup. After stopping
Salidium, `salidium storage optimize` builds a sibling copy, verifies every table count, a logical
SHA-256 over events and checkpoints, and both SQLite integrity checks, then swaps the verified file
atomically. The original stays recoverable through the final reopen. Collection is temporarily
paused during the operation and returns to its prior pause state afterward. Use this lossless step
before choosing retention solely to reduce file size.

See [Architecture](architecture.md) for the full evidence and storage model and
[Open-source boundary](open-source-boundary.md) for the exact hosted-service split.
