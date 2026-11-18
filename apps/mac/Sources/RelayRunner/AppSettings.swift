import Foundation
import RelayRunnerKit

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

  /// On when the app last quit, so it goes back online when it opens.
  static var wantsOnline: Bool {
    get { defaults.bool(forKey: Key.wantsOnline) }
    set { defaults.set(newValue, forKey: Key.wantsOnline) }
  }

  /// Off until someone turns it on in Settings or the welcome window.
  static var notifiesOnFailure: Bool { defaults.bool(forKey: Key.notifiesOnFailure) }

  /// Set once the welcome window has been through, or closed, so it shows on a first launch only.
  static var welcomed: Bool {
    get { defaults.bool(forKey: Key.welcomed) }
    set { defaults.set(newValue, forKey: Key.welcomed) }
  }
}
