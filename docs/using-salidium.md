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

## Running and stopping

Run `npx salidium` again the next day. It starts the background service if needed, reuses it if it is
already running, and opens the page with its current token. `salidium status` reports both the service
and the active explanation mode.

`salidium stop` pauses new collection before it stops the background service. Work already in the
queue stays there and the command prints its exact observed file count and bytes. The pause is a
24-hour lease. A later Salidium command resumes collection, and `salidium resume` does so explicitly.
If the daemon crashes while paused and no command runs, the marker cannot clear itself. The next
command resumes collection and preserves that interval in the collection-gap ledger instead of
silently forgetting it.

Use `salidium pause` to stop new hook and transcript observations without stopping the interface.
Use **Ingest & Storage** in the interface for the same control, the exact queue and store readout,
hook connection state, and the collection-gap ledger. Completed pause and stop intervals remain in
that ledger because hook-only evidence from the interval may be absent. Disconnect removes only
Salidium-owned hook entries and preserves other tools in the provider settings.

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
| `salidium install-hooks` | Connect detected agents manually. |
| `salidium uninstall-hooks` | Remove only Salidium-owned hook entries. |
| `salidium doctor` | Check the local setup and report problems. |
| `salidium pause` / `salidium resume` | Pause or resume every new collection path. |
| `salidium show` | Print a report as text. |
| `salidium audit-claims` | Inspect classifier behavior against your local store. |
| `salidium reingest --all` | Re-read provider files after adapter improvements. |
| `salidium retention` | Preview or set local history retention. |
| `salidium retention compact` | Integrity-check and reclaim reusable database pages offline. |
| `salidium storage` | Inspect the event layout and SQLite page size. |
| `salidium storage optimize` | Losslessly copy, verify, and atomically install the compact layout offline. |
| `salidium pin [session]` | Exempt a session from automatic retention. |
| `salidium forget <id>` | Remove a session and prevent source-file resurrection. |
| `salidium status` | Show daemon, hook, queue, store, and collection-gap state. |
| `salidium explanations` | Show or change model-call frequency. |
| `salidium restart` | Restart Salidium and reopen the interface. |
| `salidium stop` | Pause collection, account for the queue, and stop the local daemon. |

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
