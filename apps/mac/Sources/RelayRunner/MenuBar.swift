import AppKit
import RelayRunnerKit
import SwiftUI

/// The menu bar icon and its menu. A real menu rather than a window, so it looks and behaves like
/// the system's own: it closes when you pick an item, and takes the system's shape and material.
/// It says whether this Mac takes jobs and what it's running. The rest is in the Jobs window.
@MainActor
final class MenuBar: NSObject, NSMenuDelegate {
  static let shared = MenuBar()

  private let connection = Connection.shared
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let menu = NSMenu()
  private var header: NSHostingView<MenuHeader>?
  /// Shown while online: the pause with its choice of how long, or the way back from one.
  private let pause = NSMenuItem(title: "Pause New Jobs", action: nil, keyEquivalent: "")
  private lazy var resume = row("Resume New Jobs") { [weak self] in self?.connection.setPaused(false) }
  private let pauseSeparator = NSMenuItem.separator()

  func start() {
    menu.delegate = self
    menu.autoenablesItems = false

    let header = NSHostingView(
      rootView: MenuHeader(connection: connection, closeMenu: { [weak self] in self?.menu.cancelTracking() }))
    self.header = header
    let top = NSMenuItem()
    top.view = header
    menu.addItem(top)
    menu.addItem(.separator())
    let lengths = NSMenu()
    for length in PauseLength.allCases {
      lengths.addItem(row(length.title) { [weak self] in self?.connection.pause(for: length) })
    }
    pause.submenu = lengths
    menu.addItem(pause)
    menu.addItem(resume)
    menu.addItem(pauseSeparator)
    menu.addItem(row("Jobs…", key: "j") { JobsWindow.shared.show() })
    menu.addItem(row("Open Dashboard") { NSWorkspace.shared.open(Connection.shared.server) })
    menu.addItem(row("Settings…", key: ",") { MenuBar.openSettings() })
    menu.addItem(.separator())
    menu.addItem(row("Quit RelayRunner", key: "q") { NSApp.terminate(nil) })

    item.menu = menu
    item.button?.setAccessibilityLabel("RelayRunner")
    watch()
  }

  /// Keeps the icon current, and the header's height as jobs come and go.
  private func watch() {
    withObservationTracking {
      item.button?.image = connection.menuBarImage
      _ = (connection.status, connection.signIn, connection.jobs, connection.repos, connection.running, connection.problem)
    } onChange: { [weak self] in
      Task { @MainActor in self?.watch() }
    }
    fitHeader()
  }

  private func fitHeader() {
    guard let header else { return }
    header.setFrameSize(NSSize(width: MenuHeader.width, height: header.fittingSize.height))
  }

  func menuWillOpen(_ menu: NSMenu) { fitHeader() }

  func menuNeedsUpdate(_ menu: NSMenu) {
    let online = connection.phase == .online
    pause.isHidden = !online || connection.paused
    resume.isHidden = !online || !connection.paused
    // It takes jobs again on its own once the running ones finish.
    resume.isEnabled = connection.allowingSlots == nil
    pauseSeparator.isHidden = !online
  }

  func open() { item.button?.performClick(nil) }

  private func row(_ title: String, key: String = "", action: @escaping () -> Void) -> NSMenuItem {
    let item = ActionItem(title: title, action: action)
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

/// The top of the menu: the switch, and the jobs running on this Mac.
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

  /// The running jobs, and what went wrong when something did. Nothing while it waits for jobs.
  @ViewBuilder private var details: some View {
    if !connection.jobs.isEmpty || connection.problem != nil {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(connection.jobs, id: \.self) { job in
          RunningRow(running: connection.running[job], repo: connection.repos[job])
        }
        if let problem = connection.problem {
          Text(problem)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.horizontal, 8)
      .padding(.bottom, 6)
    }
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

/// A job running now: its name, workflow and repo, and how long it has run against how long it
/// usually takes here.
private struct RunningRow: View {
  let running: Connection.Running?
  let repo: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
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
        }
      }
      if let startedAt = running?.startedAt, let typicalMs = running?.job?.typicalMs {
        TimelineView(.periodic(from: startedAt, by: 1)) { context in
          if let share = Durations.share(elapsed: context.date.timeIntervalSince(startedAt), typicalMs: typicalMs) {
            UsualBar(fraction: share.fraction, over: share.over)
          }
        }
      }
    }
  }

  private var detail: String? {
    guard let job = running?.job else { return nil }
    return [job.workflow, job.repo].compactMap { $0 }.joined(separator: " · ")
  }
}

/// A running job's time against its usual time here: fills as it goes, and turns amber once the
/// job runs longer than usual.
private struct UsualBar: View {
  let fraction: Double
  let over: Bool

  var body: some View {
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule().fill(.quaternary)
        Capsule().fill(over ? .orange : .green).frame(width: max(3, geo.size.width * fraction))
      }
    }
    .frame(height: 3)
    .accessibilityElement()
    .accessibilityLabel(over ? "Longer than usual" : "\(Int(fraction * 100))% of its usual time")
  }
}
