import AppKit
import SwiftUI
import UserNotifications

/// Tells the person when a job on this Mac fails. Off until they turn it on, in Settings or the
/// welcome window.
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
  static let shared = Notifications()

  private var center: UNUserNotificationCenter { .current() }

  func start() {
    center.delegate = self
  }

  /// Asks macOS. False when it says no, or the person turned notifications off for the app earlier.
  func requestPermission() async -> Bool {
    (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
  }

  /// `url` is the job's page on GitHub, when the gateway sent it; else clicking opens History.
  func jobFailed(job: String, repo: String?, url: URL?, server: URL) {
    guard AppSettings.notifiesOnFailure else { return }
    let content = UNMutableNotificationContent()
    content.title = "A job failed on this Mac"
    content.body = [repo, job].compactMap { $0 }.joined(separator: " · ")
    content.sound = .default
    content.userInfo = ["url": (url ?? server.appendingPathComponent("history")).absoluteString]
    center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }

  // Shown even while the menu or Settings is open.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  // Clicking one opens the job on GitHub, or History in the dashboard.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if let link = response.notification.request.content.userInfo["url"] as? String, let url = URL(string: link) {
      NSWorkspace.shared.open(url)
    }
    completionHandler()
  }
}

/// The switch for failure notifications, in Settings and the welcome window.
struct NotifyToggle: View {
  @AppStorage(AppSettings.Key.notifiesOnFailure) private var on = false
  @State private var blocked = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Toggle("Notify me when a job fails on this Mac", isOn: Binding(get: { on }, set: set))
      if blocked {
        Button("Notifications are off for RelayRunner. Open System Settings") {
          NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!)
        }
        .buttonStyle(.link)
        .font(.caption)
      }
    }
  }

  private func set(_ value: Bool) {
    guard value else {
      on = false
      return
    }
    Task { @MainActor in
      let allowed = await Notifications.shared.requestPermission()
      on = allowed
      blocked = !allowed
    }
  }
}
