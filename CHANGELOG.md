# Changelog

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
