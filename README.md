# Salidium

Salidium translates coding-agent work into a trustworthy, structured explanation a human can read in seconds:

- **What** the agent is doing and what changed
- **Why** (the user's ask and the agent's stated discoveries — always attributed)
- **How** (plan and approach)
- **Verified** — what evidence actually shows (test/build/typecheck/lint runs parsed from real output)
- **Left** — what remains
- **Review** — what needs a human (waiting for permission, failing checks, unverified changes, destructive commands, claims without evidence)

The daemon, event store, deterministic report, and interface run entirely on your machine with no Salidium telemetry or hosted service. Salidium observes the agent you already run through supported integration points (hooks and the agent's own session logs), derives facts deterministically, and relays the agent's claims verbatim and labelled. Every observed statement links back to the raw record it came from.

The optional visual explanation uses your selected installed Claude Code or Codex CLI. Once per completed turn, Salidium sends that agent a bounded, redacted summary of the ask, statements, file names, and check outcomes; the CLI may contact its provider and consume your existing plan or API allowance. The invocation is tool-free, treats the session evidence as untrusted data, and accepts only a bounded, runtime-validated result. Older Codex versions that do not support the tool-disable flags fail closed and simply omit the generated block. Set `SALIDIUM_EXPLAINER=off` (or the legacy `SALIDIUM_EXPLAIN=0`) to send nothing to an agent. The deterministic report still works when explanation is off, unavailable, or fails.

It is also allowed to say nothing. A claim the classifier cannot place is recorded and reachable through `record`, and filed under no heading — Salidium may say less than it knows, and may not say something it does not know.

The session page is laid out as a written document rather than a dashboard: the product mark, the session title, the facts that identify the run, and the **badges** — did it work, what needs a human, what is unfinished — then a rule, then the **explanation**: one sentence saying what the session is about, followed by the diagrams that carry the meaning. Supporting facts stay behind their toolbar controls so the explanation remains the canvas.

Detail is opened by section rather than by one global depth control. **Evidence** opens coverage, checks, changes, and the event record; **Rewind** reconstructs the session at a chosen moment; and **Quantities** and **History** share one supporting inspector beside the page, replacing one another without squeezing the explanation into a third column.

The session list groups by the question it answers — **Needs you**, **Working**, **Recent** — because you are usually running more than one agent at a time. It folds away with `[`, and the sessions that started and ended without running a turn are collapsed behind one line. Light, dark and system themes are all first-class and the choice is remembered.

Providers today: **Claude Code** (hooks + transcript, primary) and **Codex** (rollout files + hooks).

## Run it

Requirements: Node ≥ 24, because the daemon uses the built-in `node:sqlite`.

```bash
npx salidium
```

On first run, Salidium detects Claude Code and Codex from their local commands or state directories. If a detected agent still needs configuration, Salidium shows the settings files it wants to update and asks one combined permission question. Approved connections are merged with existing hooks and settings, checked, then Salidium starts and opens the interface. If Salidium adds or changes Codex hooks, Codex requires one additional review in `/hooks` before those hooks run.

Later, the same command starts or finds the daemon and opens Salidium without repeating completed setup. In a non-interactive terminal, Salidium never waits for input and does not change provider settings unless `--yes` is passed. Use `--no-open` when a browser should not open.

`salidium` is a single self-contained script with no runtime dependencies: its public workspace
packages are not published separately and are bundled into it, so running it adds nothing to your
tree but Salidium itself.

```bash
salidium install-hooks  # connect detected agents manually
salidium uninstall-hooks
salidium doctor         # check or troubleshoot the local setup
salidium show           # print the same report as text (--detail=summary|detail|source)
salidium audit-claims   # measure the claim classifier against every session in your own store
salidium reingest --all # re-read your session files after an upgrade taught the adapters something new
salidium retention      # preview/set forever, 30, 90, or 365 day local history retention
salidium retention compact # offline integrity-check and return reusable database pages to the OS
salidium pin [session]  # exempt a session from automatic retention
salidium forget <id>    # remove a session while preventing source-file resurrection
salidium status         # daemon and hook state
salidium restart        # stop it, start it again, and open the UI on the new token
salidium stop
```

`install-hooks`, `uninstall-hooks`, and `doctor` remain available for manual setup and recovery. Installation and removal touch only Salidium-owned hook entries; unrelated provider settings and hooks are preserved.

Existing transcripts from the last 7 days are imported on first start (`SALIDIUM_HISTORY_DAYS`, a whole number 0 or greater); new sessions appear within a second of their first hook. State lives in `~/.salidium` (0700): `salidium.db`, `daemon.json` (port + token, 0600), the hook relay script, and a spool for hooks that fired while the daemon was down.

## Development

```bash
pnpm install
pnpm build        # typecheck + build every package and the UI
pnpm salidium     # run the CLI from source (Node type stripping)
pnpm typecheck    # tsc --build (project references)
pnpm lint         # biome check
pnpm format       # biome format --write
pnpm test         # vitest: unit, adapter fixtures, daemon integration, performance
pnpm test:e2e     # real-daemon Chromium + automated accessibility checks
pnpm test:e2e:full # Chromium, Firefox, and WebKit portability matrix
pnpm package      # build the publishable bundle into packages/cli/bundle
pnpm --filter @salidium/ui dev   # Vite dev server for the UI, proxied to the running daemon (open it with #token=… from ~/.salidium/daemon.json)
```

CI runs lint, build and the full test suite on Ubuntu with Node 24, plus focused native macOS and
Windows checks. It then packs the tarball, unpacks it somewhere with no workspace above it and
starts the daemon from it — because the published bundle and the checkout resolve paths
differently, and only the second arrangement is what a user gets.

Release preparation, the manual-only publish workflow, and rollback steps are documented in
[`docs/releasing.md`](docs/releasing.md).

### Measuring the claims layer

`salidium audit-claims` replays every agent message in your store through the classifier and reports what it did with them: the distribution by kind and by rule, how many messages produced nothing at all, and a seeded random sample of each rule's output to read. Classifier behavior can vary with providers and writing styles, so the honest way to know whether its conservative rules hold for your sessions is to measure your own local corpus.

```bash
salidium audit-claims                          # counts, plus 8 sampled claims per rule
salidium audit-claims --only=discovery --sample=20
salidium audit-claims --json                   # for a script
```

`pnpm salidium …` runs the CLI from source with Node's type stripping (`--conditions=development`); `pnpm build` emits `dist/` for every package.

## Architecture (short)

```
agent runtime ──hooks (async sh relay)──▶ ┐
              ──session log (tailed)────▶ ├─▶ provider adapter → canonical events → dedupe → redact → reducer → semantic state + change log
                                          ┘                                                     │
                                                                  SQLite (events, changes, checkpoints) ◀─┘─▶ SSE → UI (same reducer)
```

- `packages/protocol` — zod schemas shared by everything: canonical events, semantic changes, wire protocol, provenance vocabulary.
- `packages/core` — pure derivation: `applyEvent(state, event) → SemanticChange[]`, session projections, verification parsing, review rules, redaction, replay.
- `packages/adapter-kit`, `packages/adapters/*` — provider parsers (transcript/rollout lines + hook payloads → events with deterministic ids).
- `packages/daemon` — tailing, hook ingress, persistence, git snapshots, loopback HTTP/SSE server.
- `packages/ui` — React client that folds the event stream with the same reducer.
- `packages/cli` — `salidium` command.

See [docs/architecture.md](docs/architecture.md) for the decisions and boundaries.

## Status

MVP. The integration and replay paths are exercised against synthetic fixtures and local provider
sessions for Claude Code and Codex. The claim classifier is deliberately conservative, but its
behavior may vary across providers and writing styles; `audit-claims` is how to evaluate it on your
own store. Native Windows history import is supported, but live hooks still require POSIX `sh` and
`curl`. See the architecture document for the complete limitations.
