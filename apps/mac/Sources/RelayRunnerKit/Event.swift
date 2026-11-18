import Foundation

/// A job waiting for a slot on this Mac: its repo, and since when in ms since the epoch.
public struct QueuedJob: Equatable, Decodable, Hashable {
  public var repo: String
  public var since: Double

  public init(repo: String, since: Double) {
    self.repo = repo
    self.since = since
  }

  public var waitingSince: Date { Date(timeIntervalSince1970: since / 1000) }
}

/// One line of `relayrunner connect --events` (apps/cli/src/events.rs).
public enum Event: Equatable {
  /// The page to approve this Mac on, and the code it shows.
  case signIn(url: URL, code: String)
  case machine(id: String, name: String, server: URL)
  case state(State)
  /// A job was handed to this Mac, in a slot from 1. `job` says which, when the gateway knew.
  case run(routeId: String, slot: Int, job: RunJob?)
  case jobRepo(routeId: String, repo: String)
  /// How a job ended, in GitHub's words: Succeeded, Failed, Canceled and so on.
  case jobResult(routeId: String, job: String, result: String)
  /// A job's runner exited: the line `connect` added to the history file.
  case jobEnd(HistoryEntry)
  case offline(reason: String, message: String?)
  /// `command` is set when a command failed; without it, `connect` is stopping.
  case error(code: String, message: String, command: String?)
  /// The connection's own events (connecting, run, job and so on), which `state` sums up.
  case other(type: String)

  public struct State: Equatable, Decodable {
    public enum Link: String, Decodable { case connecting, online, reconnecting }
    public var link: Link
    public var paused: Bool
    /// The route ids of the jobs running now.
    public var jobs: [String]
    /// How many jobs wait for a slot on this Mac, as the gateway said. 0 from a CLI that doesn't say.
    public var waiting: Int
    /// The longest-waiting of those jobs, longest first.
    public var queue: [QueuedJob]
    /// When jobs went to another runner because every slot here was busy, in ms since the epoch:
    /// the last hour's, as the gateway last said.
    public var spilled: [Double]
    /// How many jobs this Mac runs at once. Nil from a CLI that doesn't say.
    public var slots: Int?

    public init(
      link: Link, paused: Bool, jobs: [String], waiting: Int = 0, queue: [QueuedJob] = [],
      spilled: [Double] = [], slots: Int? = nil
    ) {
      self.link = link
      self.paused = paused
      self.jobs = jobs
      self.waiting = waiting
      self.queue = queue
      self.spilled = spilled
      self.slots = slots
    }

    private enum CodingKeys: String, CodingKey { case link, paused, jobs, waiting, queue, spilled, slots }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      link = try c.decode(Link.self, forKey: .link)
      paused = try c.decode(Bool.self, forKey: .paused)
      jobs = try c.decode([String].self, forKey: .jobs)
      waiting = try c.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
      // What an older CLI doesn't say, or says in a way this app can't read, is nothing.
      queue = (try? c.decodeIfPresent([QueuedJob].self, forKey: .queue)) ?? []
      spilled = (try? c.decodeIfPresent([Double].self, forKey: .spilled)) ?? []
      slots = try c.decodeIfPresent(Int.self, forKey: .slots)
    }
  }

  /// The event on a line, or nil for a line that isn't one this app understands.
  public static func parse(_ line: Data) -> Event? {
    guard let head = try? decoder.decode(Head.self, from: line), head.v == 1 else { return nil }
    func body<T: Decodable>(_: T.Type) -> T? { try? decoder.decode(T.self, from: line) }
    switch head.type {
    case "sign-in":
      guard let e = body(SignIn.self), let url = URL(string: e.url) else { return nil }
      return .signIn(url: url, code: e.code)
    case "machine":
      guard let e = body(Machine.self), let server = URL(string: e.server) else { return nil }
      return .machine(id: e.id, name: e.name, server: server)
    case "state":
      return body(State.self).map(Event.state)
    case "run":
      guard let e = body(Run.self) else { return nil }
      return .run(routeId: e.routeId, slot: e.slot ?? 1, job: e.job)
    case "job-end":
      return body(HistoryEntry.self).map(Event.jobEnd)
    case "job-repo":
      return body(JobRepo.self).map { .jobRepo(routeId: $0.routeId, repo: $0.repo) }
    case "job-result":
      return body(JobResult.self).map { .jobResult(routeId: $0.routeId, job: $0.job, result: $0.result) }
    case "offline":
      return body(Offline.self).map { .offline(reason: $0.reason, message: $0.message) }
    case "error":
      return body(Failure.self).map { .error(code: $0.code, message: $0.message, command: $0.command) }
    default:
      return .other(type: head.type)
    }
  }

  private static let decoder = JSONDecoder()
  private struct Head: Decodable { var v: Int; var type: String }
  private struct SignIn: Decodable { var url: String; var code: String }
  private struct Machine: Decodable { var id: String; var name: String; var server: String }
  private struct Run: Decodable {
    var routeId: String
    var slot: Int?
    var job: RunJob?

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      routeId = try c.decode(String.self, forKey: .routeId)
      slot = try? c.decode(Int.self, forKey: .slot)
      // A job this app can't read still runs.
      job = try? c.decode(RunJob.self, forKey: .job)
    }

    enum CodingKeys: String, CodingKey { case routeId, slot, job }
  }
  private struct JobRepo: Decodable { var routeId: String; var repo: String }
  private struct JobResult: Decodable { var routeId: String; var job: String; var result: String }
  private struct Offline: Decodable { var reason: String; var message: String? }
  private struct Failure: Decodable { var code: String; var message: String; var command: String? }
}
