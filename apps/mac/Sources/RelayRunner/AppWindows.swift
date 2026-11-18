import AppKit

/// While Settings or the welcome window is open, the app acts like a regular app, with a Dock icon
/// and a place in Cmd-Tab. A menu bar-only app's windows otherwise drop behind other apps' windows
/// as soon as you use the menu bar.
@MainActor
enum AppWindows {
  private static var open = 0

  static func opened() {
    open += 1
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
  }

  static func closed() {
    open = max(0, open - 1)
    if open == 0 { NSApp.setActivationPolicy(.accessory) }
  }
}
