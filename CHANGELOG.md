# Changelog

## Unreleased

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
