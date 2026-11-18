import RelayRunnerKit
import XCTest


final class LaneTests: XCTestCase {
  func testEverySlotGetsALane() {
    XCTAssertEqual(
      Lane.lanes(slots: 3, running: [("r2", 2)]),
      [.free(slot: 1), .busy(slot: 2, routeId: "r2"), .free(slot: 3)]
    )
  }

  func testJobsInNoKnownSlotStillShow() {
    XCTAssertEqual(
      Lane.lanes(slots: 1, running: [("r1", 1), ("r9", nil), ("r5", 5)]),
      [.busy(slot: 1, routeId: "r1"), .busy(slot: 0, routeId: "r9"), .busy(slot: 0, routeId: "r5")]
    )
  }

  func testWithoutASlotCountOnlyRunningJobs() {
    XCTAssertEqual(Lane.lanes(slots: nil, running: []), [])
    XCTAssertEqual(
      Lane.lanes(slots: nil, running: [("r2", 2), ("r1", 1)]),
      [.busy(slot: 1, routeId: "r1"), .busy(slot: 2, routeId: "r2")]
    )
  }

  func testShareOfTheUsualTime() {
    XCTAssertNil(Durations.share(elapsed: 10, typicalMs: nil))
    XCTAssertEqual(Durations.share(elapsed: 30, typicalMs: 60_000)?.fraction, 0.5)
    XCTAssertEqual(Durations.share(elapsed: 30, typicalMs: 60_000)?.over, false)
    XCTAssertEqual(Durations.share(elapsed: 80, typicalMs: 60_000)?.fraction, 1)
    XCTAssertEqual(Durations.share(elapsed: 80, typicalMs: 60_000)?.over, false)
    XCTAssertEqual(Durations.share(elapsed: 90, typicalMs: 60_000)?.fraction, 1)
    XCTAssertEqual(Durations.share(elapsed: 90, typicalMs: 60_000)?.over, true)
  }
}
