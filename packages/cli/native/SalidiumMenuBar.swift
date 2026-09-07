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

private struct Snapshot {
    var health: Health = .offline
    var pid: Int?
    var collection = "Unavailable"
    var queueFiles: Int?
    var queueBytes: Int?
    var storeBytes: Int?
    var retention = "Unavailable"
    var activeAlerts = 0
    var maintenance: String?

    static let offline = Snapshot()
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let configuration: Configuration
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let menu = NSMenu()
    private var snapshot = Snapshot.offline
    private var refreshInProgress = false
    private var timer: Timer?

    init(configuration: Configuration) {
        self.configuration = configuration
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        menu.delegate = self
        statusItem.menu = menu
        if let button = statusItem.button {
            button.toolTip = "Salidium local operations"
            button.setAccessibilityLabel("Salidium local operations")
        }
        rebuildMenu()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
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
            snapshot.collection = state == "active" ? "On" : "Paused"
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
        if let alerts = overview["alerts"] as? [String: Any],
           let active = alerts["active"] as? [Any] {
            snapshot.activeAlerts = active.count
        }
        if let maintenance = health["maintenance"] as? [String: Any],
           let phase = maintenance["phase"] as? String {
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

    private static func shortLabel(_ value: String) -> String {
        let limit = 88
        return value.count > limit ? String(value.prefix(limit - 1)) + "…" : value
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        configureStatusIcon()

        // No em dash in anything the product says. `printedVoice.test.ts` reads this file for them.
        let heading: String
        switch snapshot.health {
        case .healthy: heading = "Salidium · Healthy"
        case .attention: heading = "Salidium · Needs Attention"
        case .critical: heading = "Salidium · Critical"
        case .offline: heading = "Salidium · Not Running"
        }
        addLabel(heading, emphasized: true)
        menu.addItem(.separator())

        addLabel(snapshot.pid.map { "Running · PID \($0)" } ?? "Not running")
        addLabel("Recording · \(snapshot.collection)")
        addLabel("Waiting to be stored · \(queueLabel())")
        addLabel("On this Mac · \(storageLabel())")
        addLabel(snapshot.activeAlerts == 0
                 ? "Nothing needs attention"
                 : "\(snapshot.activeAlerts) need\(snapshot.activeAlerts == 1 ? "s" : "") attention")
        if let maintenance = snapshot.maintenance { addLabel("Maintenance · \(maintenance)") }

        menu.addItem(.separator())
        addAction("Open Salidium", #selector(openSalidium), key: "o", enabled: true)
        if snapshot.pid == nil {
            addAction("Start Salidium", #selector(startSalidium), enabled: true)
        } else {
            let paused = snapshot.collection == "Paused"
            addAction(paused ? "Resume Collection" : "Pause Collection",
                      paused ? #selector(resumeCollection) : #selector(pauseCollection),
                      enabled: true)
            addAction("Store One Batch Now", #selector(drainQueue), enabled: true)
            addAction("Stop Salidium", #selector(stopSalidium), enabled: true)
        }
        addAction("Refresh Now", #selector(refreshNow), key: "r", enabled: true)
        menu.addItem(.separator())
        addLabel("Always-on · Starts at login")
        addAction("Open Data Folder", #selector(openDataFolder), enabled: true)
        addAction("Turn Off Always-On Mode…", #selector(turnOffAlwaysOn), enabled: true)
    }

    private func configureStatusIcon() {
        let symbol: String
        let color: NSColor
        switch snapshot.health {
        case .healthy:
            symbol = "checkmark.circle.fill"
            color = .systemGreen
        case .attention:
            symbol = "exclamationmark.triangle.fill"
            color = .systemOrange
        case .critical:
            symbol = "exclamationmark.octagon.fill"
            color = .systemRed
        case .offline:
            symbol = "circle.slash"
            color = .secondaryLabelColor
        }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Salidium \(snapshot.health.rawValue)")
        image?.isTemplate = false
        statusItem.button?.image = image
        statusItem.button?.contentTintColor = color
    }

    private func queueLabel() -> String {
        guard let files = snapshot.queueFiles, let bytes = snapshot.queueBytes else {
            return "Unavailable"
        }
        return "\(files) \(files == 1 ? "file" : "files") · \(Self.byteLabel(bytes))"
    }

    private func storageLabel() -> String {
        guard let bytes = snapshot.storeBytes else { return "Unavailable" }
        return "\(Self.byteLabel(bytes)) · \(snapshot.retention)"
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

    private func addLabel(_ title: String, emphasized: Bool = false) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        if emphasized {
            item.attributedTitle = NSAttributedString(
                string: title,
                attributes: [.font: NSFont.systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)]
            )
        }
        menu.addItem(item)
    }

    private func addAction(_ title: String,
                           _ action: Selector,
                           key: String = "",
                           enabled: Bool) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = enabled
        menu.addItem(item)
    }

    private func runCLI(_ arguments: [String], refreshAfter: Bool = true) {
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

    @objc private func openSalidium() { runCLI(["open"]) }
    @objc private func startSalidium() { runCLI(["start"]) }
    @objc private func pauseCollection() { runCLI(["pause", "--quiet"]) }
    @objc private func resumeCollection() { runCLI(["resume", "--quiet"]) }
    @objc private func drainQueue() { runCLI(["maintenance", "drain", "--quiet"]) }
    @objc private func stopSalidium() { runCLI(["stop", "--quiet"]) }
    @objc private func refreshNow() { refresh() }

    @objc private func openDataFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: configuration.home, isDirectory: true))
    }

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
