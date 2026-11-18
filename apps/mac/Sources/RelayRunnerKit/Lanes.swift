import Foundation

/// One row per job slot on this Mac, for the menu's live panel.
public enum Lane: Hashable {
  /// The job with this route id runs in `slot`. Slot 0 when the CLI didn't say which.
  case busy(slot: Int, routeId: String)
  case free(slot: Int)

  public var slot: Int {
    switch self {
    case .busy(let slot, _), .free(let slot): return slot
    }
  }

  /// A lane for every slot, in slot order, with each running job in its own. A job in no known
  /// slot (or one past `slots`) gets a lane of its own after them, so nothing running is hidden.
  /// With `slots` unknown, only the running jobs.
  public static func lanes(slots: Int?, running: [(routeId: String, slot: Int?)]) -> [Lane] {
    var bySlot: [Int: String] = [:]
    var loose: [String] = []
    for job in running {
      if let slot = job.slot, slot >= 1, bySlot[slot] == nil, slot <= (slots ?? .max) {
        bySlot[slot] = job.routeId
      } else {
        loose.append(job.routeId)
      }
    }
    let count = slots ?? 0
    var lanes = (1...max(count, 1)).compactMap { slot -> Lane? in
      if let routeId = bySlot.removeValue(forKey: slot) { return .busy(slot: slot, routeId: routeId) }
      return slot <= count ? .free(slot: slot) : nil
    }
    // With no slot count, jobs keep their own slots, in order.
    lanes += bySlot.sorted { $0.key < $1.key }.map { .busy(slot: $0.key, routeId: $0.value) }
    lanes += loose.map { .busy(slot: 0, routeId: $0) }
    return lanes
  }
}

extension Durations {
  /// How far a running job is through its usual time: 0 to 1 until then, and `over` once it's past
  /// it, when the bar fills and turns amber. Nil without a usual time.
  public static func share(elapsed: TimeInterval, typicalMs: Int?) -> (fraction: Double, over: Bool)? {
    guard let typicalMs, typicalMs > 0 else { return nil }
    let fraction = elapsed / (TimeInterval(typicalMs) / 1000)
    return (min(max(fraction, 0), 1), fraction > 1)
  }
}
