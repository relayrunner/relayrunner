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
      _ = (connection.status, connection.signIn, connection.jobs, connection.repos, connection.machineName, connection.problem)
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
        DetailRow(systemImage: "hammer", title: connection.repos[job] ?? "Starting a job…", note: "Running")
      }
      if connection.phase == .online {
        HStack {
          Label("Pause new jobs", systemImage: "pause.circle")
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
