import AppKit
import RelayRunnerKit
import SwiftUI

/// What opens from the menu bar: the switch and what this Mac is doing, then a few actions.
struct Panel: View {
  let connection: Connection
  @Environment(\.openSettings) private var openSettings

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      if let signIn = connection.signIn {
        SignInBox(signIn: signIn)
      } else if connection.isOn {
        details
      }

      Divider().padding(.vertical, 5)
      PanelRow("Open Dashboard", systemImage: "safari") { NSWorkspace.shared.open(connection.server) }
      PanelRow("Show Log", systemImage: "doc.text") { NSWorkspace.shared.open(CLI.log) }
      PanelRow("Settings…", systemImage: "gearshape", shortcut: ",") {
        NSApp.activate(ignoringOtherApps: true)
        openSettings()
      }
      if Updates.shared.updater != nil {
        PanelRow("Check for Updates…", systemImage: "arrow.down.circle") { Updates.shared.checkForUpdates() }
      }
      Divider().padding(.vertical, 5)
      PanelRow("Quit RelayRunner", systemImage: "power", shortcut: "q") { NSApp.terminate(nil) }
    }
    .padding(6)
    .frame(width: 300)
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
    // The first time, ask who can run jobs here before signing in. After the panel closes, so the
    // question isn't hidden behind it.
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

/// The code to check in the browser while a first sign-in waits.
private struct SignInBox: View {
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

/// A row that works like a menu item: highlighted under the pointer, with its shortcut on the right.
private struct PanelRow: View {
  let title: String
  let systemImage: String
  let shortcut: Character?
  let action: () -> Void
  @State private var hovering = false

  init(_ title: String, systemImage: String, shortcut: Character? = nil, action: @escaping () -> Void) {
    self.title = title
    self.systemImage = systemImage
    self.shortcut = shortcut
    self.action = action
  }

  var body: some View {
    let button = Button(action: action) {
      HStack(spacing: 8) {
        Image(systemName: systemImage)
          .frame(width: 18)
          .foregroundStyle(hovering ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
        Text(title)
        Spacer()
        if let shortcut {
          Text("⌘\(String(shortcut).uppercased())")
            .foregroundStyle(hovering ? AnyShapeStyle(.white.opacity(0.8)) : AnyShapeStyle(.tertiary))
        }
      }
      .foregroundStyle(hovering ? Color.white : Color.primary)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(hovering ? Color.accentColor : .clear, in: RoundedRectangle(cornerRadius: 5))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }

    if let shortcut {
      button.keyboardShortcut(KeyEquivalent(shortcut), modifiers: .command)
    } else {
      button
    }
  }
}
