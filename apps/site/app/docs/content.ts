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
 * observed / reported / derived / planned / generated for provenance, "needs you" for the
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
        "On first run it looks for Claude Code and Codex, prints the files it wants to change, and asks once. Answer anything but yes and nothing is written.",
      ),
      h("What it changes"),
      terms([
        ["`~/.claude/settings.json`", "Claude Code hook entries."],
        ["`~/.codex/hooks.json`", "Codex hook entries."],
        ["`~/.salidium/hooks/relay.sh`", "The relay those hooks call, readable only by you."],
      ]),
      p(
        "Before each change, the file it is about to edit is copied to `<name>.salidium-backup`, so that copy is the state immediately before the most recent change rather than the original. Only entries Salidium owns are added or replaced, and `salidium uninstall-hooks` takes them out again.",
      ),
      note(
        "Codex trusts a hook by the hash of its definition, so a changed hook has to be shown to it once. Salidium says so when it happens: open `/hooks` in Codex and trust it.",
      ),
      h("What it reads"),
      p(
        "Salidium imports the last seven days of the session files your agents already write. Anything older is not read. Set `SALIDIUM_HISTORY_DAYS` before the first run to change that.",
      ),
      h("Running it again"),
      list(
        "Run the same command later and it reopens whatever is already running.",
        "If the CLI is newer than the running daemon, it stops and restarts it.",
        "In a terminal that is not interactive it prints the address instead of opening a browser, and without `--yes` it changes nothing at all.",
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
      p("Every row carries one, and the question mark above the list keys them."),
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
    summary: "Whether the work is finished, whether it is checked, and what is waiting on you.",
    blocks: [
      p(
        "A session opens as a report, and the report is built to answer one question first: can you leave this alone, or does it need you? Everything else is underneath that answer.",
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
      p("Each entry names the rule that raised it, with how many times it fired."),
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
          "How many changed files have had a passing check since they were last edited, as a grid you can open a file from.",
        ],
        [
          "Checks",
          "Every run of every method, oldest first, with the ones Salidium worked out drawn hollow.",
        ],
        [
          "Changed",
          "The files that moved, ranked by lines, with the twenty largest drawn and a count of the rest.",
        ],
        ["What happened", "The run in order, turn by turn, with what each turn did."],
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
    title: "Rewind, History and Quantities",
    summary: "Seeing what a report said an hour ago, what changed since, and how much of it there is.",
    blocks: [
      p(
        "A report shows a session as it stands. These three answer the questions that are about time rather than about now.",
      ),
      h("Rewind"),
      p(
        "Rewind puts a scrubber at the foot of the session. Drag it and the page becomes the session as it stood at that moment, with everything later hidden.",
      ),
      shot("rewind", "The Salidium rewind scrubber under a report, with marks for checks and commits along the track."),
      p(
        "The track is one step per change, not per minute. A mark is a check or a commit, red where a check failed, and marks too close to draw apart are merged into one that takes the worst outcome in it.",
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
      h("Quantities"),
      p("Measured totals beside the session, and only the ones that were observed."),
      shot(
        "quantities",
        "The Salidium quantities rail, showing changes, activity, model usage and the latest check.",
      ),
      terms([
        ["Changes", "Files, added, removed."],
        ["Activity", "Duration, commits, turns."],
        ["Model", "Responses, input, output, cache read, cache write."],
        ["Latest check", "The method, the outcome, the time."],
        [
          "Data handling",
          "Credential-shaped strings redacted, records that could not be read, context compactions.",
        ],
      ]),
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
        ["Derived", "Salidium's own deterministic working, carrying the id of the rule behind it."],
        ["Planned", "Items from the agent's task list, which are intent rather than fact."],
        ["Generated", "The optional written explanation, and only ever that."],
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
    summary: "The one part of a report a model writes, and how to turn it off.",
    blocks: [
      p(
        "Most of a report is what Salidium observed. One part of it is prose, and prose has to be written by something.",
      ),
      p(
        "Salidium hands your own installed Claude or Codex CLI a short, redacted summary of the session and lets it write that part. It is labelled wherever it appears, it is the only thing that leaves the daemon, and you can switch it off without losing anything else on the page.",
      ),
      h("When it runs"),
      terms([
        ["Off", "The page Salidium derives, and nothing else. No model is ever called."],
        ["When a session ends", "One explanation each, written once a session has finished or gone quiet."],
        ["While it works", "A fresh explanation at every turn end. This is the default."],
      ]),
      p(
        "The control is in the session list, under the sliders. `SALIDIUM_EXPLAINER=off` switches it off in the daemon's environment and outranks whatever is chosen here, and the control says so when it is set.",
      ),
      h("What it is given"),
      list(
        "The last prompt.",
        "Up to forty of the agent's statements.",
        "Fifteen file names, shortened to their last two segments.",
        "The last six check results.",
      ),
      h("What it cannot do"),
      list(
        "It runs with its tools switched off, in a directory of its own.",
        "Its own run is never ingested back as a session.",
        "What comes back is validated against a schema before it can appear anywhere.",
        "It cannot change Verified, Left or Needs you.",
      ),
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
        "Every request to it carries a token, regenerated each time it starts.",
        "The directories it creates are readable only by you, and it repairs their permissions on every start.",
      ),
      h("Your repository"),
      p(
        "At turn boundaries, for a session inside a git repository, Salidium runs four read-only commands to record where the work sat.",
      ),
      list(
        "`git rev-parse --show-toplevel`",
        "`git rev-parse HEAD`",
        "`git rev-parse --abbrev-ref HEAD`",
        "`git status --porcelain=v2`",
      ),
      p("Nothing is written, and `SALIDIUM_NO_GIT=1` switches it off."),
      h("Redaction"),
      p(
        "Credential-shaped strings are redacted, and files on paths that hold credentials have their contents withheld. Both happen when an event is ingested rather than when it is shown. So what Salidium suppresses is suppressed everywhere: in what it shows you, and in the packet an [explanation](/docs/explanations) is written from.",
      ),
      note("How much was redacted is counted, and the count is in Quantities under data handling."),
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
        ["`salidium open`", "Open the page with a fresh token attached."],
        ["`salidium status`", "Show the daemon and connection state."],
        ["`salidium doctor`", "Check the local setup and report problems."],
        ["`salidium show`", "Print a session as a report in the terminal."],
        ["`salidium restart`", "Restart it and reopen the page."],
        ["`salidium stop`", "Stop the local daemon."],
        ["`salidium install-hooks`", "Connect an agent, or reconnect one."],
        ["`salidium uninstall-hooks`", "Disconnect it again."],
        ["`salidium reingest`", "Re-read session files from disk. One session, or `--all`."],
        ["`salidium retention`", "Show or set how long sessions are kept."],
        ["`salidium forget`", "Delete one session for good. Requires `--yes`."],
      ]),
      note(
        "`reingest`, `retention`, `pin`, `unpin` and `forget` will not write while Salidium is running. Stop it first; offline maintenance does not rewrite a store under a running daemon.",
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
        ["`SALIDIUM_EXPLAINER`", "`auto`, `claude`, `codex` or `off`. Outranks the setting in the page."],
        ["`SALIDIUM_EXPLAIN_MODEL`", "A model id for the explainer, instead of its default."],
        ["`SALIDIUM_NO_GIT`", "Set to `1` to stop the git snapshots."],
        ["`SALIDIUM_LOG`", "`silent`, `info` or `debug`. Defaults to `info`."],
        ["`CLAUDE_CONFIG_DIR`", "Where Claude Code keeps its settings. Defaults to `~/.claude`."],
        ["`CODEX_HOME`", "Where Codex keeps its state. Defaults to `~/.codex`."],
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
          "It is not read again, however much the adapter improves, because its cursor still matches. `salidium reingest --all` then `salidium restart` is what recovers it.",
        ],
        [
          "Retention",
          "Sessions are kept forever unless you set a policy. Working, waiting and pinned sessions are never removed by one.",
        ],
        [
          "Ingest problems",
          "An unreadable transcript record is counted in Quantities under data handling. A dropped hook payload is not: it reaches the daemon log and nothing else.",
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
 * The same tree, as Markdown. Served at `/docs.md` and `/docs/<slug>.md`, advertised by every page
 * with a `rel="alternate"` link, and copied by the control in the head, because anything asked to
 * read these docs should be handed the text rather than made to strip tags out of a rendered page.
 */
export function docsMarkdown(origin = "https://salidium.com", slug?: string): string {
  const pages = slug ? PAGES.filter((page) => page.slug === slug) : PAGES;
  const out: string[] = [];

  if (!slug) out.push(`# ${OVERVIEW.title}`, "", OVERVIEW.lede, "", `Source: ${origin}/docs`, "");

  for (const page of pages) {
    out.push(
      `## ${page.n}. ${page.title}`,
      "",
      page.summary,
      "",
      `Source: ${origin}/docs/${page.slug}`,
      "",
    );
    for (const block of page.blocks) {
      if (block.kind === "p") out.push(block.text, "");
      else if (block.kind === "h") out.push(`### ${block.text}`, "");
      else if (block.kind === "note") out.push(`> ${block.text}`, "");
      else if (block.kind === "list") out.push(...block.items.map((i) => `- ${i}`), "");
      else if (block.kind === "command") out.push("```sh", block.command, "```", "");
      else if (block.kind === "shot") {
        const file = (SHOTS as Record<string, Shot>)[block.name]?.light;
        if (file) out.push(`![${block.alt}](${origin}/docs/${file})`, "");
      }
      else if (block.kind === "terms")
        out.push(...block.items.map(([name, meaning]) => `- **${name}** ${meaning}`), "");
      else if (block.kind === "keys")
        out.push(
          ...block.items.map(([ks, meaning]) => `- **${ks.map((k) => `\`${k}\``).join(" ")}** ${meaning}`),
          "",
        );
    }
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
