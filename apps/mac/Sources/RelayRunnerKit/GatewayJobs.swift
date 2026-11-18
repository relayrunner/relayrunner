import Foundation

/// A job this Mac ran, as the gateway has it: what `relayrunner jobs --json` prints
/// (GET /api/machines/me/jobs). Times are ms since the epoch.
public struct GatewayJob: Equatable, Codable, Identifiable {
  public var id: Int
  public var name: String
  public var workflow: String?
  public var repo: String
  public var url: URL
  public var runId: Int
  public var runAttempt: Int
  /// GitHub's conclusion, such as success or failure.
  public var conclusion: String?
  /// "3. Run tests" when GitHub said which step failed.
  public var failedStep: String?
  public var queuedAt: Double?
  public var startedAt: Double?
  public var completedAt: Double?

  public init(
    id: Int, name: String, workflow: String? = nil, repo: String, url: URL, runId: Int = 1, runAttempt: Int = 1,
    conclusion: String? = nil, failedStep: String? = nil, queuedAt: Double? = nil, startedAt: Double? = nil,
    completedAt: Double? = nil
  ) {
    self.id = id
    self.name = name
    self.workflow = workflow
    self.repo = repo
    self.url = url
    self.runId = runId
    self.runAttempt = runAttempt
    self.conclusion = conclusion
    self.failedStep = failedStep
    self.queuedAt = queuedAt
    self.startedAt = startedAt
    self.completedAt = completedAt
  }

  public var outcome: HistoryEntry.Outcome { JobConclusion.outcome(conclusion) }

  /// Running or waiting to start: it hasn't finished.
  public var isActive: Bool { completedAt == nil }
  /// Sent to this Mac but not started yet.
  public var isWaiting: Bool { isActive && startedAt == nil }

  /// How long it waited for a runner. Zero when GitHub didn't say, so the table can sort on it.
  public var waitedMs: Double { span(queuedAt, startedAt) }
  public var ranMs: Double { span(startedAt, completedAt) }

  /// How long it has waited or run so far, for a job that hasn't finished.
  public func elapsedMs(now: Date) -> Double {
    span(startedAt ?? queuedAt, now.timeIntervalSince1970 * 1000)
  }
  /// When it finished, for sorting; zero while unknown.
  public var finishedMs: Double { completedAt ?? 0 }
  public var finished: Date? { completedAt.map { Date(timeIntervalSince1970: $0 / 1000) } }

  /// The repo's name without its owner.
  public var shortRepo: String { repo.split(separator: "/").last.map(String.init) ?? repo }

  /// Matches a search: by job, workflow or repo, in any case.
  public func matches(_ search: String) -> Bool {
    let query = search.trimmingCharacters(in: .whitespaces)
    if query.isEmpty { return true }
    return [name, workflow ?? "", repo].contains { $0.localizedCaseInsensitiveContains(query) }
  }
}

private func span(_ from: Double?, _ to: Double?) -> Double {
  guard let from, let to else { return 0 }
  return max(0, to - from)
}

public enum JobConclusion {
  /// GitHub's conclusion as one of the menu's outcomes.
  public static func outcome(_ conclusion: String?) -> HistoryEntry.Outcome {
    switch conclusion {
    case "success": return .succeeded
    case "failure", "timed_out", "startup_failure": return .failed
    case "cancelled", "skipped": return .canceled
    default: return .other
    }
  }
}

/// A page of `relayrunner jobs --json`. `next` is the `--before` for the page after it. The first
/// page also has `active`, the jobs running or waiting here now, and the repos and workflows the
/// Mac ran jobs from, for filters (nil from a gateway that doesn't send them yet).
public struct GatewayJobPage: Equatable, Codable {
  public var jobs: [GatewayJob]
  public var next: Double?
  public var active: [GatewayJob]?
  public var repos: [String]?
  public var workflows: [String]?

  public static func parse(_ data: Data) -> GatewayJobPage? {
    try? JSONDecoder().decode(GatewayJobPage.self, from: data)
  }

  /// Running and waiting jobs first, then the finished ones.
  public var all: [GatewayJob] { (active ?? []) + jobs }

  /// `older` after this page's jobs, leaving out any it already has.
  public func adding(_ older: GatewayJobPage) -> GatewayJobPage {
    let have = Set(all.map(\.id))
    var both = self
    both.jobs += older.jobs.filter { !have.contains($0.id) }
    both.next = older.next
    return both
  }

  public init(
    jobs: [GatewayJob], next: Double?, active: [GatewayJob]? = nil, repos: [String]? = nil,
    workflows: [String]? = nil
  ) {
    self.jobs = jobs
    self.next = next
    self.active = active
    self.repos = repos
    self.workflows = workflows
  }
}

/// What the Jobs window asks the gateway for: a result, repo, workflow and how far back. The
/// window's search narrows what came back.
public struct JobsFilter: Hashable {
  public enum Result: String, CaseIterable { case succeeded, failed, canceled }

  public enum Range: Int, CaseIterable {
    case hour = 1
    case day = 24
    case threeDays = 72
    case week = 168

    public var title: String {
      switch self {
      case .hour: "Last Hour"
      case .day: "Last 24 Hours"
      case .threeDays: "Last 3 Days"
      case .week: "Last Week"
      }
    }
  }

  public var result: Result?
  public var repo: String?
  public var workflow: String?
  public var range = Range.week

  public init(result: Result? = nil, repo: String? = nil, workflow: String? = nil, range: Range = .week) {
    self.result = result
    self.repo = repo
    self.workflow = workflow
    self.range = range
  }

  public var isEmpty: Bool { self == JobsFilter() }

  /// `relayrunner jobs` arguments for it. A week is all the gateway keeps, so it needs no `--since`.
  public func arguments(now: Date) -> [String] {
    var arguments: [String] = []
    if let result { arguments += ["--result", result.rawValue] }
    if let repo { arguments += ["--repo", repo] }
    if let workflow { arguments += ["--workflow", workflow] }
    if range != .week {
      let since = now.addingTimeInterval(-Double(range.rawValue) * 3600)
      arguments += ["--since", String(Int(since.timeIntervalSince1970 * 1000))]
    }
    return arguments
  }
}

extension GatewayJob {
  /// The GitHub job id in a job's link (…/actions/runs/3/job/7), such as a History entry's.
  public static func id(in url: URL) -> Int? {
    let parts = url.pathComponents
    guard parts.count >= 2, parts[parts.count - 2] == "job" else { return nil }
    return Int(parts[parts.count - 1])
  }
}

/// A step of a job, as GitHub reports it.
public struct JobStep: Equatable, Codable, Identifiable {
  public var number: Int
  public var name: String
  public var status: String
  public var conclusion: String?
  public var startedAt: Double?
  public var completedAt: Double?

  public var id: Int { number }
  public var outcome: HistoryEntry.Outcome { JobConclusion.outcome(conclusion) }
  public var durationMs: Double? {
    guard let startedAt, let completedAt else { return nil }
    return max(0, completedAt - startedAt)
  }

  public init(
    number: Int, name: String, status: String = "completed", conclusion: String? = "success",
    startedAt: Double? = nil, completedAt: Double? = nil
  ) {
    self.number = number
    self.name = name
    self.status = status
    self.conclusion = conclusion
    self.startedAt = startedAt
    self.completedAt = completedAt
  }
}

/// Why a job failed: the gateway's read of its failed step, annotations and log.
public struct JobFailure: Equatable, Codable {
  public var failedStep: String?
  public var runnerFailed: Bool
  public var annotations: [String]
  /// The log's last lines up to its last error. Nil when GitHub no longer has the log.
  public var log: [String]?
  public var cause: Cause?

  /// What the AI model thinks caused it, when the workspace has AI on and it could tell.
  public struct Cause: Equatable, Codable {
    public var kind: String
    public var confidence: Double
    /// "passes" or "fails" when a re-run will likely do that.
    public var rerun: String?

    /// "Likely a flaky test (80% sure). A re-run will probably pass."
    public var summary: String {
      let what: String =
        switch kind {
        case "flaky": "something intermittent"
        case "lint": "a lint, format or type check"
        case "test": "a test broken by a change"
        case "build": "the build or install"
        case "infra": "the runner or its machine"
        case "config": "the workflow's setup"
        default: kind
        }
      var text = "Likely \(what) (\(Int((confidence * 100).rounded()))% sure)."
      if rerun == "passes" { text += " A re-run will probably pass." }
      if rerun == "fails" { text += " A re-run will probably fail too." }
      return text
    }
  }
}

/// `relayrunner jobs <id> --json`: one job, its steps (nil when GitHub no longer has them) and,
/// for a failed one, why.
public struct GatewayJobDetail: Equatable, Codable {
  public var job: GatewayJob
  public var steps: [JobStep]?
  public var failure: JobFailure?

  public static func parse(_ data: Data) -> GatewayJobDetail? {
    try? JSONDecoder().decode(GatewayJobDetail.self, from: data)
  }
}

/// Where each step sits on a job's timeline, as fractions of the whole job.
public enum StepTimeline {
  public struct Bar: Equatable {
    public var start: Double
    public var width: Double

    public init(start: Double, width: Double) {
      self.start = start
      self.width = width
    }
  }

  /// One bar per step, nil for a step that never ran. A step too short to see still gets a sliver.
  public static func bars(_ steps: [JobStep], minimum: Double = 0.005) -> [Bar?] {
    let starts = steps.compactMap(\.startedAt)
    let ends = steps.compactMap(\.completedAt)
    guard let first = starts.min(), let last = ends.max(), last > first else { return steps.map { _ in nil } }
    let total = last - first
    return steps.map { step in
      guard let from = step.startedAt, let to = step.completedAt else { return nil }
      let start = (from - first) / total
      return Bar(start: start, width: min(max((to - from) / total, minimum), 1 - start))
    }
  }
}

/// A line of a job's log, without GitHub's `##[error]` marker, and whether it had one.
public struct LogLine: Equatable {
  public var text: String
  public var isError: Bool

  public init(_ line: String) {
    for marker in ["##[error]", "##[warning]"] {
      if let range = line.range(of: marker) {
        text = line.replacingCharacters(in: range, with: "")
        isError = marker == "##[error]"
        return
      }
    }
    text = line
    isError = false
  }
}
