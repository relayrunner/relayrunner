/// The settings the app starts `relayrunner connect --events` with.
public struct LaunchOptions: Equatable {
  public enum Share: String { case onlyMe = "only-me", anyone }

  /// 0 leaves each to the CLI's default.
  public var concurrency = 0
  public var cpus = 0
  public var memoryGB = 0
  public var macOSJobs = false
  public var localNetwork = false
  /// Only for the first sign-in: after that, sharing is changed with `relayrunner share`.
  public var share: Share?

  public init(
    concurrency: Int = 0, cpus: Int = 0, memoryGB: Int = 0, macOSJobs: Bool = false,
    localNetwork: Bool = false, share: Share? = nil
  ) {
    self.concurrency = concurrency
    self.cpus = cpus
    self.memoryGB = memoryGB
    self.macOSJobs = macOSJobs
    self.localNetwork = localNetwork
    self.share = share
  }

  public var arguments: [String] {
    var arguments = ["connect", "--events"]
    if concurrency > 0 { arguments += ["--concurrency", String(concurrency)] }
    if cpus > 0 { arguments += ["--cpus", String(cpus)] }
    if memoryGB > 0 { arguments += ["--memory", String(memoryGB)] }
    if macOSJobs { arguments.append("--macos") }
    if localNetwork { arguments.append("--local-network") }
    if let share { arguments += ["--share", share.rawValue] }
    return arguments
  }
}
