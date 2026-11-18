import AppKit
import Observation
import RelayRunnerKit

/// This Mac's place in RelayRunner: whether `relayrunner connect` is running, and what it says.
@MainActor @Observable
final class Connection {
  static let shared = Connection()

  enum Phase { case off, starting, connecting, online, reconnecting, stopping }

  struct SignIn: Equatable {
    var code: String
    var url: URL
  }

  private(set) var phase = Phase.off
  private(set) var paused = false
  /// A job running now: its slot, which job it is when the gateway said, and when it started here.
  struct Running: Equatable {
    var slot: Int
    var job: RunJob?
    var startedAt: Date
  }

  /// The route ids of the jobs running now, and the repo each is from once it's known.
  private(set) var jobs: [String] = []
  /// How many jobs wait for a slot on this Mac.
  private(set) var waiting = 0
  private(set) var repos: [String: String] = [:]
  private(set) var running: [String: Running] = [:]
  /// The jobs this Mac ran, newest first, from `connect`'s history file.
  private(set) var recent: [HistoryEntry] = History.read(CLI.history)
  /// When a timed pause ends. Nil when it isn't paused for a while.
  private(set) var pausedUntil: Date? = AppSettings.pausedUntil
  private(set) var machineName: String?
  private(set) var server = URL(string: "https://app.relayrunner.app")!
  /// Set while a first sign-in waits for approval in the browser.
  private(set) var signIn: SignIn?
  /// Why it went off on its own, or why a command failed.
  private(set) var problem: String?
  /// Set by "Quit When It's Done": paused, and the app quits once no job is running.
  private(set) var quitsWhenIdle = false

  @ObservationIgnored private var process: CLIProcess?
  @ObservationIgnored private var resumeTimer: Timer?
  @ObservationIgnored private var lastError: String?
  @ObservationIgnored private var offlineReason: String?

  var isOn: Bool { phase != .off }

  /// Signed in already, so connecting needs no questions answered.
  var isEnrolled: Bool {
    FileManager.default.fileExists(atPath: CLI.home.appendingPathComponent("machine.json").path)
  }

  func turnOn(share: LaunchOptions.Share? = nil) {
    guard process == nil else { return }
    guard let executable = CLI.executable else {
      problem = "The relayrunner command isn't in this app. Reinstall it."
      return
    }
    var options = AppSettings.launchOptions
    options.share = share
    problem = nil
    lastError = nil
    offlineReason = nil
    try? FileManager.default.createDirectory(at: CLI.home, withIntermediateDirectories: true)
    do {
      process = try CLIProcess(
        executable: executable,
        arguments: options.arguments,
        environment: CLI.environment,
        log: CLI.log,
        onLine: { [weak self] line in MainActor.assumeIsolated { self?.handle(line) } },
        onExit: { [weak self] code in MainActor.assumeIsolated { self?.exited(code) } }
      )
      phase = .starting
      AppSettings.wantsOnline = true
    } catch {
      problem = "Couldn't start: \(error.localizedDescription)"
    }
  }

  func turnOff() {
    AppSettings.wantsOnline = false
    stop()
  }

  /// Goes offline the way Ctrl-C does. A job that's running stops with it.
  func stop() {
    guard let process else { return }
    phase = .stopping
    process.interrupt()
  }

  func setPaused(_ paused: Bool) {
    // Taking jobs again means staying open.
    if !paused { quitsWhenIdle = false }
    setPausedUntil(nil)
    process?.send(paused ? "pause" : "resume")
  }

  /// Pauses new jobs, and takes them again when the time is up.
  func pause(for length: PauseLength) {
    setPaused(true)
    setPausedUntil(length.end())
  }

  private func setPausedUntil(_ date: Date?) {
    pausedUntil = date
    AppSettings.pausedUntil = date
    resumeTimer?.invalidate()
    resumeTimer = nil
    guard let date else { return }
    let timer = Timer(fire: date, interval: 0, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.resumeIfPauseEnded() }
    }
    RunLoop.main.add(timer, forMode: .common)
    resumeTimer = timer
  }

  /// Takes jobs again once a timed pause is over, including one that ended while the app was closed.
  private func resumeIfPauseEnded() {
    guard let pausedUntil, pausedUntil <= Date() else { return }
    setPausedUntil(nil)
    if paused { process?.send("resume") }
  }

  /// Takes no new jobs, and quits the app once the running ones finish.
  func quitWhenIdle() {
    quitsWhenIdle = true
    process?.send("pause")
    quitIfIdle()
  }

  private func quitIfIdle() {
    guard quitsWhenIdle && jobs.isEmpty else { return }
    DispatchQueue.main.async { NSApp.terminate(nil) }
  }

  /// Back online when the app opens, if it was when it last quit.
  func resumeIfWanted() {
    if AppSettings.wantsOnline && isEnrolled { turnOn() }
  }

  private func handle(_ line: Data) {
    guard let event = Event.parse(line) else { return }
    switch event {
    case .signIn(let url, let code):
      signIn = SignIn(code: code, url: url)
    case .machine(_, let name, let server):
      machineName = name
      self.server = server
      signIn = nil
    case .state(let state):
      if phase != .stopping {
        switch state.link {
        case .connecting: phase = .connecting
        case .online: phase = .online
        case .reconnecting: phase = .reconnecting
        }
      }
      paused = state.paused
      jobs = state.jobs
      waiting = state.waiting
      repos = repos.filter { state.jobs.contains($0.key) }
      running = running.filter { state.jobs.contains($0.key) }
      // Resumed from the dashboard or the CLI: the timed pause is over too.
      if !state.paused && pausedUntil != nil && !quitsWhenIdle { setPausedUntil(nil) }
      if state.link == .online { resumeIfPauseEnded() }
      quitIfIdle()
    case .run(let routeId, let slot, let job):
      running[routeId] = Running(slot: slot, job: job, startedAt: Date())
      if let job { repos[routeId] = job.repo }
    case .jobEnd(let entry):
      recent = History.adding(entry, to: recent)
    case .jobRepo(let routeId, let repo):
      if running[routeId]?.job == nil { repos[routeId] = repo }
    case .jobResult(let routeId, let job, let result):
      if result == "Failed" {
        let known = running[routeId]?.job
        Notifications.shared.jobFailed(job: known?.name ?? job, repo: repos[routeId], url: known?.url, server: server)
      }
    case .offline(let reason, let message):
      offlineReason = reason
      if let message { lastError = message }
    case .error(_, let message, let command):
      if command != nil { problem = message } else { lastError = message }
    case .other:
      break
    }
  }

  private func exited(_ code: Int32) {
    let stopping = phase == .stopping
    process = nil
    phase = .off
    paused = false
    jobs = []
    waiting = 0
    repos = [:]
    running = [:]
    signIn = nil
    quitIfIdle()
    if stopping { return }
    AppSettings.wantsOnline = false
    switch offlineReason {
    case "revoked":
      problem =
        "This Mac was removed, or its token stopped working. If you didn't remove it, check the Runners page. Turn it on to sign in again."
    case "replaced":
      problem = "Another copy of this Mac's sign-in took over. If that wasn't you, revoke it on the Runners page."
    case "rejected":
      problem = "This version is too old for RelayRunner. Update the app."
    default:
      problem = lastError ?? "It stopped unexpectedly (exit code \(code)). Show Log has the details."
    }
  }
}

/// The bundled `relayrunner` command and where it keeps its files.
enum CLI {
  static let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".relayrunner")
  /// What `connect` prints for a person, from its last run.
  static let log = home.appendingPathComponent("app.log")
  /// The jobs `connect` ran here, which `relayrunner history` prints too.
  static let history = home.appendingPathComponent("history.jsonl")

  /// RELAYRUNNER_CLI overrides the bundled one, for development.
  static var executable: URL? {
    if let path = ProcessInfo.processInfo.environment["RELAYRUNNER_CLI"] {
      return URL(fileURLWithPath: path)
    }
    let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/relayrunner")
    return FileManager.default.isExecutableFile(atPath: bundled.path) ? bundled : nil
  }

  /// An app opened from Finder gets a bare PATH, and Apple's `container` tool is in /usr/local/bin.
  /// The app's version tells the dashboard the Mac app runs this machine, not the CLI on its own.
  static var environment: [String: String] {
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
    environment["RELAYRUNNER_MAC_APP_VERSION"] =
      Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    return environment
  }
}

extension CLI {
  struct Output {
    var status: Int32
    var stdout: Data
    var stderr: String

    /// What went wrong, in the CLI's words.
    var problem: String {
      let text = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
      return text.isEmpty ? "It stopped with exit code \(status)." : text
    }
  }

  /// Runs one of the CLI's quick commands, such as `workspaces list --json`, and waits for it.
  static func run(_ arguments: [String]) async throws -> Output {
    guard let executable else { throw CocoaError(.fileNoSuchFile) }
    return try await withCheckedThrowingContinuation { continuation in
      let process = Process()
      process.executableURL = executable
      process.arguments = arguments
      process.environment = environment
      let stdout = Pipe()
      let stderr = Pipe()
      process.standardOutput = stdout
      process.standardError = stderr
      process.standardInput = FileHandle.nullDevice
      process.terminationHandler = { process in
        let out = stdout.fileHandleForReading.readDataToEndOfFile()
        let err = stderr.fileHandleForReading.readDataToEndOfFile()
        continuation.resume(
          returning: Output(status: process.terminationStatus, stdout: out, stderr: String(decoding: err, as: UTF8.self))
        )
      }
      do { try process.run() } catch { continuation.resume(throwing: error) }
    }
  }
}
