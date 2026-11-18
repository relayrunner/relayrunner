import Foundation

/// Which job a `run` hands this Mac, when the gateway knows (`job` in a `run` event).
public struct RunJob: Equatable, Codable {
  public var name: String
  public var workflow: String?
  public var repo: String
  public var url: URL
  public var runAttempt: Int?
  /// How long the job usually runs on this Mac.
  public var typicalMs: Int?

  public init(name: String, workflow: String? = nil, repo: String, url: URL, runAttempt: Int? = nil, typicalMs: Int? = nil) {
    self.name = name
    self.workflow = workflow
    self.repo = repo
    self.url = url
    self.runAttempt = runAttempt
    self.typicalMs = typicalMs
  }
}

/// One job this Mac ran: a line of ~/.relayrunner/history.jsonl, or a `job-end` event
/// (apps/cli/src/history.rs).
public struct HistoryEntry: Equatable, Codable, Identifiable {
  public var routeId: String
  public var repo: String?
  public var workflow: String?
  public var job: String?
  public var url: URL?
  public var runAttempt: Int?
  /// GitHub's result as the runner printed it: Succeeded, Failed, Canceled and so on.
  public var result: String?
  /// `finished` when the runner exited cleanly, `failed` when it didn't.
  public var state: String
  public var message: String?
  public var slot: Int?
  public var startedAtMs: Double
  public var durationMs: Double
  public var typicalMs: Int?

  public var id: String { routeId }

  public init(
    routeId: String, repo: String? = nil, workflow: String? = nil, job: String? = nil, url: URL? = nil,
    runAttempt: Int? = nil, result: String? = nil, state: String = "finished", message: String? = nil,
    slot: Int? = nil, startedAtMs: Double, durationMs: Double, typicalMs: Int? = nil
  ) {
    self.routeId = routeId
    self.repo = repo
    self.workflow = workflow
    self.job = job
    self.url = url
    self.runAttempt = runAttempt
    self.result = result
    self.state = state
    self.message = message
    self.slot = slot
    self.startedAtMs = startedAtMs
    self.durationMs = durationMs
    self.typicalMs = typicalMs
  }

  public enum Outcome: Equatable { case succeeded, failed, canceled, other }

  public var outcome: Outcome {
    switch result {
    case "Succeeded": return .succeeded
    case "Failed": return .failed
    case "Canceled": return .canceled
    case nil: return state == "failed" ? .failed : .other
    default: return .other
    }
  }

  /// The job's name, else the repo, for a row.
  public var title: String { job ?? repo ?? "Job \(routeId)" }

  public var endedAt: Date { Date(timeIntervalSince1970: (startedAtMs + durationMs) / 1000) }
}

public enum History {
  /// The newest `limit` jobs in a history file, newest first. Lines this app can't read are
  /// skipped, and a missing file is no jobs.
  public static func read(_ file: URL, limit: Int = 200) -> [HistoryEntry] {
    guard let data = try? Data(contentsOf: file) else { return [] }
    let decoder = JSONDecoder()
    var entries: [HistoryEntry] = []
    for line in data.split(separator: UInt8(ascii: "\n")) {
      if let entry = try? decoder.decode(HistoryEntry.self, from: Data(line)) { entries.append(entry) }
    }
    return Array(entries.reversed().prefix(limit))
  }

  /// Puts a job that just ended at the front, in place of an older copy of it.
  public static func adding(_ entry: HistoryEntry, to entries: [HistoryEntry], limit: Int = 200) -> [HistoryEntry] {
    Array(([entry] + entries.filter { $0.routeId != entry.routeId }).prefix(limit))
  }

  /// How many jobs ran, for how long, and how many failed.
  public struct Summary: Equatable {
    public var jobs: Int
    public var busyMs: Double
    public var failed: Int

    public init(jobs: Int, busyMs: Double, failed: Int) {
      self.jobs = jobs
      self.busyMs = busyMs
      self.failed = failed
    }
  }

  /// One hour of the History chart: how many jobs ended in it, and how many of those failed.
  public struct Hour: Equatable {
    public var start: Date
    public var jobs: Int
    public var failed: Int

    public init(start: Date, jobs: Int, failed: Int) {
      self.start = start
      self.jobs = jobs
      self.failed = failed
    }
  }

  /// The last `count` hours up to `now`, oldest first, the last one ending at `now`.
  public static func hours(_ entries: [HistoryEntry], count: Int = 12, now: Date = Date()) -> [Hour] {
    let from = now.addingTimeInterval(-Double(count) * 3600)
    var hours = (0..<count).map { Hour(start: from.addingTimeInterval(Double($0) * 3600), jobs: 0, failed: 0) }
    for entry in entries {
      let offset = entry.endedAt.timeIntervalSince(from)
      guard offset > 0, offset <= Double(count) * 3600 else { continue }
      let index = min(count - 1, Int(offset / 3600))
      hours[index].jobs += 1
      if entry.outcome == .failed { hours[index].failed += 1 }
    }
    return hours
  }

  /// What ran since `date`.
  public static func since(_ date: Date, _ entries: [HistoryEntry]) -> Summary {
    let since = entries.filter { $0.endedAt > date }
    return Summary(
      jobs: since.count,
      busyMs: since.reduce(0) { $0 + $1.durationMs },
      failed: since.filter { $0.outcome == .failed }.count
    )
  }
}

/// Jobs that went to another runner because every slot here was busy.
public enum Spillover {
  /// How many of `spilled` (ms since the epoch) were in the hour before `now`.
  public static func lastHour(_ spilled: [Double], now: Date = Date()) -> Int {
    let from = (now.timeIntervalSince1970 - 3600) * 1000
    return spilled.filter { $0 > from }.count
  }

  /// The most jobs at once Settings offers.
  public static let mostSlots = 8

  /// How many jobs at once to offer instead of `slots`: one more, while it stays within Settings'
  /// choices and memory isn't nearly full (`memory` is the share in use). Nil when it shouldn't.
  public static func moreSlots(than slots: Int?, memory: Double?) -> Int? {
    guard let slots, slots < mostSlots else { return nil }
    if let memory, memory >= 0.85 { return nil }
    return slots + 1
  }
}

/// Short times for the menu.
public enum Durations {
  /// 45s, 4m 10s, 1h 02m.
  public static func short(_ ms: Double) -> String {
    let secs = max(0, Int(ms / 1000))
    switch secs {
    case ..<60: return "\(secs)s"
    case ..<3600: return "\(secs / 60)m \(String(format: "%02d", secs % 60))s"
    default: return "\(secs / 3600)h \(String(format: "%02d", secs % 3600 / 60))m"
    }
  }

  /// A running clock: 0:48, 12:05, 1:02:09.
  public static func clock(_ seconds: TimeInterval) -> String {
    let secs = max(0, Int(seconds))
    if secs >= 3600 {
      return "\(secs / 3600):\(String(format: "%02d", secs % 3600 / 60)):\(String(format: "%02d", secs % 60))"
    }
    return "\(secs / 60):\(String(format: "%02d", secs % 60))"
  }

  /// About how long: ~45s, ~5m, ~1h 10m.
  public static func about(_ ms: Int) -> String {
    let secs = ms / 1000
    switch secs {
    case ..<60: return "~\(secs)s"
    case ..<3600: return "~\(Int((Double(secs) / 60).rounded()))m"
    default:
      let mins = Int((Double(secs) / 60).rounded())
      return mins % 60 == 0 ? "~\(mins / 60)h" : "~\(mins / 60)h \(mins % 60)m"
    }
  }

  /// A running job's time against how long it usually takes here, worded like the dashboard:
  /// "about 1:48 left" until the usual time, nothing while it's past that but still normal, then
  /// "slower than usual (5:12)" once `isSlow`.
  public static func progress(elapsed: TimeInterval, typicalMs: Int?) -> String? {
    guard let typicalMs, typicalMs > 0 else { return nil }
    let usual = TimeInterval(typicalMs) / 1000
    if elapsed < usual { return "about \(clock(usual - elapsed)) left" }
    return isSlow(elapsed: elapsed, typicalMs: typicalMs) ? "slower than usual (\(clock(usual)))" : nil
  }

  /// Whether a job is meaningfully slower than usual here: at least 30 seconds and a quarter past
  /// its usual time, so ordinary run-to-run variance (1:31 against 1:22) doesn't read as a problem.
  /// The dashboard also checks the job's p90, which the machine doesn't get.
  public static func isSlow(elapsed: TimeInterval, typicalMs: Int) -> Bool {
    let usual = TimeInterval(typicalMs) / 1000
    return elapsed - usual >= max(30, usual * 0.25)
  }

  /// just now, 12m ago, 3h ago, 2d ago.
  public static func ago(_ date: Date, now: Date = Date()) -> String {
    let mins = max(0, Int(now.timeIntervalSince(date) / 60))
    switch mins {
    case 0: return "just now"
    case ..<60: return "\(mins)m ago"
    case ..<1440: return "\(mins / 60)h ago"
    default: return "\(mins / 1440)d ago"
    }
  }
}

/// When a timed pause ends.
public enum PauseLength: CaseIterable, Equatable {
  case oneHour, fourHours, untilTomorrow, untilResumed

  /// The end of the pause starting `now`, or nil for one that lasts until resumed. Tomorrow means
  /// 8 AM the next day.
  public func end(from now: Date = Date(), calendar: Calendar = .current) -> Date? {
    switch self {
    case .oneHour: return now.addingTimeInterval(3600)
    case .fourHours: return now.addingTimeInterval(4 * 3600)
    case .untilTomorrow:
      let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))!
      return calendar.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow)
    case .untilResumed: return nil
    }
  }

  public var title: String {
    switch self {
    case .oneHour: return "For 1 Hour"
    case .fourHours: return "For 4 Hours"
    case .untilTomorrow: return "Until Tomorrow Morning"
    case .untilResumed: return "Until I Resume"
    }
  }
}
