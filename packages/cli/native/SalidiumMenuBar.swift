import AppKit
import Foundation

private struct Configuration {
    let home: String
    let node: String
    let cli: String

    static func parse(_ arguments: [String]) -> Configuration? {
        var values: [String: String] = [:]
        var index = 1
        while index + 1 < arguments.count {
            let key = arguments[index]
            if key.hasPrefix("--") {
                values[key] = arguments[index + 1]
                index += 2
            } else {
                index += 1
            }
        }
        guard let home = values["--home"],
              let node = values["--node"],
              let cli = values["--cli"] else { return nil }
        return Configuration(home: home, node: node, cli: cli)
    }
}

private enum Health: String {
    case healthy
    case attention
    case critical
    case offline
}

/*
 * The one sentence the menu exists to say, and the single action that answers it.
 *
 * The daemon already writes this text. `alerts.ts` gives every condition a title and a detail
 * composed for a person ("Salidium is falling behind", "Nothing is lost while it waits"), and the
 * native notification sink delivers them verbatim. This menu used to read the same payload, keep
 * `alerts.active.count`, and render a number, so the product spoke plainly when it pushed and in
 * gauges when you pulled. These fields carry the sentences through instead.
 */
private struct Situation {
    var headline: String
    var detail: String?
    var tone: Health
    /// Whether Salidium has something to account for, as opposed to a state the user chose.
    var explain: Bool = false
}

private struct Provider {
    var name: String
    var detected: Bool
    var configuration: String
    var trust: String

    /*
     * The same set the daemon counts as a hook problem in `health.ts`, and for the same reasons.
     *
     * `not-configured` is deliberately absent even though it means no hooks: the interface offers
     * Disconnect, so a detected provider without them is usually a choice, and a menu that reports
     * a choice back as a fault is arguing with the reader. `detected` gates the whole thing,
     * because a provider that is not installed is not a problem to have; without that check a
     * machine with only one agent would have carried a permanent complaint about the other.
     */
    var problem: String? {
        guard detected else { return nil }
        if configuration == "invalid" { return "needs repair" }
        if trust == "untrusted" { return "needs approval" }
        if trust == "modified" { return "changed since approval" }
        return nil
    }
}

private struct Alert {
    var title: String
    var detail: String
    var severity: String
}

private struct Snapshot {
    var health: Health = .offline
    var pid: Int?
    var collectionPaused = false
    var collectionKnown = false
    var pauseExpiresAt: String?
    var queueFiles: Int?
    var queueBytes: Int?
    var storeBytes: Int?
    var warnAtBytes: Int?
    var storageBytesPerMinute: Double?
    var retention = "Unavailable"
    var alerts: [Alert] = []
    var providers: [Provider] = []
    /// Only set while a phase is actually running. A finished operation is a record, not a status.
    var maintenance: String?

    static let offline = Snapshot()
}

/*
 * The storage row, drawn rather than written.
 *
 * A number on its own ("On this Mac · 3.02 GB · kept forever") is a true fact nobody can act on:
 * it has no direction and no edge, so a store that quietly doubles reads the same as one that has
 * not moved. The bar gives it an edge and the subtitle gives it direction. The reference is the
 * configured warning size and it is labelled as one, because it is a threshold Salidium chose and
 * not a capacity the disk imposes; calling it a capacity would be a more comfortable shape and a
 * false one.
 */
private final class StorageView: NSView {
    private let heading = NSTextField(labelWithString: "")
    private let value = NSTextField(labelWithString: "")
    private let subtitle = NSTextField(labelWithString: "")
    private var fraction: Double = 0
    private var tone: NSColor = .systemGreen
    private var known = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        heading.font = .menuFont(ofSize: NSFont.systemFontSize)
        heading.textColor = .labelColor
        value.font = .monospacedDigitSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        value.textColor = .secondaryLabelColor
        value.alignment = .right
        subtitle.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        subtitle.textColor = .tertiaryLabelColor
        for label in [heading, value, subtitle] {
            label.translatesAutoresizingMaskIntoConstraints = false
            addSubview(label)
        }
        NSLayoutConstraint.activate([
            heading.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 21),
            heading.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            value.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            value.firstBaselineAnchor.constraint(equalTo: heading.firstBaselineAnchor),
            value.leadingAnchor.constraint(greaterThanOrEqualTo: heading.trailingAnchor, constant: 8),
            subtitle.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 21),
            subtitle.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -14),
            subtitle.topAnchor.constraint(equalTo: heading.bottomAnchor, constant: 11),
        ])
    }

    required init?(coder: NSCoder) { return nil }

    override var intrinsicContentSize: NSSize { NSSize(width: 300, height: 50) }

    /// Takes finished strings: byte rendering lives beside the formatter it is pinned against.
    func apply(value valueText: String, subtitle subtitleText: String, fraction filled: Double?) {
        heading.stringValue = "On this Mac"
        value.stringValue = valueText
        subtitle.stringValue = subtitleText
        known = filled != nil
        fraction = filled ?? 0
        /*
         * Amber before the mark rather than at it. An indicator that only changes once the alert
         * has already fired tells you a thing you have just been told; the point of drawing this
         * is the part of the curve where there is still a choice.
         */
        tone = fraction >= 1 ? .systemRed : fraction >= 0.75 ? .systemOrange : .systemGreen
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let track = NSRect(x: 21, y: 20, width: bounds.width - 35, height: 4)
        let radius: CGFloat = 2
        NSColor.quaternaryLabelColor.setFill()
        NSBezierPath(roundedRect: track, xRadius: radius, yRadius: radius).fill()
        guard known, fraction > 0 else { return }
        var filled = track
        filled.size.width = max(track.width * CGFloat(fraction), radius * 2)
        tone.setFill()
        NSBezierPath(roundedRect: filled, xRadius: radius, yRadius: radius).fill()
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let configuration: Configuration
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var snapshot = Snapshot.offline
    private var refreshInProgress = false
    private var timer: Timer?
    /*
     * What a command the reader started is doing, and the pulse that says it is still doing it.
     *
     * Choosing a menu item closes the menu, so every action was silent: "Store 412 Waiting Files
     * Now" runs the CLI for up to thirty seconds with nothing on screen to say so, and the only
     * evidence was the number eventually changing. The label answers what, on the next open. The
     * pulse answers whether it is still going, without one.
     */
    private var runningAction: String?
    private var pulseTimer: Timer?
    private var pulsePhase = 0

    init(configuration: Configuration) {
        self.configuration = configuration
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        menu.delegate = self
        statusItem.menu = menu
        rebuildMenu()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        pulseTimer?.invalidate()
    }

    func menuWillOpen(_ menu: NSMenu) {
        refresh()
    }

    private func refresh() {
        guard !refreshInProgress else { return }
        refreshInProgress = true
        let configuration = self.configuration
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let next = Self.readSnapshot(configuration: configuration)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.snapshot = next
                self.refreshInProgress = false
                self.rebuildMenu()
            }
        }
    }

    private static func readSnapshot(configuration: Configuration) -> Snapshot {
        let daemonPath = URL(fileURLWithPath: configuration.home)
            .appendingPathComponent("daemon.json")
        guard let daemonData = try? Data(contentsOf: daemonPath),
              let daemon = try? JSONSerialization.jsonObject(with: daemonData) as? [String: Any],
              let port = integer(daemon["port"]),
              let token = daemon["token"] as? String,
              let recordedPID = integer(daemon["pid"]),
              (1...65535).contains(port) else { return .offline }

        guard let url = URL(string: "http://127.0.0.1:\(port)/api/operations") else {
            return .offline
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let semaphore = DispatchSemaphore(value: 0)
        var responseData: Data?
        var responseStatus: Int?
        let task = URLSession.shared.dataTask(with: request) { data, response, _ in
            responseData = data
            responseStatus = (response as? HTTPURLResponse)?.statusCode
            semaphore.signal()
        }
        task.resume()
        guard semaphore.wait(timeout: .now() + 2.5) == .success,
              responseStatus == 200,
              let data = responseData,
              let overview = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let health = overview["health"] as? [String: Any],
              let daemonHealth = health["daemon"] as? [String: Any],
              integer(daemonHealth["pid"]) == recordedPID else {
            task.cancel()
            return .offline
        }

        var snapshot = Snapshot()
        snapshot.health = Health(rawValue: health["overall"] as? String ?? "") ?? .attention
        snapshot.pid = integer(daemonHealth["pid"])
        if let collection = health["collection"] as? [String: Any],
           let state = collection["state"] as? String {
            snapshot.collectionKnown = true
            snapshot.collectionPaused = state != "active"
            snapshot.pauseExpiresAt = collection["pauseExpiresAt"] as? String
        }
        if let queue = health["queue"] as? [String: Any] {
            snapshot.queueFiles = integer(queue["files"])
            snapshot.queueBytes = integer(queue["bytes"])
        }
        if let store = health["store"] as? [String: Any] {
            snapshot.storeBytes = integer(store["totalBytes"])
            if let value = store["retention"] {
                snapshot.retention = retentionLabel(value)
            }
        }
        /*
         * The warning size is policy rather than measurement, so it comes from the config half of
         * the payload. Without it the bar has no edge to draw and the row falls back to a number.
         */
        if let config = overview["config"] as? [String: Any],
           let values = config["values"] as? [String: Any],
           let alerts = values["alerts"] as? [String: Any],
           let databaseSize = alerts["databaseSizeBytes"] as? [String: Any] {
            snapshot.warnAtBytes = integer(databaseSize["value"])
        }
        if let estimates = health["estimates"] as? [String: Any],
           let growth = estimates["storageGrowth"] as? [String: Any],
           let value = growth["value"] as? NSNumber {
            snapshot.storageBytesPerMinute = value.doubleValue
        }
        if let alerts = overview["alerts"] as? [String: Any],
           let active = alerts["active"] as? [[String: Any]] {
            snapshot.alerts = active.compactMap { entry in
                guard let title = entry["title"] as? String else { return nil }
                return Alert(title: title,
                             detail: entry["detail"] as? String ?? "",
                             severity: entry["severity"] as? String ?? "warning")
            }
        }
        if let hooks = health["hooks"] as? [[String: Any]] {
            snapshot.providers = hooks.compactMap { entry in
                guard let name = entry["name"] as? String else { return nil }
                return Provider(name: name,
                                detected: entry["detected"] as? Bool ?? false,
                                configuration: entry["configuration"] as? String ?? "unknown",
                                trust: entry["trust"] as? String ?? "not-applicable")
            }
        }
        /*
         * `maintenance.json` is written on every phase and deliberately never deleted, because it
         * is the only durable evidence of an interrupted one. That makes it a record, and reading
         * a record as a status left a finished operation pinned in this menu for days. Only a
         * phase still in flight is news.
         */
        if let maintenance = health["maintenance"] as? [String: Any],
           let phase = maintenance["phase"] as? String,
           !["completed", "idle"].contains(phase) {
            let message = maintenance["message"] as? String
            snapshot.maintenance = message?.isEmpty == false
                ? "\(titleCase(phase)) · \(shortLabel(message!))"
                : titleCase(phase)
        }
        return snapshot
    }

    private static func integer(_ value: Any?) -> Int? {
        if value is NSNull { return nil }
        return (value as? NSNumber)?.intValue
    }

    private static func retentionLabel(_ value: Any) -> String {
        if let text = value as? String { return text == "forever" ? "kept forever" : text }
        if let days = integer(value) { return "kept \(days) days" }
        return "retention unavailable"
    }

    private static func titleCase(_ value: String) -> String {
        value.replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    /*
     * Cut at a word, never through one. Cutting on a character count alone produced
     * "…100 more files are w…" in the menu, which reads as a rendering fault rather than an
     * abbreviation. The full text is one click away in the interface either way.
     */
    private static func shortLabel(_ value: String) -> String {
        let limit = 88
        guard value.count > limit else { return value }
        let clipped = value.prefix(limit - 1)
        guard let lastSpace = clipped.lastIndex(of: " ") else {
            return String(clipped) + "…"
        }
        return clipped[..<lastSpace].trimmingCharacters(in: .punctuationCharacters) + "…"
    }

    /*
     * The first sentence of an alert detail, because the daemon writes these as a claim followed
     * by its consequence and the claim is what a menu has room for.
     */
    private static func leadSentence(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let stop = trimmed.firstIndex(of: ".") else { return shortLabel(trimmed) }
        return shortLabel(String(trimmed[...stop]))
    }

    /// Renders an ISO instant the way a person would say it, for the one place a time is shown.
    private static func whenLabel(_ iso: String) -> String? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? {
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            return plain.date(from: iso)
        }()
        guard let date = date else { return nil }
        let formatter = DateFormatter()
        formatter.doesRelativeDateFormatting = true
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    /*
     * Which single fact the menu leads with.
     *
     * Ordered by what stops the product working, not by internal severity. A provider that is not
     * connected outranks a queue that is behind, because a backlog still ends up recorded and an
     * unconfigured hook never arrives at all. Recording is last: when everything is fine there is
     * exactly one line and nothing to read.
     */
    /*
     * What the reader just asked for outranks what was true before they asked, and it is the only
     * line about to change on its own, so while a command runs it is the line worth having.
     *
     * Only the words though. The icon keeps its resting shape, because "working" is a passing
     * condition and the badge vocabulary is for standing ones: sprouting a warning dot for the
     * duration of a drain the reader asked for would be reporting their own click back to them as
     * a problem. The pulse carries it instead, which is why the two are separated here.
     */
    private func situation() -> Situation {
        if let action = runningAction {
            return Situation(headline: "\(action)…", detail: nil, tone: restingSituation().tone)
        }
        return restingSituation()
    }

    private func restingSituation() -> Situation {
        /*
         * The second line has to earn itself. "Not running" already says nothing is being stored,
         * so restating that as "agent work is not being recorded" spent a row saying the same
         * thing twice, and it was not even true: the relay stays installed, so a hook that fires
         * while the daemon is down publishes a spool file instead of posting, and the next start
         * drains it. What a reader wants to know here is whether they have lost anything.
         */
        if snapshot.pid == nil {
            return Situation(headline: "Not running",
                             detail: "New work waits to be stored until you start it.",
                             tone: .offline)
        }
        if let critical = snapshot.alerts.first(where: { $0.severity == "critical" }) {
            return Situation(headline: critical.title, detail: Self.leadSentence(critical.detail),
                             tone: .critical, explain: true)
        }
        /*
         * Named by what is actually wrong, in the words the interface already uses for the same
         * states: a provider whose hooks are malformed is not "not connected", and one whose hooks
         * changed since Codex approved them is connected and refusing to run. "Incomplete" rather
         * than "not recorded" because transcript tailing carries on either way, so the sessions
         * still arrive; what they lose is the hook-only signal, which is what a gap means here.
         */
        let broken = snapshot.providers.compactMap { provider in
            provider.problem.map { (name: provider.name, reason: $0) }
        }
        if let first = broken.first {
            return Situation(
                headline: broken.count == 1
                    ? "\(first.name) \(first.reason)"
                    : "\(broken.count) providers need attention",
                detail: "Reports for \(broken.count == 1 ? "it" : "them") will be incomplete.",
                tone: .critical,
                explain: true)
        }
        /*
         * A pause the user asked for is not something to explain back to them, so it keeps the
         * plain action label even though it is not the healthy state.
         */
        if snapshot.collectionPaused {
            let when = snapshot.pauseExpiresAt.flatMap(Self.whenLabel)
            return Situation(headline: "Paused",
                             detail: when.map { "Recording resumes \($0)." }
                                 ?? "Recording stays off until you resume it.",
                             tone: .attention)
        }
        if let alert = snapshot.alerts.first {
            return Situation(headline: alert.title, detail: Self.leadSentence(alert.detail),
                             tone: .attention, explain: true)
        }
        if !snapshot.collectionKnown {
            return Situation(headline: "Collection state unavailable", detail: nil,
                             tone: .attention, explain: true)
        }
        return Situation(headline: "Recording your agent work", detail: nil, tone: .healthy)
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        let situation = situation()
        configureStatusIcon(situation: situation)

        // No em dash in anything the product says. `printedVoice.test.ts` reads this file for them.
        /*
         * No name row. This menu opens from the Salidium mark and from nothing else, so a line
         * saying "Salidium" spent the most prominent row in it on a fact the reader established by
         * clicking. Time Machine and Dropbox both open straight into their status for the same
         * reason. The status sentence takes the emphasis it was using.
         */
        addLabel(situation.headline, emphasized: true)
        if let detail = situation.detail { addLabel(detail, secondary: true) }
        if runningAction == nil, let maintenance = snapshot.maintenance {
            addLabel("Maintenance · \(maintenance)")
        }

        menu.addItem(.separator())
        if snapshot.pid == nil {
            /*
             * `salidium open` starts the daemon on its way to the browser, so offering both was
             * offering the same outcome twice. Starting is the whole of what this state needs.
             */
            addAction("Start Salidium", #selector(startSalidium), key: "o")
        } else {
            addAction(situation.explain ? "See What Happened" : "Open Salidium",
                      #selector(openSalidium), key: "o")
            if snapshot.collectionPaused {
                addAction("Resume Recording", #selector(resumeCollection))
            } else {
                addAction("Pause Recording", #selector(pauseCollection))
            }
            /*
             * Draining is part of collection: `drainSpool` returns immediately while paused, and
             * an empty queue is the steady state rather than a stage work passes through. The
             * action appears only when there is something for it to do.
             */
            if runningAction == nil, !snapshot.collectionPaused,
               let files = snapshot.queueFiles, files > 0 {
                addAction("Store \(files) Waiting \(files == 1 ? "File" : "Files") Now",
                          #selector(drainQueue))
            }
        }

        /*
         * Nothing was measured while the daemon is down, and a row that says "Unavailable" twice
         * is worse than no row: it spends space to report the absence the line above already gave.
         */
        if snapshot.pid != nil {
            menu.addItem(.separator())
            addStorage()
            menu.addItem(.separator())
            addAction("Local Operations…", #selector(openSalidium))
            addAction("Stop Salidium", #selector(stopSalidium))
        }

        /*
         * Its own group because it is a different kind of off. Stopping is undone by the item
         * directly above it; this one removes the menu and needs a terminal to come back.
         */
        menu.addItem(.separator())
        addAction("Turn Off Always-On Mode…", #selector(turnOffAlwaysOn))
    }

    private func addStorage() {
        let mark = snapshot.warnAtBytes ?? 0
        var value = "Unavailable"
        var fraction: Double?
        var parts: [String] = [snapshot.retention]
        if let total = snapshot.storeBytes {
            value = mark > 0
                ? "\(Self.byteLabel(total)) of \(Self.byteLabel(mark))"
                : Self.byteLabel(total)
            if mark > 0 {
                fraction = min(Double(total) / Double(mark), 1)
                parts.append("warns at \(Self.byteLabel(mark))")
            }
        }
        /*
         * "At this rate" is the honest form. The rate is sampled over an hour, and an hour of
         * heavy agent use does not continue overnight, so the projection is a shape and not a date.
         */
        if let rate = snapshot.storageBytesPerMinute, rate > 0 {
            parts.append("about \(Self.byteLabel(Int(rate * 60 * 24))) a day at this rate")
        }
        let subtitle = parts.joined(separator: " · ")

        let view = StorageView(frame: NSRect(x: 0, y: 0, width: 300, height: 50))
        view.apply(value: value, subtitle: subtitle, fraction: fraction)
        view.setAccessibilityLabel("On this Mac, \(value). \(subtitle).")
        let item = NSMenuItem()
        item.view = view
        item.isEnabled = false
        menu.addItem(item)
    }

    /*
     * The mark, drawn as a template image so the system owns its appearance.
     *
     * This was `checkmark.circle.fill` with `isTemplate = false` and an explicit tint, which is
     * two problems at once. A green checkmark is the most generic glyph in the menu bar and says
     * nothing about which app it belongs to, and turning off template mode opts the glyph out of
     * the light, dark and selected rendering the system would otherwise do for it. The HIG asks
     * for black and clear shapes for exactly that reason.
     *
     * Status rides along as a badge, and every state differs in shape as well as colour: a bare
     * mark, a pause glyph, a dot, a dimmed mark. Colour confirms the state and never carries it
     * alone. The geometry is the canonical mark from `assets/brand/salidium-mark.svg` on its
     * 64 x 44 viewBox; the packaged helper is a single compiled file with no bundle to hold an
     * asset, so the paths live here.
     */
    private static func markPath() -> NSBezierPath {
        let path = NSBezierPath()
        path.move(to: NSPoint(x: 12, y: 1.1))
        path.curve(to: NSPoint(x: 26.1, y: 2.6),
                   controlPoint1: NSPoint(x: 17.2, y: -0.2), controlPoint2: NSPoint(x: 21.6, y: 0.1))
        path.line(to: NSPoint(x: 35.2, y: 7.6))
        path.curve(to: NSPoint(x: 38.2, y: 19.5),
                   controlPoint1: NSPoint(x: 40.6, y: 10.6), controlPoint2: NSPoint(x: 41.8, y: 15.4))
        path.line(to: NSPoint(x: 35.5, y: 22.4))
        path.curve(to: NSPoint(x: 36.3, y: 27.6),
                   controlPoint1: NSPoint(x: 34.1, y: 23.9), controlPoint2: NSPoint(x: 34.5, y: 26.3))
        path.line(to: NSPoint(x: 39.8, y: 30.4))
        path.curve(to: NSPoint(x: 41.1, y: 40.2),
                   controlPoint1: NSPoint(x: 43.0, y: 32.9), controlPoint2: NSPoint(x: 43.7, y: 37.1))
        path.curve(to: NSPoint(x: 34.8, y: 42.9),
                   controlPoint1: NSPoint(x: 39.6, y: 42.0), controlPoint2: NSPoint(x: 37.5, y: 42.9))
        path.line(to: NSPoint(x: 14.1, y: 42.9))
        path.curve(to: NSPoint(x: 5.1, y: 36.9),
                   controlPoint1: NSPoint(x: 9.8, y: 42.9), controlPoint2: NSPoint(x: 6.8, y: 40.8))
        path.line(to: NSPoint(x: 0.9, y: 27.1))
        path.curve(to: NSPoint(x: 1.0, y: 18.6),
                   controlPoint1: NSPoint(x: -0.3, y: 24.4), controlPoint2: NSPoint(x: 0.0, y: 21.3))
        path.line(to: NSPoint(x: 5.3, y: 7.3))
        path.curve(to: NSPoint(x: 12, y: 1.1),
                   controlPoint1: NSPoint(x: 6.5, y: 4.2), controlPoint2: NSPoint(x: 8.8, y: 2.0))
        path.close()

        path.move(to: NSPoint(x: 46.3, y: 14.1))
        path.curve(to: NSPoint(x: 52.5, y: 13.7),
                   controlPoint1: NSPoint(x: 48.1, y: 12.7), controlPoint2: NSPoint(x: 50.5, y: 12.5))
        path.line(to: NSPoint(x: 58.1, y: 17.0))
        path.curve(to: NSPoint(x: 63.4, y: 25.4),
                   controlPoint1: NSPoint(x: 61.2, y: 18.8), controlPoint2: NSPoint(x: 62.9, y: 21.7))
        path.line(to: NSPoint(x: 64.0, y: 34.8))
        path.curve(to: NSPoint(x: 57.5, y: 42.9),
                   controlPoint1: NSPoint(x: 64.3, y: 39.4), controlPoint2: NSPoint(x: 61.9, y: 42.9))
        path.line(to: NSPoint(x: 50.4, y: 42.9))
        path.curve(to: NSPoint(x: 44.2, y: 35.9),
                   controlPoint1: NSPoint(x: 46.3, y: 42.9), controlPoint2: NSPoint(x: 43.8, y: 39.8))
        path.curve(to: NSPoint(x: 40.8, y: 28.2),
                   controlPoint1: NSPoint(x: 44.6, y: 32.7), controlPoint2: NSPoint(x: 43.4, y: 30.1))
        path.curve(to: NSPoint(x: 39.5, y: 20.1),
                   controlPoint1: NSPoint(x: 38.1, y: 26.2), controlPoint2: NSPoint(x: 37.7, y: 22.7))
        path.close()
        return path
    }

    /*
     * The five states differ in shape, not colour, and that is forced rather than chosen: the
     * system paints a template image in one colour of its own choosing, so an amber badge and a
     * red one would arrive identical. It is also what the HIG asks for anyway, since colour alone
     * is not allowed to carry meaning. Shape does the work and the menu carries the words.
     */
    private enum IconState {
        case recording
        case paused
        /// Recording, but Salidium has something to report.
        case attention
        /// Reachable and not recording, which a slash says the way a dot cannot.
        case notRecording
        case notRunning
    }

    private static func statusImage(for state: IconState) -> NSImage {
        let markHeight: CGFloat = 15
        let scale = markHeight / 44
        let markWidth = 64 * scale
        let badge: CGFloat = (state == .paused || state == .attention) ? 7 : 0
        let size = NSSize(width: markWidth + badge * 0.45, height: markHeight + badge * 0.3)

        let mark = NSImage(size: size, flipped: true) { _ in
            let transform = NSAffineTransform()
            transform.scaleX(by: scale, yBy: scale)
            transform.concat()
            NSColor.black.withAlphaComponent(state == .notRunning ? 0.4 : 1).setFill()
            markPath().fill()
            return true
        }

        if state == .recording || state == .notRunning {
            mark.isTemplate = true
            return mark
        }

        /*
         * Badges and the slash are punched out of the glyph before they are drawn, so the shape
         * stays legible over a busy menu bar instead of merging into the mark behind it.
         * Everything stays black and clear, which is what lets the whole image be a template.
         */
        let drawn = NSImage(size: size, flipped: false) { rect in
            mark.draw(in: NSRect(x: 0, y: rect.height - markHeight,
                                 width: markWidth, height: markHeight))
            NSColor.black.setFill()
            NSColor.black.setStroke()

            if state == .notRecording {
                let slash = NSBezierPath()
                slash.move(to: NSPoint(x: 1.5, y: 1.5))
                slash.line(to: NSPoint(x: markWidth - 1.5, y: rect.height - 1.5))
                slash.lineCapStyle = .round
                NSGraphicsContext.current?.compositingOperation = .clear
                slash.lineWidth = 4.4
                slash.stroke()
                NSGraphicsContext.current?.compositingOperation = .sourceOver
                slash.lineWidth = 2.0
                slash.stroke()
                return true
            }

            let centre = NSPoint(x: rect.width - badge / 2, y: rect.height - badge / 2)
            NSGraphicsContext.current?.compositingOperation = .clear
            NSBezierPath(ovalIn: NSRect(x: centre.x - badge / 2 - 1.4, y: centre.y - badge / 2 - 1.4,
                                        width: badge + 2.8, height: badge + 2.8)).fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            if state == .paused {
                // Two bars read as paused at any size, where a second dot would read as noise.
                let barWidth = badge * 0.26
                let barHeight = badge * 0.82
                NSRect(x: centre.x - badge * 0.36, y: centre.y - barHeight / 2,
                       width: barWidth, height: barHeight).fill()
                NSRect(x: centre.x + badge * 0.1, y: centre.y - barHeight / 2,
                       width: barWidth, height: barHeight).fill()
            } else {
                NSBezierPath(ovalIn: NSRect(x: centre.x - badge / 2, y: centre.y - badge / 2,
                                            width: badge, height: badge)).fill()
            }
            return true
        }
        drawn.isTemplate = true
        return drawn
    }

    /*
     * A slow fade of the mark itself while a command runs, and nothing else.
     *
     * Not a spinner: a spinner in the menu bar is a second glyph competing with the one that says
     * which app this is, and it would be on screen for a thirty second drain. Fading the mark that
     * is already there says "working" using the space it already occupies, and it is the same
     * device Time Machine uses for the same reason.
     *
     * Reduce Motion turns it off rather than substituting something: the label on the next open is
     * the substance and it is still there. Motion is the convenience, so it is the part that goes.
     */
    private func startPulse() {
        guard pulseTimer == nil,
              !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        pulsePhase = 0
        pulseTimer = Timer.scheduledTimer(withTimeInterval: 0.28, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.pulsePhase = (self.pulsePhase + 1) % 4
            self.applyIconAlpha()
        }
    }

    private func stopPulse() {
        pulseTimer?.invalidate()
        pulseTimer = nil
        pulsePhase = 0
        applyIconAlpha()
    }

    private func applyIconAlpha() {
        // A triangle wave, so the fade reads as breathing rather than as a blink.
        let steps: [CGFloat] = [1.0, 0.72, 0.45, 0.72]
        statusItem.button?.alphaValue = pulseTimer == nil ? 1.0 : steps[pulsePhase]
    }

    private func configureStatusIcon(situation: Situation) {
        let state: IconState
        let described: String
        switch situation.tone {
        case .offline:
            state = .notRunning
            described = "Salidium, not running"
        case .critical:
            state = .notRecording
            described = "Salidium, not recording"
        case .attention:
            state = snapshot.collectionPaused ? .paused : .attention
            described = snapshot.collectionPaused
                ? "Salidium, paused" : "Salidium, needs attention"
        case .healthy:
            state = .recording
            described = "Salidium, recording"
        }
        let image = Self.statusImage(for: state)
        image.accessibilityDescription = described
        statusItem.button?.image = image
        statusItem.button?.contentTintColor = nil
        statusItem.button?.toolTip = "\(described). \(situation.headline)."
        statusItem.button?.setAccessibilityLabel(described)
    }

    /*
     * The same rendering as `formatBytes` in `@salidium/core`, which the app and the CLI use.
     *
     * Decimal, matching Finder, but not `ByteCountFormatter`: its adaptive mode renders one byte as
     * "0 KB" and 999999 as "1 MB", and the same function formats rates where that loses the value.
     * `byteLabelVectors` in that module pins the cases, and `macosService.test.ts` checks them
     * against this function, because Swift cannot import it.
     */
    private static func byteLabel(_ bytes: Int) -> String {
        let value = Double(bytes)
        if bytes < 1000 { return "\(bytes) B" }
        if bytes < 1000 * 1000 { return String(format: "%.1f KB", value / 1000) }
        if bytes < 1000 * 1000 * 1000 { return String(format: "%.1f MB", value / (1000 * 1000)) }
        return String(format: "%.2f GB", value / (1000 * 1000 * 1000))
    }

    private func addLabel(_ title: String, emphasized: Bool = false, secondary: Bool = false) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        if emphasized {
            item.attributedTitle = NSAttributedString(
                string: title,
                attributes: [.font: NSFont.systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)]
            )
        } else if secondary {
            item.attributedTitle = NSAttributedString(
                string: title,
                attributes: [
                    .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize),
                    .foregroundColor: NSColor.secondaryLabelColor,
                ]
            )
        }
        menu.addItem(item)
    }

    private func addAction(_ title: String, _ action: Selector, key: String = "") {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = true
        menu.addItem(item)
    }

    private func runCLI(_ arguments: [String], label: String? = nil, refreshAfter: Bool = true) {
        if let label = label {
            runningAction = label
            startPulse()
            rebuildMenu()
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: configuration.node)
        process.arguments = [configuration.cli] + arguments
        var environment = ProcessInfo.processInfo.environment
        environment["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path
        environment["SALIDIUM_HOME"] = configuration.home
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        let errorPipe = Pipe()
        process.standardError = errorPipe
        if refreshAfter {
            process.terminationHandler = { [weak self] finished in
                let data = errorPipe.fileHandleForReading.readDataToEndOfFile()
                let detail = String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    guard let self = self else { return }
                    self.runningAction = nil
                    self.stopPulse()
                    if finished.terminationStatus != 0 {
                        self.showError("Salidium could not complete that command",
                                       detail: detail?.isEmpty == false ? detail! : "The command exited with status \(finished.terminationStatus).")
                    }
                    self.refresh()
                }
            }
        } else {
            process.standardError = FileHandle.nullDevice
        }
        do {
            try process.run()
        } catch {
            showError("Salidium could not run that command", detail: error.localizedDescription)
        }
    }

    private func showError(_ message: String, detail: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = message
        alert.informativeText = detail
        alert.runModal()
    }

    /*
     * `--no-resume` because this menu only offers actions after a live health response, so the
     * dead-daemon case implicit resume exists to recover from cannot apply here, and because
     * `runCLI` sends stdout to the null device, so a resume would happen with nothing to show it.
     * Opening the interface is not a request to start recording again.
     */
    @objc private func openSalidium() { runCLI(["open", "--no-resume"]) }
    @objc private func startSalidium() { runCLI(["start"], label: "Starting") }
    @objc private func pauseCollection() { runCLI(["pause", "--quiet"], label: "Pausing") }
    @objc private func resumeCollection() { runCLI(["resume", "--quiet"], label: "Resuming") }
    @objc private func drainQueue() { runCLI(["maintenance", "drain", "--quiet"], label: "Storing waiting work") }
    @objc private func stopSalidium() { runCLI(["stop", "--quiet"], label: "Stopping") }

    @objc private func turnOffAlwaysOn() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Turn off Salidium always-on mode?"
        alert.informativeText = "This stops Salidium and removes its menu-bar control until you run “salidium service enable”. Your reports and settings stay on this Mac."
        alert.addButton(withTitle: "Turn Off")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        runCLI(["service", "disable"], refreshAfter: false)
    }
}

guard let configuration = Configuration.parse(CommandLine.arguments) else {
    FileHandle.standardError.write(Data("usage: salidium-menubar --home PATH --node PATH --cli PATH\n".utf8))
    exit(2)
}

let application = NSApplication.shared
private let delegate = AppDelegate(configuration: configuration)
application.delegate = delegate
application.run()
