import AppKit
import RelayRunnerKit
import SwiftUI

@main
struct RelayRunnerApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  // The menu bar icon and its menu are AppKit's (MenuBar), so the menu is a real menu.
  var body: some Scene {
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
      MenuBar.shared.start()
      // For development: RELAYRUNNER_MENU opens the menu at launch. It and RELAYRUNNER_WELCOME leave
      // this Mac's connection alone.
      let env = ProcessInfo.processInfo.environment
      if env["RELAYRUNNER_WELCOME"] == nil && env["RELAYRUNNER_MENU"] == nil { Connection.shared.resumeIfWanted() }
      if env["RELAYRUNNER_MENU"] != nil { DispatchQueue.main.async { MenuBar.shared.open() } }
      Welcome.shared.showIfNew()
      CrashReports.shared.checkOnLaunch()
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
      if jobs.isEmpty {
        if let count = allowingSlots { return "Switching to \(count) jobs at once" }
        return paused ? pauseStatus : "Waiting for jobs"
      }
      let running = jobs.count == 1 ? "Running 1 job" : "Running \(jobs.count) jobs"
      if quitsWhenIdle { return "\(running), then quitting" }
      if let count = allowingSlots { return "\(running), then taking \(count) at once" }
      if paused { return "\(running), then paused" }
      return waiting > 0 ? "\(running), \(waiting) waiting" : running
    }
  }

  /// "Paused", with when it ends for a timed pause.
  private var pauseStatus: String {
    guard let until = pausedUntil else { return "Paused" }
    let calendar = Calendar.current
    let time = until.formatted(date: .omitted, time: .shortened)
    if calendar.isDateInToday(until) { return "Paused until \(time)" }
    if calendar.isDateInTomorrow(until) { return "Paused until tomorrow, \(time)" }
    return "Paused until \(until.formatted(date: .abbreviated, time: .shortened))"
  }
}
