/*
 * The documentation, as data.
 *
 * One page per surface, in the order a reader meets them, as a flat numbered list. There are no
 * groups because the product has none: there is no route table, no navigation, and no `SECTIONS`
 * constant anywhere in `packages/ui`, so any grouping here would be this file's opinion wearing
 * the product's name. The version before this invented "Going deeper" and "Your machine", which is
 * exactly that.
 *
 * Every page is written in the product's own register, which was read out of its strings rather
 * than chosen: sentence case throughout, no contractions, the reader addressed as "you", Salidium
 * named in the third person, labels as bare nouns without a full stop and prose as whole sentences
 * with one. Its house terms are used and not paraphrased: `record` for the drill-through,
 * observed / reported / derived / planned / explained for provenance, "needs you" for the
 * attention channel, "the daemon", "the agent", "session".
 *
 * The page renders this tree and `/docs.md` renders the same tree, so the version a person reads
 * and the version an agent fetches cannot drift apart.
 *
 * Every claim was checked against the product source, not against the previous version of this
 * page, which stated four things Salidium does not do.
 */

import SHOTS from "./shots.json";

type Shot = { width: number; height: number; light: string; dark: string };

export type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "terms"; items: Array<[string, string]> }
  | { kind: "keys"; items: Array<[string[], string]> }
  | { kind: "command"; command: string }
  | { kind: "shot"; name: string; alt: string; cropped?: boolean }
  | { kind: "note"; text: string };

export type Page = { n: number; slug: string; title: string; summary: string; blocks: Block[] };

const p = (text: string): Block => ({ kind: "p", text });
const h = (text: string): Block => ({ kind: "h", text });
const list = (...items: string[]): Block => ({ kind: "list", items });
const terms = (items: Array<[string, string]>): Block => ({ kind: "terms", items });
const keys = (items: Array<[string[], string]>): Block => ({ kind: "keys", items });
const note = (text: string): Block => ({ kind: "note", text });
const command = (c: string): Block => ({ kind: "command", command: c });
const shot = (name: string, alt: string, cropped = false): Block => ({
  kind: "shot",
  name,
  alt,
  cropped,
});

const RAW: Array<Omit<Page, "n">> = [
  {
    slug: "install",
    title: "Install",
    summary: "One command, and the three files it asks to change.",
    blocks: [
      p("Salidium needs Node 24 or newer. There is nothing else to install first."),
      command("npx salidium"),
      p(
        "On first run it looks for Claude Code and Codex, prints the files it wants to change, and asks before adding hooks. It then asks whether the optional written Why and How should make model calls. Local only is selected by default.",
      ),
      h("What it changes"),
      terms([
        ["`~/.claude/settings.json`", "Claude Code hook entries."],
        ["`~/.codex/hooks.json`", "Codex hook entries."],
        ["`~/.salidium/hooks/relay.sh`", "The relay those hooks call, readable only by you."],
      ]),
      p(
        "Before each change to those settings files, the file is copied to `<name>.salidium-backup`, so that copy is the state immediately before the most recent change rather than the original. The relay is rewritten rather than backed up, because Salidium is the only thing that writes it. Only entries Salidium owns are added or replaced, and `salidium uninstall-hooks` takes them out again.",
      ),
      note(
        "Codex trusts a hook by the hash of its definition, so a changed hook has to be shown to it once. Salidium says so when it happens: open `/hooks` in Codex and trust it.",
      ),
      h("What it reads"),
      p(
        "Salidium imports the last seven days of the session files your agents already write. Anything older is not read. `SALIDIUM_HISTORY_DAYS` changes that; the daemon reads it every time it starts, so set it and then run `salidium restart` if one is already running.",
      ),
      h("Running it again"),
      list(
        "Run the same command later and it reopens whatever is already running.",
        "If the CLI is newer than an ordinary running daemon, it stops and restarts it. An enabled macOS always-on service uses a stable copied runtime instead; run `salidium service install` to update that copy.",
        "In a terminal that is not interactive it prints the address instead of opening a browser, and without `--yes` it changes no agent settings.",
      ),
      p(
        "`salidium stop` stops the background service but keeps your saved explanation choice. To prevent model calls while keeping local reports live, run `salidium explanations off`. `salidium status` shows both the service and explanation state.",
      ),
      h("Without a browser window"),
      p(
        "The page is a control panel, not the daemon. Closing it does not stop collection. `salidium open` returns to it, and `salidium status --watch` monitors the daemon, queue, storage, and alerts in a terminal.",
      ),
      p(
        "On macOS, `salidium service install` adds login startup, crash recovery, and a native menu-bar control. The menu leads with one sentence saying whether your agent work is being captured, then the actions that answer it: open Salidium, pause or resume recording, store waiting work when any is waiting, and stop. It also carries one storage row, showing what Salidium is using on this Mac against its warning size. Values are exact when safely observable and say unavailable rather than showing a partial value. A deliberate stop stays stopped; a crash is relaunched. `salidium service disable` turns both login items off, and `salidium service uninstall` removes their copied runtime while keeping reports and settings.",
      ),
      note(
        "The macOS installer compiles its small native helper with Apple's Swift compiler. If it is unavailable, install Xcode Command Line Tools and retry. Native lock-screen notifications remain separately opt-in.",
      ),
      h("Upgrading from 0.3.0"),
      p(
        "Keep the same Salidium home. The first 0.4.0 daemon start upgrades the version 0.3.0 schema transactionally before it starts listening. It then prepares historical token usage in bounded background batches, so collection, status, stop, and the page remain responsive. Models & Usage says Preparing token history until the exact all-time ledger is ready.",
      ),
      p(
        "Preparation records a durable cursor and resumes after a stop or crash. Retention, compaction, and storage optimization wait or refuse to run until it finishes. If always-on mode is installed, run `salidium service install` after upgrading the package so the copied runtime is updated before restart.",
      ),
    ],
  },
  {
    slug: "the-page",
    title: "Opening the page",
    summary: "What to do when the page asks for a token instead of showing you anything.",
    blocks: [
      p(
        "Salidium runs on your machine and nowhere else, so the page has to prove it is you before the daemon will talk to it. That is what the token is, and `salidium open` is how you get one.",
      ),
      shot("gate", "The Salidium page asking for a token, with the command salidium open beside a field for pasting one."),
      p("There are two ways past it, and the first is the one to use."),
      terms([
        [
          "Run `salidium open`",
          "It opens this page with the token already attached. The page offers the command with a button that copies it.",
        ],
        [
          "Paste a token",
          "The field takes the token itself, or the whole URL carrying it after `#token=`.",
        ],
      ]),
      p(
        "The token is regenerated every time the daemon starts, so a tab you left open from before a restart signs itself out and says so. This is not an expiry you can extend. It is how a restart stops being something an old tab can keep talking to.",
      ),
      h("When the daemon stops answering"),
      p(
        "The page keeps whatever it already has and says what the connection is doing, beside the session list and again in the toolbar above a report. A page that has stopped receiving events but still looks live is the one thing it must not be.",
      ),
      terms([
        ["Connecting", "Opening the connection. This is what start-up looks like."],
        ["Reconnecting", "Contact was lost and Salidium is retrying. Nothing is needed from you."],
        ["Disconnected", "Nothing is arriving, and the daemon may have stopped."],
      ]),
      p(
        "Open a session while the daemon is gone and the page says so in full, names `salidium` as the command that starts it again, and offers to try the request once more.",
      ),
      h("Light or dark"),
      p(
        "The control at the right of the toolbar above a report cycles three states: match the system, light, and dark. The choice is kept in this browser and applies to every page.",
      ),
    ],
  },
  {
    slug: "sessions",
    title: "Sessions",
    summary: "Which of your runs need you, which are still going, and which are done.",
    blocks: [
      p(
        "Every run your agents make becomes a session. The list puts the ones that need you at the top, because that is the question you open it with.",
      ),
      shot(
        "sessions",
        "The Salidium session list, grouped into Needs you, Working and Recent, with a find field above it, and the beginning of a report beside it.",
        true,
      ),
      terms([
        [
          "Needs you",
          "A waiting agent, or a running or recently stopped session with something open in Needs you. These head the panel.",
        ],
        ["Working", "Still running, and not already above."],
        ["Recent", "Everything else, newest activity first."],
        [
          "Nothing recorded",
          "Sessions that started and ended without running a turn. Folded away by default.",
        ],
      ]),
      h("The mark on a row"),
      p("Every row carries one. The question mark above the list keys the four a running agent produces; the fifth is what a row says when nothing was recorded at all."),
      terms([
        ["Working", "The agent is running."],
        ["Waiting for you", "It has asked for something and stopped."],
        ["Idle", "Running, but nothing is happening."],
        ["Ended", "Finished."],
        ["Unknown", "No status was recorded."],
      ]),
      p(
        "A row can also carry a count of things to review. While the session is running that reads as needing you now; once it has stopped it reads as flagged during the session. Open a row and you get its [report](/docs/report).",
      ),
      h("Finding one"),
      p(
        "The field above the list searches the whole store by name, repository and id, not only the sessions on screen. Salidium says how many it searched and how many it is showing, because the panel is a window onto a larger store rather than all of it.",
      ),
    ],
  },
  {
    slug: "report",
    title: "Reading a report",
    summary: "Whether the checks passed, what is still open, and what is waiting on you.",
    blocks: [
      p(
        "A session opens as a report, and the report is built to answer one question first: can you leave this alone, or does it need you? Everything else is underneath that answer.",
      ),
      p(
        "The report does not wait for the run to end. It updates while the agent is still working, and the verdict moves with it. An [explanation](/docs/explanations) is the one part that arrives at the end of a turn rather than as things happen.",
      ),
      shot("masthead", "The top of a Salidium report: the session title, its tags, and the verdict reading 4 files changed, unverified."),
      h("The verdict"),
      p(
        "One line, chosen in a fixed order of priority, and it is the first thing Salidium is willing to say about the run.",
      ),
      list(
        "The run is waiting on you.",
        "A check failed and nothing has passed since.",
        "The agent is still working, and on what.",
        "Files changed, and nothing has verified them.",
        "The last check passed, and which.",
        "How many things need you, or how many files changed, when there is nothing else to say.",
      ),
      p(
        "The verdict says how it was reached as well as what it is, so a line worked out rather than read from output says so. Open it and you get the checks it was read from, and [Evidence](/docs/evidence) has the rest of the working.",
      ),
      h("Verified"),
      p(
        "Salidium recognises test, build, typecheck and lint runners by the command that was run, then reads the output.",
      ),
      terms([
        ["Passed", "The output said so, the exit code said so, or both. Where only one of them was available the row says which."],
        ["Failed", "The run reported failures, or exited non-zero."],
        [
          "Partial",
          "The output claimed a pass and the exit code disagreed. This is about the two disagreeing, not about how much the run covered.",
        ],
        ["Unknown", "Nothing recognisable came back, or the run has not finished."],
      ]),
      p(
        "A command name is not proof. What the output said outranks what the command looked like, and a run that is not the latest of its kind is flagged as such.",
      ),
      h("Scope is not outcome"),
      p(
        "A run narrowed to a path or a filter is recorded as partial scope, separately from whether it passed. A partial-scope pass never clears unverified, and neither does a lint pass on its own. A check that ran is not a check that covered the work.",
      ),
      h("Left"),
      list(
        "Plan steps still pending or in progress.",
        "Checks Salidium saw fail, with no later passing run.",
        "Up to five things the agent said in its last turn were still outstanding.",
      ),
      p(
        "Only the second of those is Salidium's own observation. The first is the agent's task list and is marked as planned; the third is the agent's word for it and is marked as reported. [How we know](/docs/provenance) is what tells them apart on the page.",
      ),
      h("Needs you"),
      p(
        "Each entry names the rule that raised it, and says how many times it fired when it fired more than once.",
      ),
      terms([
        ["A waiting prompt", "The agent asked for permission, for input, or a question."],
        ["A failed check", "A run failed and nothing has passed since."],
        ["A failed turn", "The turn itself ended in error."],
        [
          "A destructive command",
          "`rm -rf`, a force push, a hard reset, a discarding checkout, `--no-verify` and four others.",
        ],
        ["A push", "Work left the machine."],
        ["Unverified changes", "Files changed with no passing check behind them."],
        ["A claim without evidence", "The agent said checks passed when none ran."],
      ]),
      h("Export the report"),
      p(
        "Export saves the report you can inspect in Salidium as versioned JSON. It includes the projected report and its provenance references, not the provider's raw transcript records, and it never uploads the file.",
      ),
    ],
  },
  {
    slug: "evidence",
    title: "Evidence",
    summary: "The working behind the verdict, when you want to check it yourself.",
    blocks: [
      p(
        "The verdict is short because it has to be. When you want to see what it was read from, Evidence has the working, as four separate questions rather than one long scroll.",
      ),
      shot("evidence", "The Evidence panel in Salidium, showing coverage of changed files against passing checks."),
      terms([
        [
          "Coverage",
          "How many changed files have had a passing check since they were last edited, as a grid you can open a file from. The first hundred and twenty are drawn and the rest are counted.",
        ],
        [
          "Checks",
          "Every run of every method, oldest first, with the ones Salidium worked out drawn hollow.",
        ],
        [
          "Changed",
          "The files that moved, ranked by lines, with the twenty largest drawn and a count of the rest.",
        ],
        [
          "What happened",
          "The run in order, turn by turn, with what each turn did. A turn that handed work to subagents lists them underneath it, each with what it came back with.",
        ],
      ]),
      p(
        "A filled square means that one file has had a passing check since it was last edited. It does not mean the project is green, and Coverage says so on the page rather than letting the picture imply it.",
      ),
      p("Anything in any of the four views opens its [record](/docs/records)."),
      note(
        "A turn that edited files and ran no check is marked as having nothing check those edits. An absence is a fact about the run, so it is drawn rather than left out.",
      ),
    ],
  },
  {
    slug: "rewind",
    title: "Rewind, History and Models & Usage",
    summary: "Seeing what a report said an hour ago, what changed since, and how much of it there is.",
    blocks: [
      p(
        "A report shows a session as it stands. These three answer the questions that are about time rather than about now.",
      ),
      h("Rewind"),
      p(
        "Rewind lifts the report to reveal a contrasting tray beneath it. Choose a turn or event badge, or drag the playhead, and the page becomes the session as it stood at that moment, with everything later hidden. Now returns to the current report and follows live work; for a finished run, choose Whole session.",
      ),
      shot("rewind", "Rewind revealed beneath the report, with pastel turn bands and event badges along one track."),
      p(
        "Pastel bands and badges identify turns, keeping the same color as you move through the run; color does not indicate success. Icons identify recorded activity, checks, and commits. A small count marks grouped events, which can span turns. The badge keeps its representative event’s turn color, and its hover label summarizes the group. Failed checks take priority in the icon; a checkmark represents a passing check, not a verdict on the whole group.",
      ),
      p(
        "The rail scrolls horizontally without changing the selected moment. Drag the playhead or use the arrow keys to step through changes, not minutes. Choose Rewind again, or press Escape while using the tray, to hide it and keep the selected moment.",
      ),
      h("History"),
      p(
        "History lists every change Salidium derived, oldest first, each with the kind of change it was and how it is known. It is a log, so it sits at the bottom where the newest entry is. Open it as a table across the page and it gains a How we know column.",
      ),
      shot(
        "history",
        "The Salidium history table, listing each change with when it happened, its kind, what changed, and a How we know column.",
      ),
      p(
        "The filter narrows it to any of seven kinds: status, what changed, why, how, checks, left to do, needs review. When you come back to a session that moved while you were away, Salidium offers the changes since you last had it open, and History opens scoped to them.",
      ),
      h("Models & Usage"),
      p(
        "One compact rail for explanation timing, the work and explanation models, and exact token usage. Personalization has its own control beside it.",
      ),
      shot(
        "models-usage",
        "The Salidium Models & Usage rail, showing explanation controls, models, and separate usage totals.",
      ),
      terms([
        ["Models", "The work model and, when enabled, the model used for the explanation."],
        ["Explanation", "Whether model calls are off, run once when done, or run after each reply. Agent and model choices appear only when they can be used."],
        ["Usage", "Exact session tokens and the separate all-time explanation ledger."],
      ]),
      note(
        "After an upgrade from 0.3.0, the all-time ledger can say Preparing token history while a resumable background worker builds it. No partial token total is presented as exact.",
      ),
      note(
        "No figure appears in currency. That would be Salidium's arithmetic over a price table it does not carry, and on a subscription no amount is charged.",
      ),
    ],
  },
  {
    slug: "records",
    title: "Records",
    summary: "The original line your agent wrote, behind any statement on the page.",
    blocks: [
      p(
        "Nothing on a report is asserted without something behind it. The word `record` beside a statement opens what that is: the line in the file your agent wrote, where there is one, and always what Salidium stored.",
      ),
      shot("record", "The Salidium record drawer, showing what Salidium stored beside the original line from the agent's own file."),
      terms([
        ["Salidium event", "What Salidium derived and stored."],
        ["Provider record", "The original line from the agent's own file, with its path and line number."],
        ["How we know", "When it happened, which lane it belongs to, its turn, what was redacted, its id."],
      ]),
      p(
        "The arrow keys step to the record before and after this one in stored order, and the drawer will save both halves as a JSON file. Every [keyboard shortcut](/docs/keyboard) is listed together.",
      ),
      p(
        "A provider line is not always there to show. The commonest reason is that there is none: an event that arrived by hook, or one Salidium derived, has no line in anyone's file. Beyond that the content may have been suppressed as sensitive, the file may be gone, or the record may have moved or changed since it was read. Salidium says which applies rather than showing whatever now occupies the line.",
      ),
    ],
  },
  {
    slug: "provenance",
    title: "How we know",
    summary: "Whether Salidium saw a thing happen, or is repeating what the agent said about it.",
    blocks: [
      p(
        "Your agent says the tests passed. Did Salidium watch them pass, or is it passing on a sentence the agent wrote? Every line of a report answers that, and these are the five answers it can give.",
      ),
      terms([
        [
          "Observed",
          "Recorded by a runtime or by Salidium: a diff, an exit code, a commit. Never written by a model.",
        ],
        [
          "Reported",
          "The agent's words, or yours. Relayed and attributed, never promoted to observed by parsing them.",
        ],
        [
          "Derived",
          "Salidium's own deterministic working. Where a named rule decided it, that rule's id is carried with it.",
        ],
        ["Planned", "Items from the agent's task list, which are intent rather than fact."],
        [
          "Explained",
          "The optional written explanation, and only ever that. This is the word on the page: the badge reads `explained`.",
        ],
      ]),
      note(
        "Observed is the default and prints nothing. Only the exceptions are labelled, because a badge on every line would say the same thing everywhere and so say nothing.",
      ),
      h("When it cannot tell"),
      p("Where the record does not establish something, Salidium says so rather than filling the gap."),
      list(
        "An exit code that was never observed stays unknown. It does not become zero.",
        "A duration it cannot compute prints unknown.",
        "Token counts it never saw are left out, not shown as nought.",
        "A session with nothing in it is grouped as nothing recorded rather than described.",
      ),
    ],
  },
  {
    slug: "explanations",
    title: "Explanations",
    summary: "The one part of a report a model writes, with visible routing and usage.",
    blocks: [
      p(
        "Most of a report is what Salidium observed. One part of it is prose, and prose has to be written by something.",
      ),
      p(
        "Salidium hands your own installed Claude or Codex CLI, or a local model you run in Ollama, a short, redacted summary of the session and lets it write that part. It is labelled wherever it appears. Nothing leaves unless you choose one of these explanation calls, and you can switch scheduled calls off without losing anything else on the page.",
      ),
      h("When it runs"),
      terms([
        ["Local only", "The full deterministic page, with no model calls. This is the default."],
        ["When done", "One model call after the session finishes or goes quiet."],
        ["Each reply", "One model call after every agent reply."],
      ]),
      p(
        "Open Models & Usage to choose when explanations run and which agent writes them. Choose a model opens a short list that adapts to the selected agent; Other model keeps manual entry available as a fallback. The same control is available before the first session exists.",
      ),
      note(
        "Stopping the daemon does not erase the saved mode. Use `salidium explanations off` as the persistent no-model-call control; local reports keep working and an explanation already generating is canceled.",
      ),
      h("What it uses"),
      p(
        "Models & Usage separates the work agent from the explanation helper in one rail. Session usage belongs to the work being read. Explanation usage is the observed all-time ledger. Both are token counts reported by the agent CLI, never a currency estimate.",
      ),
      note(
        "Claude defaults to the named Haiku model shown in the panel. When no exact model is chosen, Codex selects its own model. Salidium labels that Automatic instead of exposing CLI terminology or guessing a model name.",
      ),
      h("A local model"),
      p(
        "Choose Local model to have the explanation written by a model you already run in Ollama on the same machine. It is a model call, so it is not the same thing as Local only, but nothing crosses the machine's boundary: Salidium sends the same redacted summary to Ollama at `127.0.0.1:11434` and to nothing else.",
      ),
      list(
        "There is no default model. Choose a model lists only the models Ollama already has installed, and Salidium never downloads one.",
        "Ollama cloud models are left out. Ollama can run a model on ollama.com and forward requests to it, so Salidium refuses `cloud`-tagged names and asks Ollama about each model before using it.",
        "The promise covers Salidium's own connection. Whatever answers on that loopback port is trusted as Ollama, so a proxy or tunnel you run there would receive the summary.",
        "`OLLAMA_HOST` can move the port, but only to a loopback address: `127.0.0.1`, `::1` or `localhost`, which is read as `127.0.0.1` without asking a name server. Any other address is refused and nothing is called.",
        "A redirect from that address is refused rather than followed, and a reply larger than the same 128 KB limit the CLI routes have is cut off and counted as a failure.",
        "Same as coding never picks the local model, and choosing it never falls back to Claude or Codex. If Ollama is not running, or the model is missing, nothing is sent anywhere.",
        "The explanation names the model it was written by, for example `qwen3.6:35b-a3b-nvfp4 · Ollama`.",
      ),
      note(
        "Salidium first asks Ollama to hold the answer to the explanation's schema. Some local builds, including the MLX ones, answer that they cannot (HTTP 501, structured output is unavailable). Salidium then asks once more with the schema written into the request instead, and remembers that for the model until the daemon restarts. Either way, what comes back is validated before it can appear, and an answer that does not fit is recorded as a failure.",
      ),
      h("What it is given"),
      list(
        "The last prompt.",
        "Up to forty of the agent's statements.",
        "Fifteen file names, shortened to their last two segments.",
        "The last six check results.",
      ),
      h("Personalize Why and How"),
      p(
        "Choose Personalize in the session toolbar. Once this browser tab has a current personalized version, the same control reads Personalized. It opens a compact composer above Why with one Terms and examples field for what you know, comparisons that help, or terms you use.",
      ),
      p(
        "The save state stays visible under the field as Not saved, Unsaved changes, or Saved on this machine. Apply saves the terms and makes one explicit model call. When a call cannot be made, including in Local only mode, the button reads Save terms and stores them without generating anything. Delete saved terms removes the owner-only local file and the personalized presentation.",
      ),
      p(
        "Each report has one browser-only personalized version. Applying again replaces it rather than stacking another. A filled icon-button switch labelled Original and Personalized moves between the two versions. Reloading keeps the saved terms but discards the presentation, so choose Apply again to recreate it. Analogies are labelled In your terms.",
      ),
      note(
        "The terms can never change Verified, Left or Needs you. Personalizing sends them with the generated Why and How, not transcripts, prompts, commands, diffs or raw records. The selected agent may contact its provider. Deleting saved terms cannot delete a record kept by that agent.",
      ),
      h("What it cannot do"),
      list(
        "It runs with its tools switched off, in a directory of its own.",
        "Its own run never appears as a session in your list.",
        "What comes back is validated against a schema before it can appear anywhere.",
        "It cannot change Verified, Left or Needs you.",
      ),
      h("When there is not one"),
      p(
        "The panel says which of these applies rather than leaving a gap, and in every case the observed and derived parts of the report are unaffected.",
      ),
      terms([
        ["Explanations are off", "Nothing was sent to any agent."],
        [
          "No compatible command",
          "No Claude or Codex CLI that Salidium can run was found, or Local model has no model chosen or a refused address, so nothing was sent.",
        ],
        [
          "Asked, and nothing usable came back",
          "The agent answered but the answer did not validate, and the next turn tries again.",
        ],
        ["Not yet", "One is written when the agent finishes its next turn."],
      ]),
      note(
        "Turn it off and every observed and derived part of the page stays exactly as it is. Nothing else on a report depends on it, and [How we know](/docs/provenance) is what labels it wherever it appears.",
      ),
    ],
  },
  {
    slug: "local",
    title: "What stays on your machine",
    summary: "What Salidium keeps, where it keeps it, and what it runs in your repository.",
    blocks: [
      p(
        "The daemon, the event store, the report and the interface never leave your machine. There is no account, no telemetry and no hosted service.",
      ),
      list(
        "State lives in `~/.salidium`, or wherever `SALIDIUM_HOME` points. [Environment](/docs/environment) lists the rest.",
        "The daemon listens only on `127.0.0.1`, by default on port `47822`.",
        "Every request for your data carries a token, regenerated each time it starts.",
        "The directories it creates are readable only by you, and it repairs their permissions on every start.",
        "Optional saved personalization terms live separately in `personalization.json`; Delete saved terms removes the file.",
      ),
      h("Local operations"),
      p(
        "Ingest & Storage and `salidium status` read the same versioned local operations state. Queue and store values are exact when safely observable and explicitly unavailable when a bounded scan cannot establish a total. Queue velocity, drain rate, storage growth, and time to empty are labelled estimates and appear only after enough exact samples exist. What is using this space measures the store on request, splitting it into recorded sessions, replay checkpoints, provenance records, reusable space, and the remainder of indexes and internal structure, with the projects that account for it ranked beneath; it reads every stored event, so it is asked for rather than polled and carries the moment it was taken.",
      ),
      list(
        "Local policy records whether each value came from a shipped default, the stored file, or an environment override.",
        "Alerts cover queue age and growth, storage size, collection gaps, daemon health, maintenance failure, and hook-trust changes. Acknowledgement lasts until recovery.",
        "Native notifications are separately opt-in because previews may appear on a lock screen. They contain minimized alert metadata, no session content or filesystem paths, and delivery depends on the operating system.",
        "`salidium doctor --bundle --dry-run` previews a diagnostic manifest. Writing the bundle is a CLI-only action; it excludes raw events, transcripts, prompts, commands and output, tokens, secrets, and identifying paths.",
      ),
      h("Your repository"),
      p(
        "When a turn ends, when a session starts, and after the agent commits, for a live session inside a git repository, Salidium runs four read-only commands to record where the work sat.",
      ),
      list(
        "`git rev-parse --show-toplevel`",
        "`git rev-parse HEAD`",
        "`git rev-parse --abbrev-ref HEAD`",
        "`git status --porcelain=v2 --untracked-files=normal`",
      ),
      p("Nothing is written, and `SALIDIUM_NO_GIT=1` switches it off."),
      h("Redaction"),
      p(
        "Credential-shaped strings are redacted, and files on paths that hold credentials have their contents withheld. Both happen when an event is ingested rather than when it is shown. So what Salidium suppresses is suppressed everywhere: in what it shows you, and in the packet an [explanation](/docs/explanations) is written from.",
      ),
      note("How much was redacted is counted without exposing the matched value."),
    ],
  },
  {
    slug: "keyboard",
    title: "Keyboard",
    summary: "Every shortcut in the page.",
    blocks: [
      keys([
        [["["], "Show or hide the session list."],
        [["h"], "Show or hide History."],
        [["l"], "Back to live, while a past moment is being shown."],
        [["←", "→"], "The record before or after this one, while a record is open."],
        [["Esc"], "Close the record, a panel, a popover, or the session list on a narrow window."],
        [["Tab"], "Move within whatever is open, and no further."],
      ]),
      note(
        "Shortcuts are ignored while you are typing in a field, and while a modifier key is held, so they never take a keystroke meant for the search box.",
      ),
    ],
  },
  {
    slug: "cli",
    title: "CLI",
    summary: "The commands, and which of them need the daemon stopped.",
    blocks: [
      terms([
        ["`salidium`", "Start it and open the page. This is what `npx salidium` runs."],
        ["`salidium start`", "Start the daemon in the background without opening the page."],
        ["`salidium daemon`", "Run the daemon in the foreground."],
        ["`salidium open`", "Open the page with the current token attached."],
        ["`salidium status`", "Show daemon, always-on, collection, queue, storage, maintenance, alert, and gap state. Observations are exact or explicitly unavailable; rates are labelled estimates."],
        ["`salidium status --watch`", "Continuously refresh local operational state without the browser."],
        ["`salidium pause`", "Pause every new collection path for up to 24 hours."],
        ["`salidium resume`", "Resume collection immediately."],
        ["`salidium restart`", "Restart it and reopen the page. Add `--no-open` to skip the page."],
        ["`salidium stop`", "Pause new collection, account for queued work, and stop the daemon."],
        ["`salidium service install`", "On macOS, add login startup, crash recovery, and menu-bar control."],
        ["`salidium service status`", "Inspect the macOS login service and menu bar."],
        ["`salidium service enable`", "Re-enable installed macOS always-on mode."],
        ["`salidium service disable`", "Stop and disable always-on mode without deleting data."],
        ["`salidium service uninstall`", "Remove only the macOS service files and keep local data."],
        ["`salidium config show`", "Show every effective policy value and whether it came from defaults, storage, or the environment."],
        ["`salidium config set KEY VALUE`", "Set one supported local policy value."],
        ["`salidium config reset [KEY]`", "Reset one stored value or all of them to inheritance."],
        ["`salidium maintenance status`", "Show durable maintenance completion, failure, or recovery state."],
        ["`salidium maintenance queue`", "Inspect bounded queue file metadata without reading payloads."],
        ["`salidium maintenance drain`", "Drain toward empty through bounded daemon passes. Use `--wait=SECONDS` to change the default 30-second interval."],
        ["`salidium maintenance optimize [--dry-run]`", "Preflight or run coordinated, verified storage optimization."],
        ["`salidium maintenance acknowledge ALERT_ID`", "Acknowledge one local alert episode until it recovers."],
        ["`salidium explanations`", "Show the active model-call mode, or set `off`, `when-done`, or `each-reply`."],
        ["`salidium doctor`", "Check the local setup and report problems."],
        ["`salidium doctor --bundle [--dry-run]`", "Preview or write a bounded, redacted local diagnostic bundle."],
        ["`salidium show`", "Print a session as a report in the terminal."],
        ["`salidium install-hooks`", "Connect an agent, or reconnect one."],
        ["`salidium uninstall-hooks`", "Disconnect it again."],
        ["`salidium reingest`", "Queue session files to be re-read on the next daemon start. One session, or `--all`, then `salidium restart`."],
        ["`salidium retention`", "Show or set how long sessions are kept."],
        ["`salidium retention apply`", "Apply one bounded cleanup batch while the daemon is stopped."],
        ["`salidium retention compact`", "Integrity-check and return reusable SQLite pages to the operating system while stopped."],
        ["`salidium storage`", "Inspect the event layout and SQLite page size."],
        ["`salidium storage composition`", "Measure what is using the space, by part and by project."],
        ["`salidium storage optimize`", "Alias for coordinated, verified storage optimization."],
        ["`salidium pin`", "Exempt a session from automatic retention."],
        ["`salidium unpin`", "Remove that exemption."],
        ["`salidium forget`", "Delete one session for good. Requires `--yes`."],
        ["`salidium audit-claims`", "Measure the claim classifier against every session in your store."],
        ["`salidium --version`", "Print the installed version."],
      ]),
      note(
        "`reingest`, `retention`, `pin`, `unpin` and `forget` will not write while Salidium is running. Stop it first; offline maintenance does not rewrite a store under a running daemon.",
      ),
      note(
        "An ordinary command implicitly resumes paused collection. `pause`, `stop`, every `service` command, and coordinated `storage optimize` do not; `resume` changes collection state explicitly.",
      ),
    ],
  },
  {
    slug: "environment",
    title: "Environment",
    summary: "The variables the daemon reads.",
    blocks: [
      terms([
        ["`SALIDIUM_HOME`", "Where state lives. Defaults to `~/.salidium`."],
        ["`SALIDIUM_PORT`", "The loopback port. Defaults to `47822`."],
        [
          "`SALIDIUM_HISTORY_DAYS`",
          "How far back to import session files. Defaults to `7`. Must be a whole number, and the daemon refuses to start on anything else.",
        ],
        [
          "`SALIDIUM_EXPLAINER`",
          "`auto`, `claude`, `codex`, `ollama` or `off`. Enforces the helper choice and locks that control in the page.",
        ],
        ["`SALIDIUM_EXPLAIN_MODEL`", "Enforces a model id for the explainer and locks that control in the page."],
        ["`SALIDIUM_NO_GIT`", "Set to `1` to stop the git snapshots."],
        ["`SALIDIUM_LOG`", "`silent`, `info` or `debug`. Defaults to `info`."],
        ["`SALIDIUM_LOG_FILE`", "Where the structured log is written. The CLI sets it when it starts the daemon."],
        ["`SALIDIUM_EXPLAIN`", "Set to `0` to switch explanations off. The older spelling of `SALIDIUM_EXPLAINER=off`."],
        ["`CLAUDE_CONFIG_DIR`", "Where Claude Code keeps its settings. Defaults to `~/.claude`."],
        ["`CODEX_HOME`", "Where Codex keeps its state. Defaults to `~/.codex`."],
        ["`OLLAMA_HOST`", "Where the Local model route reaches Ollama. Defaults to `127.0.0.1:11434`. Only a loopback address is accepted."],
      ]),
    ],
  },
  {
    slug: "limits",
    title: "Limits",
    summary: "Where Salidium stops, and what to do about it.",
    blocks: [
      terms([
        [
          "Native Windows",
          "No hook relay: it needs a POSIX shell and curl. Salidium still reads the session files your agents write, so history and live tailing work. What is lost is the sub-second hook notification.",
        ],
        [
          "Recognised checks",
          "Only a fixed list of test, build, typecheck and lint runners counts as a check. A watch-mode run and a backgrounded run never do.",
        ],
        [
          "A session read once",
          "During normal operation it is not read again, however much the adapter improves, because its cursor still matches. `salidium reingest --all` then `salidium restart` is what recovers it. A product upgrade may also queue a bounded repair when the stored evidence contract changes.",
        ],
        [
          "Retention",
          "Sessions are kept forever unless you set a policy. Working, waiting and pinned sessions are never removed by one.",
        ],
        [
          "Ingest problems",
          "An unreadable transcript record becomes an ingest warning. A malformed or oversized hook payload is logged. When relay pressure drops hook evidence, Salidium records a durable collection gap; the exact dropped-event count can be unavailable under concurrent saturation.",
        ],
      ]),
      note(
        "`salidium doctor` is the first thing to run when something is wrong. It checks the setup and prints what it finds rather than a score. The rest of the commands are under [CLI](/docs/cli).",
      ),
    ],
  },
];

export const PAGES: Page[] = RAW.map((page, i) => ({ ...page, n: i + 1 }));

export function findPage(slug: string): Page | undefined {
  return PAGES.find((page) => page.slug === slug);
}

export const OVERVIEW = {
  title: "Salidium documentation",
  lede: "Salidium turns a Claude Code or Codex run into a report you can check. It runs on your machine, and every statement on a report says how it is known.",
};

/*
 * The index an agent is handed first, at `/llms.txt`. It is a map rather than the text: a name, a
 * line saying what is there, and where the text of it is. A fetcher that wants one page can take
 * one page instead of the whole set.
 */
export function llmsTxt(origin = "https://salidium.com"): string {
  return [
    `# Salidium`,
    "",
    `> ${OVERVIEW.lede}`,
    "",
    "## Documentation",
    "",
    ...PAGES.map((page) => `- [${page.title}](${origin}/docs/${page.slug}.md): ${page.summary}`),
    "",
    "## Optional",
    "",
    `- [All of the above, as one file](${origin}/docs.md)`,
    "",
  ].join("\n");
}

/*
 * Cross-references, made resolvable. In the tree a link is written the way the page needs it,
 * `[Evidence](/docs/evidence)`, and the Markdown used to carry that through untouched: an agent
 * that fetched `/docs/report.md` was handed a root-relative path with no base to resolve it
 * against, and resolving it anyway landed on the HTML it had deliberately not asked for.
 *
 * `llmsTxt` and the image emitter already build absolute `.md` URLs from `origin`. This is the
 * same rule applied to prose.
 */
function links(text: string, origin: string): string {
  return text.replace(/\]\(\/docs\/([a-z0-9-]+)\)/g, `](${origin}/docs/$1.md)`);
}

/*
 * The same tree, as Markdown. Served at `/docs.md` and `/docs/<slug>.md`, advertised by every page
 * with a `rel="alternate"` link, and copied by the control in the head, because anything asked to
 * read these docs should be handed the text rather than made to strip tags out of a rendered page.
 */
export function docsMarkdown(origin = "https://salidium.com", slug?: string): string {
  const pages = slug ? PAGES.filter((page) => page.slug === slug) : PAGES;
  const out: string[] = [];
  /*
   * One page fetched on its own is a document and starts at `#`; the same page inside the combined
   * file is a section of one and starts at `##`. It used to start at `##` either way, so
   * `/docs/report.md` was a hierarchy with no root, and fourteen of them spliced into one context
   * were fourteen co-equal sections belonging to nothing.
   */
  const top = slug ? 1 : 2;
  const hash = (n: number) => "#".repeat(n);

  if (!slug) out.push(`# ${OVERVIEW.title}`, "", OVERVIEW.lede, "", `Source: ${origin}/docs`, "");

  for (const page of pages) {
    out.push(
      slug ? `# ${page.title}` : `${hash(top)} ${page.n}. ${page.title}`,
      "",
      page.summary,
      "",
      `Source: ${origin}/docs/${page.slug}`,
      "",
    );
    for (const block of page.blocks) {
      if (block.kind === "p") out.push(links(block.text, origin), "");
      else if (block.kind === "h") out.push(`${hash(top + 1)} ${block.text}`, "");
      else if (block.kind === "note") out.push(`> ${links(block.text, origin)}`, "");
      else if (block.kind === "list")
        out.push(...block.items.map((i) => `- ${links(i, origin)}`), "");
      else if (block.kind === "command") out.push("```sh", block.command, "```", "");
      else if (block.kind === "shot") {
        const file = (SHOTS as Record<string, Shot>)[block.name]?.light;
        if (file) out.push(`![${block.alt}](${origin}/docs/${file})`, "");
      }
      else if (block.kind === "terms")
        out.push(
          ...block.items.map(([name, meaning]) => `- **${name}**: ${links(meaning, origin)}`),
          "",
        );
      else if (block.kind === "keys")
        out.push(
          ...block.items.map(
            ([ks, meaning]) => `- **${ks.map((k) => `\`${k}\``).join(" ")}**: ${meaning}`,
          ),
          "",
        );
    }
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
