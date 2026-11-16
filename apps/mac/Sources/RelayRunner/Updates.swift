import AppKit
import Sparkle

/// Sparkle, which checks https://relayrunner.app/mac/appcast.xml (Info.plist's SUFeedURL) about
/// once a day and offers each new version. Off in a build without that key, such as `swift run`.
@MainActor
final class Updates: NSObject, SPUStandardUserDriverDelegate {
  static let shared = Updates()

  private var controller: SPUStandardUpdaterController?

  var updater: SPUUpdater? { controller?.updater }

  func start() {
    guard controller == nil, Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil else { return }
    controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: self)
  }

  func checkForUpdates() {
    NSApp.activate(ignoringOtherApps: true)
    controller?.checkForUpdates(nil)
  }

  // A menu bar app has no Dock icon to badge, so Sparkle shows its own reminder when it finds an
  // update in the background.
  nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }
}
