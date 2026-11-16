import AppKit
import SwiftUI

@main
struct RelayRunnerApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  private let connection = Connection.shared

  var body: some Scene {
    MenuBarExtra {
      MenuContent(connection: connection)
    } label: {
      Image(systemName: connection.symbol)
    }
    Settings {
      SettingsView()
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    // A command written after `connect` exits would otherwise end the app.
    signal(SIGPIPE, SIG_IGN)
    MainActor.assumeIsolated { Connection.shared.resumeIfWanted() }
  }

  func applicationWillTerminate(_ notification: Notification) {
    // `connect` goes offline on its own once the app's end of its stdin closes too.
    MainActor.assumeIsolated { Connection.shared.stop() }
  }
}

extension Connection {
  /// The menu bar icon.
  var symbol: String {
    switch phase {
    case .off: "bolt.slash"
    case .online: jobs.isEmpty ? (paused ? "pause.circle" : "bolt") : "bolt.fill"
    default: "ellipsis.circle"
    }
  }

  /// The line under the switch.
  var status: String {
    switch phase {
    case .off: return problem ?? "Off"
    case .starting: return signIn == nil ? "Getting ready…" : "Waiting for you to approve this Mac"
    case .connecting: return "Connecting…"
    case .reconnecting: return "Reconnecting…"
    case .stopping: return "Going offline…"
    case .online:
      let running = jobs.count == 1 ? "Running a job" : "Running \(jobs.count) jobs"
      if jobs.isEmpty { return paused ? "Paused" : "Waiting for jobs" }
      return paused ? "\(running), then paused" : running
    }
  }
}
