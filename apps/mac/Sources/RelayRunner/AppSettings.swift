import Foundation
import RelayRunnerKit
import ServiceManagement

/// What the Settings window saves. Each value is 0 or false for the CLI's own default.
enum AppSettings {
  enum Key {
    static let concurrency = "concurrency"
    static let cpus = "cpus"
    static let memoryGB = "memoryGB"
    static let macOSJobs = "macOSJobs"
    static let localNetwork = "localNetwork"
    static let wantsOnline = "wantsOnline"
    static let notifiesOnFailure = "notifiesOnFailure"
    static let welcomed = "welcomed"
    static let welcomeMoved = "welcomeMoved"
    static let pausedUntil = "pausedUntil"
    static let crashesCheckedAt = "crashesCheckedAt"
    static let crashReportsOff = "crashReportsOff"
  }

  private static var defaults: UserDefaults { .standard }

  static var launchOptions: LaunchOptions {
    LaunchOptions(
      concurrency: defaults.integer(forKey: Key.concurrency),
      cpus: defaults.integer(forKey: Key.cpus),
      memoryGB: defaults.integer(forKey: Key.memoryGB),
      macOSJobs: defaults.bool(forKey: Key.macOSJobs),
      localNetwork: defaults.bool(forKey: Key.localNetwork)
    )
  }

  /// "Jobs at once" in Settings. 0 is the CLI's own choice.
  static var concurrency: Int {
    get { defaults.integer(forKey: Key.concurrency) }
    set { defaults.set(newValue, forKey: Key.concurrency) }
  }

  /// On when the app last quit, so it goes back online when it opens.
  static var wantsOnline: Bool {
    get { defaults.bool(forKey: Key.wantsOnline) }
    set { defaults.set(newValue, forKey: Key.wantsOnline) }
  }

  /// Off until someone turns it on in Settings or the welcome window.
  static var notifiesOnFailure: Bool {
    get { defaults.bool(forKey: Key.notifiesOnFailure) }
    set { defaults.set(newValue, forKey: Key.notifiesOnFailure) }
  }

  /// Set once the welcome window has been through, or closed, so it shows on a first launch only.
  static var welcomed: Bool {
    get { defaults.bool(forKey: Key.welcomed) }
    set { defaults.set(newValue, forKey: Key.welcomed) }
  }

  /// Set before the app relaunches from Applications, so the new copy's welcome picks up at signing in.
  static var welcomeMoved: Bool {
    get { defaults.bool(forKey: Key.welcomeMoved) }
    set { defaults.set(newValue, forKey: Key.welcomeMoved) }
  }

  /// When a timed pause from the menu ends, so it still ends if the app was closed meanwhile.
  static var pausedUntil: Date? {
    get { defaults.object(forKey: Key.pausedUntil) as? Date }
    set { defaults.set(newValue, forKey: Key.pausedUntil) }
  }

  /// When the app last looked for crash reports, so each crash is offered once.
  static var crashesCheckedAt: Date? {
    get { defaults.object(forKey: Key.crashesCheckedAt) as? Date }
    set { defaults.set(newValue, forKey: Key.crashesCheckedAt) }
  }

  /// Set by "Don't ask again" after a crash, or in Settings.
  static var crashReportsOff: Bool {
    get { defaults.bool(forKey: Key.crashReportsOff) }
    set { defaults.set(newValue, forKey: Key.crashReportsOff) }
  }

  /// A login item, kept by macOS rather than in defaults. Reads back what macOS settled on.
  static var opensAtLogin: Bool {
    get { SMAppService.mainApp.status == .enabled }
    set {
      if newValue { try? SMAppService.mainApp.register() } else { try? SMAppService.mainApp.unregister() }
    }
  }
}
