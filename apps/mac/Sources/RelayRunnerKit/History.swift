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
  /// "about 1:48 left" until the usual time, then "usual 5:12".
  public static func progress(elapsed: TimeInterval, typicalMs: Int?) -> String? {
    guard let typicalMs, typicalMs > 0 else { return nil }
    let usual = TimeInterval(typicalMs) / 1000
    return elapsed < usual ? "about \(clock(usual - elapsed)) left" : "usual \(clock(usual))"
  }

  /// How far a running job is through its usual time: 0 to 1 until then, and `over` once it's past
  /// it, when the bar fills and turns amber. Nil without a usual time.
  public static func share(elapsed: TimeInterval, typicalMs: Int?) -> (fraction: Double, over: Bool)? {
    guard let typicalMs, typicalMs > 0 else { return nil }
    let fraction = elapsed / (TimeInterval(typicalMs) / 1000)
    return (min(max(fraction, 0), 1), fraction > 1)
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
