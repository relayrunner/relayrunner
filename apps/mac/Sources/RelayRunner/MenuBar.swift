import AppKit
import RelayRunnerKit
import SwiftUI

/// The menu bar icon and its menu. A real menu rather than a window, so it looks and behaves like
/// the system's own: it closes when you pick an item, and takes the system's shape and material.
@MainActor
final class MenuBar: NSObject, NSMenuDelegate {
  static let shared = MenuBar()

  private let connection = Connection.shared
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let menu = NSMenu()
  private var header: NSHostingView<MenuHeader>?
  /// Recent jobs and the timed pause, rebuilt each time the menu opens.
  private var jobItems: [NSMenuItem] = []

  func start() {
    menu.delegate = self
    menu.autoenablesItems = false

    let header = NSHostingView(rootView: MenuHeader(connection: connection) { [weak self] in self?.menu.cancelTracking() })
    self.header = header
    let top = NSMenuItem()
    top.view = header
    menu.addItem(top)
    menu.addItem(.separator())
    menu.addItem(row("Open Dashboard", "safari") { NSWorkspace.shared.open(Connection.shared.server) })
    menu.addItem(row("Show Log", "doc.text") { NSWorkspace.shared.open(CLI.log) })
    menu.addItem(row("Settings…", "gearshape", key: ",") { MenuBar.openSettings() })
    if Updates.shared.updater != nil {
      menu.addItem(row("Check for Updates…", "arrow.down.circle") { Updates.shared.checkForUpdates() })
    }
    menu.addItem(.separator())
    menu.addItem(row("Quit RelayRunner", "power", key: "q") { NSApp.terminate(nil) })

    item.menu = menu
    item.button?.setAccessibilityLabel("RelayRunner")
    watch()
  }

  /// Keeps the icon current, and the header's height as rows come and go.
  private func watch() {
    withObservationTracking {
      item.button?.image = connection.menuBarImage
      _ = (
        connection.status, connection.signIn, connection.jobs, connection.repos, connection.running,
        connection.machineName, connection.problem, connection.pausedUntil, connection.waiting
      )
    } onChange: { [weak self] in
      Task { @MainActor in
        self?.watch()
        self?.fitHeader()
      }
    }
    fitHeader()
  }

  private func fitHeader() {
    guard let header else { return }
    header.setFrameSize(NSSize(width: MenuHeader.width, height: header.fittingSize.height))
  }

  func menuWillOpen(_ menu: NSMenu) { fitHeader() }

  func menuNeedsUpdate(_ menu: NSMenu) { rebuildJobItems() }

  /// The timed pause and the Recent section, between the header and Open Dashboard.
  private func rebuildJobItems() {
    for item in jobItems { menu.removeItem(item) }
    var items: [NSMenuItem] = []
    if connection.phase == .online && !connection.paused {
      let pause = NSMenuItem(title: "Pause New Jobs", action: nil, keyEquivalent: "")
      pause.image = NSImage(systemSymbolName: "pause.circle", accessibilityDescription: nil)
      let lengths = NSMenu()
      for length in PauseLength.allCases {
        lengths.addItem(ActionItem(title: length.title) { [weak self] in self?.connection.pause(for: length) })
      }
      pause.submenu = lengths
      items.append(pause)
    }
    let recent = Array(connection.recent.prefix(MenuBar.recentRows))
    if !recent.isEmpty {
      if !items.isEmpty { items.append(.separator()) }
      items.append(.sectionHeader(title: "Recent"))
      let now = Date()
      for entry in recent { items.append(recentItem(entry, now: now)) }
      let day = History.day(connection.recent, of: now)
      if day.jobs > 0 {
        var summary = "Today: \(day.jobs == 1 ? "1 job" : "\(day.jobs) jobs") · \(Durations.short(day.busyMs))"
        if day.failed > 0 { summary += " · \(day.failed) failed" }
        let today = NSMenuItem(title: summary, action: nil, keyEquivalent: "")
        today.isEnabled = false
        items.append(today)
      }
      items.append(
        row("Show All in Dashboard", "clock.arrow.circlepath") {
          NSWorkspace.shared.open(Connection.shared.server.appendingPathComponent("history"))
        })
    }
    if !items.isEmpty { items.append(.separator()) }
    // Right after the header and its separator.
    for (offset, item) in items.enumerated() { menu.insertItem(item, at: 2 + offset) }
    jobItems = items
  }

  static let recentRows = 5

  /// A job that ran here, with a submenu to open it on GitHub.
  private func recentItem(_ entry: HistoryEntry, now: Date) -> NSMenuItem {
    let when = "\(Durations.short(entry.durationMs)) · \(Durations.ago(entry.endedAt, now: now))"
    let item = NSMenuItem(title: entry.title, action: nil, keyEquivalent: "")
    if #available(macOS 14.4, *) {
      item.subtitle = [entry.repo, when].compactMap { $0 }.joined(separator: " · ")
    } else {
      item.title = "\(entry.title)  \(when)"
    }
    item.image = MenuBar.outcomeImage(entry.outcome)
    let details = NSMenu()
    if let url = entry.url {
      details.addItem(ActionItem(title: "Open on GitHub") { NSWorkspace.shared.open(url) })
      details.addItem(
        ActionItem(title: "Copy Link") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(url.absoluteString, forType: .string)
        })
      details.addItem(.separator())
    }
    for line in MenuBar.facts(entry) {
      let fact = NSMenuItem(title: line, action: nil, keyEquivalent: "")
      fact.isEnabled = false
      details.addItem(fact)
    }
    item.submenu = details
    return item
  }

  /// What a recent job's submenu says about it.
  static func facts(_ entry: HistoryEntry) -> [String] {
    var lines: [String] = []
    if let workflow = entry.workflow, let repo = entry.repo {
      lines.append("\(repo) · \(workflow)")
    } else if let repo = entry.repo {
      lines.append(repo)
    }
    var took = "\(entry.result ?? (entry.outcome == .failed ? "Runner failed" : "Done")) in \(Durations.short(entry.durationMs))"
    if let typical = entry.typicalMs { took += " (usual \(Durations.clock(Double(typical) / 1000)))" }
    lines.append(took)
    if let message = entry.message { lines.append(message) }
    if let slot = entry.slot { lines.append("Slot \(slot)") }
    return lines
  }

  static func outcomeImage(_ outcome: HistoryEntry.Outcome) -> NSImage? {
    let (symbol, color): (String, NSColor) =
      switch outcome {
      case .succeeded: ("checkmark.circle.fill", .systemGreen)
      case .failed: ("xmark.circle.fill", .systemRed)
      case .canceled: ("minus.circle.fill", .systemGray)
      case .other: ("circle.fill", .systemGray)
      }
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
    return image?.withSymbolConfiguration(.init(paletteColors: [color]))
  }

  func open() { item.button?.performClick(nil) }

  private func row(_ title: String, _ symbol: String, key: String = "", action: @escaping () -> Void) -> NSMenuItem {
    let item = ActionItem(title: title, action: action)
    item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
    item.keyEquivalent = key
    return item
  }

  /// SwiftUI owns the Settings window, and its item in the app menu is the way in from AppKit.
  static func openSettings() {
    NSApp.activate(ignoringOtherApps: true)
    if let appMenu = NSApp.mainMenu?.items.first?.submenu,
      let index = appMenu.items.firstIndex(where: { $0.keyEquivalent == "," })
    {
      appMenu.performActionForItem(at: index)
    } else {
      NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }
  }
}

/// A menu item that runs a closure.
private final class ActionItem: NSMenuItem {
  private let run: () -> Void

  init(title: String, action: @escaping () -> Void) {
    run = action
    super.init(title: title, action: #selector(fire), keyEquivalent: "")
    target = self
  }

  required init(coder: NSCoder) { fatalError() }

  @objc private func fire() { run() }
}

/// The top of the menu: the switch and what this Mac is doing.
struct MenuHeader: View {
  static let width: CGFloat = 300

  let connection: Connection
  /// Closes the menu, before a question that would otherwise sit behind it.
  let closeMenu: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      if let signIn = connection.signIn {
        SignInBox(signIn: signIn)
      } else if connection.isOn {
        details
      }
    }
    .padding(.horizontal, 6)
    .padding(.top, 2)
    .frame(width: Self.width, alignment: .leading)
  }

  private var header: some View {
    HStack(spacing: 10) {
      Image(nsImage: RobotHead.colorImage(side: 34))
        .opacity(connection.isOn ? 1 : 0.6)
      VStack(alignment: .leading, spacing: 1) {
        Text("RelayRunner").font(.headline)
        Text(connection.status)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      Toggle("Take jobs on this Mac", isOn: Binding(get: { connection.isOn }, set: toggle))
        .toggleStyle(.switch)
        .labelsHidden()
        .help(connection.isOn ? "Stop taking jobs on this Mac" : "Take jobs on this Mac")
    }
    .padding(8)
  }

  @ViewBuilder private var details: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let name = connection.machineName {
        DetailRow(systemImage: "laptopcomputer", title: name, note: "This Mac")
      }
      ForEach(connection.jobs, id: \.self) { job in
        RunningRow(running: connection.running[job], repo: connection.repos[job], slotted: connection.running.count > 1)
      }
      if connection.waiting > 0 {
        DetailRow(
          systemImage: "hourglass",
          title: connection.waiting == 1 ? "1 job waiting" : "\(connection.waiting) jobs waiting",
          note: "for a free slot"
        )
      }
      if connection.phase == .online {
        HStack {
          Label(pauseLabel, systemImage: "pause.circle")
          Spacer()
          Toggle("Pause new jobs", isOn: Binding(get: { connection.paused }, set: connection.setPaused))
            .toggleStyle(.switch)
            .controlSize(.mini)
            .labelsHidden()
        }
      }
      if let problem = connection.problem {
        Label(problem, systemImage: "exclamationmark.triangle")
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, 8)
    .padding(.bottom, 6)
  }

  private var pauseLabel: String {
    guard connection.paused, let until = connection.pausedUntil else { return "Pause new jobs" }
    let calendar = Calendar.current
    let time = until.formatted(date: .omitted, time: .shortened)
    if calendar.isDateInToday(until) { return "Paused until \(time)" }
    if calendar.isDateInTomorrow(until) { return "Paused until tomorrow, \(time)" }
    return "Paused until \(until.formatted(date: .abbreviated, time: .shortened))"
  }

  private func toggle(_ on: Bool) {
    guard on else { return connection.turnOff() }
    if connection.isEnrolled { return connection.turnOn() }
    // The first time, ask who can run jobs here before signing in. After the menu closes, so the
    // question isn't hidden behind it.
    closeMenu()
    DispatchQueue.main.async {
      if let share = askSharing() { connection.turnOn(share: share) }
    }
  }

  /// Who can run jobs on this Mac, or nil when the person cancels.
  private func askSharing() -> LaunchOptions.Share? {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "Who can run jobs on this Mac?"
    alert.informativeText = "Your own jobs can always run here. Next, your browser opens to sign this Mac in."
    alert.addButton(withTitle: "Only Me")
    alert.addButton(withTitle: "Anyone in My Workspaces")
    alert.addButton(withTitle: "Cancel")
    switch alert.runModal() {
    case .alertFirstButtonReturn: return .onlyMe
    case .alertSecondButtonReturn: return .anyone
    default: return nil
    }
  }
}

/// The code to check in the browser while a first sign-in waits. The welcome window shows it too.
struct SignInBox: View {
  let signIn: Connection.SignIn

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Check that your browser shows this code, then approve this Mac.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      Text(signIn.code)
        .font(.system(.title2, design: .monospaced).weight(.semibold))
        .textSelection(.enabled)
      Button("Open Sign-in Page") { NSWorkspace.shared.open(signIn.url) }
        .controlSize(.small)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(10)
    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    .padding(.horizontal, 8)
    .padding(.bottom, 6)
  }
}

private struct DetailRow: View {
  let systemImage: String
  let title: String
  let note: String

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: systemImage)
        .foregroundStyle(.secondary)
        .frame(width: 18)
      Text(title).lineLimit(1).truncationMode(.middle)
      Spacer(minLength: 8)
      Text(note).foregroundStyle(.secondary)
    }
  }
}

/// A job running now: its name, how long it has run against how long it usually takes here, and
/// its repo and slot.
private struct RunningRow: View {
  let running: Connection.Running?
  let repo: String?
  /// Whether more than one job is running, so the slot says which is which.
  let slotted: Bool

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: "hammer")
        .foregroundStyle(.secondary)
        .frame(width: 18)
      VStack(alignment: .leading, spacing: 1) {
        Text(running?.job?.name ?? repo ?? "Starting a job…").lineLimit(1).truncationMode(.middle)
        if let detail {
          Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
      }
      Spacer(minLength: 8)
      if let startedAt = running?.startedAt {
        TimelineView(.periodic(from: startedAt, by: 1)) { context in
          let elapsed = context.date.timeIntervalSince(startedAt)
          VStack(alignment: .trailing, spacing: 1) {
            Text(Durations.clock(elapsed)).monospacedDigit()
            if let progress = Durations.progress(elapsed: elapsed, typicalMs: running?.job?.typicalMs) {
              Text(progress).font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
          }
        }
      } else {
        Text("Running").foregroundStyle(.secondary)
      }
    }
  }

  private var detail: String? {
    let place = running.flatMap { slotted ? "Slot \($0.slot)" : nil }
    let parts = [running?.job?.workflow, running?.job == nil ? nil : (running?.job?.repo ?? repo), place].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }
}
