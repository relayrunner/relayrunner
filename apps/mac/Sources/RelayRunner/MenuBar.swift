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
  /// The timed pause and the dashboard's history, rebuilt each time the menu opens.
  private var jobItems: [NSMenuItem] = []

  func start() {
    menu.delegate = self
    menu.autoenablesItems = false

    let header = NSHostingView(
      rootView: MenuHeader(
        connection: connection,
        closeMenu: { [weak self] in self?.menu.cancelTracking() },
        relayout: { [weak self] in self?.fitHeader() }
      ))
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
        connection.machineName, connection.problem, connection.pausedUntil, connection.waiting,
        connection.slots, connection.queue, connection.spilled, connection.recent,
        connection.allowingSlots
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

  func menuWillOpen(_ menu: NSMenu) {
    HostLoad.shared.start()
    fitHeader()
  }

  func menuDidClose(_ menu: NSMenu) { HostLoad.shared.stop() }

  func menuNeedsUpdate(_ menu: NSMenu) { rebuildJobItems() }

  /// The timed pause and the way to all of this Mac's history, between the header and Open
  /// Dashboard.
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
    if !connection.recent.isEmpty {
      items.append(
        row("Show All History in Dashboard", "clock.arrow.circlepath") {
          NSWorkspace.shared.open(Connection.shared.server.appendingPathComponent("history"))
        })
    }
    if !items.isEmpty { items.append(.separator()) }
    // Right after the header and its separator.
    for (offset, item) in items.enumerated() { menu.insertItem(item, at: 2 + offset) }
    jobItems = items
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
  /// Fits the menu to the header again, after a change only the header knows about.
  let relayout: () -> Void

  enum Tab: Hashable { case now, queue, history }
  @State private var tab = Tab.now

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
    .onChange(of: tab) { _, _ in DispatchQueue.main.async { relayout() } }
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
      Picker("Show", selection: $tab) {
        Text("Now").tag(Tab.now)
        Text(connection.waiting > 0 ? "Queue · \(connection.waiting)" : "Queue").tag(Tab.queue)
        Text("History").tag(Tab.history)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .controlSize(.small)
      switch tab {
      case .now: now
      case .queue: QueueTab(connection: connection, load: HostLoad.shared, openSettings: openSettings)
      case .history: HistoryTab(entries: connection.recent, open: openOnGitHub, relayout: relayout)
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

  /// A lane per slot, and this Mac's load.
  @ViewBuilder private var now: some View {
    ForEach(lanes, id: \.self) { lane in
      switch lane {
      case .busy(_, let job):
        RunningRow(running: connection.running[job], repo: connection.repos[job], slotted: lanes.count > 1)
      case .free(let slot):
        FreeSlotRow(slot: slot)
      }
    }
    if lanes.isEmpty {
      DetailRow(systemImage: "moon.zzz", title: "No jobs running", note: "")
    }
    if connection.phase == .online {
      LoadRow(load: HostLoad.shared)
    }
  }

  private func openSettings() {
    closeMenu()
    DispatchQueue.main.async { MenuBar.openSettings() }
  }

  private func openOnGitHub(_ url: URL) {
    closeMenu()
    NSWorkspace.shared.open(url)
  }

  /// A lane per slot while online (free ones too), else just the running jobs.
  private var lanes: [Lane] {
    let running = connection.jobs.map { (routeId: $0, slot: connection.running[$0]?.slot) }
    return Lane.lanes(slots: connection.phase == .online ? connection.slots : nil, running: running)
  }

  private var pauseLabel: String {
    if let count = connection.allowingSlots { return "Paused to switch to \(count) jobs at once" }
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
    .overlay(alignment: .bottom) {
      if let startedAt = running?.startedAt, let typicalMs = running?.job?.typicalMs {
        TimelineView(.periodic(from: startedAt, by: 1)) { context in
          if let share = Durations.share(elapsed: context.date.timeIntervalSince(startedAt), typicalMs: typicalMs) {
            UsualBar(fraction: share.fraction, over: share.over)
          }
        }
        .padding(.leading, 26)
        .offset(y: 5)
      }
    }
    .padding(.bottom, running?.job?.typicalMs == nil ? 0 : 6)
  }

  private var detail: String? {
    let place = running.flatMap { slotted ? "Slot \($0.slot)" : nil }
    let parts = [running?.job?.workflow, running?.job == nil ? nil : (running?.job?.repo ?? repo), place].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }
}

/// A running job's time against its usual time here: fills as it goes, and turns amber once the
/// job runs longer than usual.
private struct UsualBar: View {
  let fraction: Double
  let over: Bool

  var body: some View {
    Bar(fraction: fraction, tint: over ? .orange : .green)
      .accessibilityElement()
      .accessibilityLabel(over ? "Longer than usual" : "\(Int(fraction * 100))% of its usual time")
  }
}

private struct Bar: View {
  let fraction: Double
  let tint: Color

  var body: some View {
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule().fill(.quaternary)
        Capsule().fill(tint).frame(width: max(3, geo.size.width * fraction))
      }
    }
    .frame(height: 3)
  }
}

/// Jobs waiting for a slot on this Mac, and jobs that went to hosted runners because every slot
/// was busy.
private struct QueueTab: View {
  let connection: Connection
  let load: HostLoad
  /// Opens Settings, where "Jobs at once" is.
  let openSettings: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(connection.queue, id: \.self) { job in
        HStack(spacing: 8) {
          Image(systemName: "hourglass")
            .foregroundStyle(.orange)
            .frame(width: 18)
          VStack(alignment: .leading, spacing: 1) {
            Text(job.name ?? job.repo).lineLimit(1).truncationMode(.middle)
            if job.name != nil {
              Text([job.workflow, job.repo].compactMap { $0 }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            }
          }
          Spacer(minLength: 8)
          TimelineView(.periodic(from: job.waitingSince, by: 1)) { context in
            Text("waiting \(Durations.clock(context.date.timeIntervalSince(job.waitingSince)))")
              .foregroundStyle(.secondary)
              .monospacedDigit()
          }
        }
      }
      if connection.waiting > connection.queue.count {
        let more = connection.waiting - connection.queue.count
        DetailRow(
          systemImage: "hourglass",
          title: connection.queue.isEmpty
            ? (more == 1 ? "1 job waiting" : "\(more) jobs waiting") : "and \(more) more",
          note: connection.queue.isEmpty ? "for a free slot" : ""
        )
      }
      if connection.waiting == 0 {
        DetailRow(systemImage: "checkmark.circle", title: "Nothing waiting", note: "for this Mac")
      }
      if let count = connection.allowingSlots {
        Note(
          text: "Taking \(count) jobs at once as soon as the running jobs finish. New jobs go elsewhere until then."
        )
      } else {
        TimelineView(.periodic(from: .now, by: 30)) { context in
          let spilled = Spillover.lastHour(connection.spilled, now: context.date)
          if spilled > 0 {
            Note(
              text:
                "In the last hour, \(spilled == 1 ? "1 job" : "\(spilled) jobs") went to hosted runners because every slot here was busy."
            ) {
              if let more = Spillover.moreSlots(than: connection.slots, memory: memoryShare) {
                Button("Allow \(more) Jobs at Once") { connection.allowJobs(more) }
                  .controlSize(.small)
                  .help("Pauses new jobs until the running ones finish, then takes up to \(more) at once")
              } else {
                Button("Open Settings…", action: openSettings)
                  .controlSize(.small)
              }
            }
          }
        }
      }
    }
  }

  /// How much of this Mac's memory is in use, while the menu is open.
  private var memoryShare: Double? {
    load.memoryUsed.map { Double($0) / Double(max(load.memoryTotal, 1)) }
  }
}

/// An amber note in the queue, with an action under it when there is one.
private struct Note<Action: View>: View {
  let text: String
  @ViewBuilder var action: () -> Action

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(text)
        .font(.subheadline)
        .fixedSize(horizontal: false, vertical: true)
      action()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(8)
    .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
    .overlay(alignment: .leading) {
      UnevenRoundedRectangle(topLeadingRadius: 6, bottomLeadingRadius: 6)
        .fill(.orange)
        .frame(width: 3)
    }
  }
}

extension Note where Action == EmptyView {
  init(text: String) { self.init(text: text) { EmptyView() } }
}

/// The last 12 hours here: a bar per hour, a summary, and the latest jobs, all or only failed.
private struct HistoryTab: View {
  static let rows = 6

  let entries: [HistoryEntry]
  let open: (URL) -> Void
  let relayout: () -> Void
  @State private var failedOnly = false

  var body: some View {
    TimelineView(.periodic(from: .now, by: 60)) { context in
      VStack(alignment: .leading, spacing: 8) {
        if entries.isEmpty {
          DetailRow(systemImage: "clock", title: "No jobs here yet", note: "")
        } else {
          HourChart(hours: History.hours(entries, now: context.date))
          Text(summary(since: context.date.addingTimeInterval(-12 * 3600)))
            .font(.caption)
            .foregroundStyle(.secondary)
          Picker("Show", selection: $failedOnly) {
            Text("All").tag(false)
            Text("Failed").tag(true)
          }
          .pickerStyle(.segmented)
          .labelsHidden()
          .controlSize(.small)
          .frame(width: 140)
          .onChange(of: failedOnly) { _, _ in DispatchQueue.main.async { relayout() } }
          let shown = entries.filter { !failedOnly || $0.outcome == .failed }.prefix(Self.rows)
          if shown.isEmpty {
            Text("No failed jobs in this Mac's history.").font(.caption).foregroundStyle(.secondary)
          }
          VStack(spacing: 0) {
            ForEach(Array(shown)) { entry in
              HistoryRow(entry: entry, now: context.date, open: open)
            }
          }
        }
      }
    }
  }

  private func summary(since: Date) -> String {
    let last = History.since(since, entries)
    var text = "Last 12 hours: \(last.jobs == 1 ? "1 job" : "\(last.jobs) jobs")"
    if last.jobs > 0 { text += " · \(Durations.short(last.busyMs)) busy" }
    if last.failed > 0 { text += " · \(last.failed) failed" }
    return text
  }
}

/// A bar per hour, its failed jobs in red on top of the rest in green.
private struct HourChart: View {
  let hours: [History.Hour]

  var body: some View {
    let most = max(hours.map(\.jobs).max() ?? 0, 1)
    VStack(spacing: 3) {
      HStack(alignment: .bottom, spacing: 3) {
        ForEach(Array(hours.enumerated()), id: \.offset) { _, hour in
          VStack(spacing: 0) {
            if hour.failed > 0 {
              Rectangle().fill(.red).frame(height: height(hour.failed, of: most))
            }
            if hour.jobs > hour.failed {
              Rectangle().fill(.green).frame(height: height(hour.jobs - hour.failed, of: most))
            }
            if hour.jobs == 0 {
              Rectangle().fill(.quaternary).frame(height: 2)
            }
          }
          .clipShape(UnevenRoundedRectangle(topLeadingRadius: 2, topTrailingRadius: 2))
          .frame(maxWidth: .infinity)
        }
      }
      .frame(height: Self.height, alignment: .bottom)
      HStack {
        Text("12 hours ago")
        Spacer()
        Text("now")
      }
      .font(.caption2)
      .foregroundStyle(.tertiary)
    }
    .accessibilityElement()
    .accessibilityLabel(label)
  }

  private static let height: CGFloat = 36

  private func height(_ jobs: Int, of most: Int) -> CGFloat { Self.height * CGFloat(jobs) / CGFloat(most) }

  private var label: String {
    let jobs = hours.reduce(0) { $0 + $1.jobs }
    let failed = hours.reduce(0) { $0 + $1.failed }
    return "\(jobs) jobs in the last 12 hours, \(failed) failed"
  }
}

/// A job that ran here. Clicking it opens it on GitHub.
private struct HistoryRow: View {
  let entry: HistoryEntry
  let now: Date
  let open: (URL) -> Void
  @State private var hovering = false

  var body: some View {
    Button {
      if let url = entry.url { open(url) }
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        OutcomeIcon(outcome: entry.outcome)
        VStack(alignment: .leading, spacing: 1) {
          Text(entry.title).lineLimit(1).truncationMode(.middle)
          if let detail {
            Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
          }
        }
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 1) {
          Text(entry.outcome == .canceled ? "canceled" : Durations.short(entry.durationMs)).monospacedDigit()
          Text(Durations.ago(entry.endedAt, now: now)).font(.caption).foregroundStyle(.secondary)
        }
      }
      .padding(.vertical, 3)
      .padding(.horizontal, 4)
      .contentShape(Rectangle())
      .background(hovering && entry.url != nil ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 5))
    }
    .buttonStyle(.plain)
    .disabled(entry.url == nil)
    .onHover { hovering = $0 }
    .help(entry.url == nil ? "" : "Open on GitHub")
    .padding(.horizontal, -4)
  }

  private var detail: String? {
    let parts = [entry.repo, entry.workflow].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }
}

private struct OutcomeIcon: View {
  let outcome: HistoryEntry.Outcome

  var body: some View {
    let (symbol, color, label): (String, Color, String) =
      switch outcome {
      case .succeeded: ("checkmark.circle.fill", .green, "Succeeded")
      case .failed: ("xmark.circle.fill", .red, "Failed")
      case .canceled: ("minus.circle.fill", .gray, "Canceled")
      case .other: ("circle.fill", .gray, "Done")
      }
    Image(systemName: symbol)
      .foregroundStyle(color)
      .frame(width: 18)
      .accessibilityLabel(label)
  }
}

/// A slot with no job in it.
private struct FreeSlotRow: View {
  let slot: Int

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "circle.dashed")
        .foregroundStyle(.tertiary)
        .frame(width: 18)
      Text("Slot \(slot)").foregroundStyle(.secondary)
      Spacer(minLength: 8)
      Text("Free").foregroundStyle(.tertiary)
    }
  }
}

/// This Mac's CPU and memory, while the menu is open.
private struct LoadRow: View {
  let load: HostLoad

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "gauge.with.dots.needle.33percent")
        .foregroundStyle(.secondary)
        .frame(width: 18)
      Meter(title: "CPU", value: load.cpu.map { String(format: "%.0f%%", $0 * 100) }, fraction: load.cpu)
      Meter(
        title: "Memory",
        value: load.memoryUsed.map { "\(gigabytes($0)) of \(gigabytes(load.memoryTotal)) GB" },
        fraction: load.memoryUsed.map { Double($0) / Double(max(load.memoryTotal, 1)) }
      )
    }
  }

  private func gigabytes(_ bytes: UInt64) -> String {
    let gb = Double(bytes) / 1_073_741_824
    return gb < 10 ? String(format: "%.1f", gb) : String(format: "%.0f", gb)
  }
}

private struct Meter: View {
  let title: String
  let value: String?
  let fraction: Double?

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 4) {
        Text(title).foregroundStyle(.secondary)
        Text(value ?? "–").monospacedDigit()
      }
      .font(.caption)
      .lineLimit(1)
      Bar(fraction: min(max(fraction ?? 0, 0), 1), tint: (fraction ?? 0) > 0.9 ? .orange : .accentColor)
        .accessibilityHidden(true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
