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
  // Before launch finishes, so clicking a notification that opened the app still works.
  func applicationWillFinishLaunching(_ notification: Notification) {
    Notifications.shared.start()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // A command written after `connect` exits would otherwise end the app.
    signal(SIGPIPE, SIG_IGN)
    MainActor.assumeIsolated {
      Updates.shared.start()
      // A welcome opened for development (RELAYRUNNER_WELCOME) leaves this Mac's connection alone.
      if ProcessInfo.processInfo.environment["RELAYRUNNER_WELCOME"] == nil { Connection.shared.resumeIfWanted() }
      Welcome.shared.showIfNew()
    }
  }

  /// Quitting stops a running job, so it asks first. Logging out, restarting and shutting down
  /// don't ask, so they're never held up.
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    MainActor.assumeIsolated {
      let connection = Connection.shared
      if connection.jobs.isEmpty || systemIsEnding { return .terminateNow }
      let one = connection.jobs.count == 1
      let alert = NSAlert()
      alert.messageText = one ? "A job is running on this Mac" : "Jobs are running on this Mac"
      alert.informativeText =
        one
        ? "Quitting now stops it, and it fails on GitHub. Quit when it's done to finish it without taking new jobs."
        : "Quitting now stops them, and they fail on GitHub. Quit when they're done to finish them without taking new jobs."
      alert.addButton(withTitle: "Quit When It's Done")
      alert.addButton(withTitle: "Quit Now")
      alert.addButton(withTitle: "Cancel")
      NSApp.activate(ignoringOtherApps: true)
      switch alert.runModal() {
      case .alertFirstButtonReturn:
        connection.quitWhenIdle()
        return .terminateCancel
      case .alertSecondButtonReturn:
        return .terminateNow
      default:
        return .terminateCancel
      }
    }
  }

  /// A quit from logging out, restarting or shutting down says why in its Apple event. Cmd-Q and
  /// the Dock's Quit don't.
  private var systemIsEnding: Bool {
    NSAppleEventManager.shared().currentAppleEvent?.attributeDescriptor(forKeyword: AEKeyword(kAEQuitReason)) != nil
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
      if quitsWhenIdle { return "\(running), then quitting" }
      return paused ? "\(running), then paused" : running
    }
  }
}
