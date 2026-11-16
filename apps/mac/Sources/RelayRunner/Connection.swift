import Foundation
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
  /// The route ids of the jobs running now, and the repo each is from once it's known.
  private(set) var jobs: [String] = []
  private(set) var repos: [String: String] = [:]
  private(set) var machineName: String?
  private(set) var server = URL(string: "https://app.relayrunner.app")!
  /// Set while a first sign-in waits for approval in the browser.
  private(set) var signIn: SignIn?
  /// Why it went off on its own, or why a command failed.
  private(set) var problem: String?

  @ObservationIgnored private var process: CLIProcess?
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
    process?.send(paused ? "pause" : "resume")
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
      repos = repos.filter { state.jobs.contains($0.key) }
    case .jobRepo(let routeId, let repo):
      repos[routeId] = repo
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
    repos = [:]
    signIn = nil
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

  /// RELAYRUNNER_CLI overrides the bundled one, for development.
  static var executable: URL? {
    if let path = ProcessInfo.processInfo.environment["RELAYRUNNER_CLI"] {
      return URL(fileURLWithPath: path)
    }
    let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/relayrunner")
    return FileManager.default.isExecutableFile(atPath: bundled.path) ? bundled : nil
  }

  /// An app opened from Finder gets a bare PATH, and Apple's `container` tool is in /usr/local/bin.
  static var environment: [String: String] {
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
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
