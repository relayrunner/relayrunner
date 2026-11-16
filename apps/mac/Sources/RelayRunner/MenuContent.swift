import AppKit
import RelayRunnerKit
import SwiftUI

struct MenuContent: View {
  let connection: Connection
  @Environment(\.openSettings) private var openSettings

  var body: some View {
    Toggle("Take Jobs on This Mac", isOn: Binding(get: { connection.isOn }, set: toggle))
    Text(connection.status)
    if let name = connection.machineName, connection.isOn {
      Text(name)
    }
    if let signIn = connection.signIn {
      Text("Code \(signIn.code)")
      Button("Open Sign-in Page") { NSWorkspace.shared.open(signIn.url) }
    }
    ForEach(connection.jobs, id: \.self) { job in
      if let repo = connection.repos[job] { Text(repo) }
    }
    Toggle("Pause New Jobs", isOn: Binding(get: { connection.paused }, set: connection.setPaused))
      .disabled(connection.phase != .online)
    if let problem = connection.problem, connection.isOn {
      Text(problem)
    }

    Divider()
    Button("Open Dashboard") { NSWorkspace.shared.open(connection.server) }
    Button("Show Log") { NSWorkspace.shared.open(CLI.log) }
      .disabled(!FileManager.default.fileExists(atPath: CLI.log.path))
    Button("Settings…") {
      NSApp.activate(ignoringOtherApps: true)
      openSettings()
    }
    .keyboardShortcut(",")

    Divider()
    Button("Quit RelayRunner") { NSApp.terminate(nil) }
      .keyboardShortcut("q")
  }

  private func toggle(_ on: Bool) {
    guard on else { return connection.turnOff() }
    if connection.isEnrolled { return connection.turnOn() }
    // The first time, ask who can run jobs here before signing in. After the menu closes, so the
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
