import Foundation

/// One line of `relayrunner connect --events` (apps/cli/events.ts).
public enum Event: Equatable {
  /// The page to approve this Mac on, and the code it shows.
  case signIn(url: URL, code: String)
  case machine(id: String, name: String, server: URL)
  case state(State)
  case jobRepo(routeId: String, repo: String)
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

    public init(link: Link, paused: Bool, jobs: [String]) {
      self.link = link
      self.paused = paused
      self.jobs = jobs
    }
  }

  /// The event on a line, or nil for a line that isn't one this app understands.
  public static func parse(_ line: Data) -> Event? {
    let decoder = JSONDecoder()
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
    case "job-repo":
      return body(JobRepo.self).map { .jobRepo(routeId: $0.routeId, repo: $0.repo) }
    case "offline":
      return body(Offline.self).map { .offline(reason: $0.reason, message: $0.message) }
    case "error":
      return body(Failure.self).map { .error(code: $0.code, message: $0.message, command: $0.command) }
    default:
      return .other(type: head.type)
    }
  }

  private struct Head: Decodable { var v: Int; var type: String }
  private struct SignIn: Decodable { var url: String; var code: String }
  private struct Machine: Decodable { var id: String; var name: String; var server: String }
  private struct JobRepo: Decodable { var routeId: String; var repo: String }
  private struct Offline: Decodable { var reason: String; var message: String? }
  private struct Failure: Decodable { var code: String; var message: String; var command: String? }
}
