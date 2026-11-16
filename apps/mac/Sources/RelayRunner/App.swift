import AppKit
import RelayRunnerKit
import SwiftUI

@main
struct RelayRunnerApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  private let connection = Connection.shared

  var body: some Scene {
    MenuBarExtra {
      Panel(connection: connection)
    } label: {
      Image(nsImage: connection.menuBarImage)
    }
    .menuBarExtraStyle(.window)
    Settings {
      SettingsView()
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    // A command written after `connect` exits would otherwise end the app.
    signal(SIGPIPE, SIG_IGN)
    MainActor.assumeIsolated {
      Updates.shared.start()
      Connection.shared.resumeIfWanted()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    // `connect` goes offline on its own once the app's end of its stdin closes too.
    MainActor.assumeIsolated { Connection.shared.stop() }
  }
}

extension Connection {
  /// The menu bar icon: faded unless it's taking jobs, with a dot while one runs.
  var menuBarImage: NSImage {
    RobotHead.menuBarImage(faded: phase != .online || paused, busy: !jobs.isEmpty)
  }

  /// The line beside the switch.
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
