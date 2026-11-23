import AppKit
import RelayRunnerKit

/// After the app or its CLI crashes, the next launch offers to send the report: what macOS wrote
/// about it, cut down to what helps find the bug (CrashReport) and shown in full before it goes.
@MainActor
final class CrashReports {
  static let shared = CrashReports()

  private let folder = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/DiagnosticReports")

  func checkOnLaunch() {
    // A first check looks back a day, so a crash just before updating to this version is offered.
    let since = AppSettings.crashesCheckedAt ?? Date(timeIntervalSinceNow: -86400)
    AppSettings.crashesCheckedAt = Date()
    guard !AppSettings.crashReportsOff else { return }
    let folder = folder
    Task.detached(priority: .utility) {
      guard let found = CrashReport.latest(in: folder, since: since) else { return }
      await MainActor.run { CrashReports.shared.offer(found.report, of: found.count) }
    }
  }

  private func offer(_ report: CrashReport, of count: Int) {
    let alert = NSAlert()
    alert.messageText =
      report.origin == .app ? "RelayRunner quit unexpectedly" : "RelayRunner's CLI quit unexpectedly"
    let times = count > 1 ? " It crashed \(count) times since it last opened; this is the latest." : ""
    alert.informativeText =
      "Send this report to help us fix it? It goes with your RelayRunner account and holds only what's below: no names, repos or logs.\(times)"
    // Built once, so what's sent is exactly what was shown.
    let text = report.text
    alert.accessoryView = Self.preview(text)
    alert.addButton(withTitle: "Send Report")
    alert.addButton(withTitle: "Don't Send")
    alert.showsSuppressionButton = true
    alert.suppressionButton?.title = "Don't ask again"
    NSApp.activate(ignoringOtherApps: true)
    let send = alert.runModal() == .alertFirstButtonReturn
    if alert.suppressionButton?.state == .on { AppSettings.crashReportsOff = true }
    if send { Task { await self.send(text) } }
  }

  private func send(_ text: String) async {
    let file = FileManager.default.temporaryDirectory
      .appendingPathComponent("relayrunner-crash-\(UUID().uuidString).txt")
    defer { try? FileManager.default.removeItem(at: file) }
    var problem: String?
    do {
      try Data(text.utf8).write(to: file, options: .atomic)
      let output = try await CLI.run(["feedback", "--category", "bug", "--file", file.path])
      if output.status != 0 { problem = output.problem }
    } catch {
      problem = error.localizedDescription
    }
    guard let problem else { return }
    let alert = NSAlert()
    alert.messageText = "Couldn't send the report"
    alert.informativeText = problem
    alert.runModal()
  }

  /// The report as it's sent, in a scrolling box that can be read and copied but not changed.
  private static func preview(_ text: String) -> NSView {
    let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 480, height: 200))
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = true
    scroll.borderType = .bezelBorder
    let view = NSTextView(frame: scroll.bounds)
    view.string = text
    view.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
    view.isEditable = false
    view.isSelectable = true
    view.textContainerInset = NSSize(width: 4, height: 4)
    // Lines don't wrap, so frames stay one per line.
    view.isHorizontallyResizable = true
    view.textContainer?.widthTracksTextView = false
    view.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
    view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
    view.autoresizingMask = [.height]
    scroll.documentView = view
    // It opens at the top left, with the summary in view.
    view.sizeToFit()
    view.scroll(.zero)
    return scroll
  }
}
