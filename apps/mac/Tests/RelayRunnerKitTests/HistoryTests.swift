import Foundation
import RelayRunnerKit
import XCTest

final class HistoryTests: XCTestCase {
  private func parse(_ line: String) -> Event? { Event.parse(Data(line.utf8)) }

  // The line apps/cli/src/history.rs writes.
  private let line =
    #"{"v":1,"routeId":"r1","repo":"acme/app","workflow":"CI","job":"test","url":"https://github.com/acme/app/actions/runs/42/job/7","runAttempt":1,"result":"Failed","state":"finished","message":null,"slot":2,"startedAt":"2026-11-18T10:00:00.000Z","startedAtMs":1763460000000,"durationMs":250000,"typicalMs":300000,"usage":null}"#

  func testReadsRunAndJobEnd() {
    XCTAssertEqual(
      parse(
        #"{"v":1,"at":"x","type":"run","routeId":"r1","slot":2,"job":{"name":"test","workflow":"CI","repo":"acme/app","url":"https://github.com/acme/app/actions/runs/42/job/7","runAttempt":1,"typicalMs":300000}}"#
      ),
      .run(
        routeId: "r1", slot: 2,
        job: RunJob(
          name: "test", workflow: "CI", repo: "acme/app",
          url: URL(string: "https://github.com/acme/app/actions/runs/42/job/7")!, runAttempt: 1, typicalMs: 300_000)
      )
    )
    // From a gateway that doesn't name jobs, or one this app can't read.
    XCTAssertEqual(parse(#"{"v":1,"at":"x","type":"run","routeId":"r1","slot":1}"#), .run(routeId: "r1", slot: 1, job: nil))
    XCTAssertEqual(
      parse(#"{"v":1,"at":"x","type":"run","routeId":"r1","slot":1,"job":{"name":3}}"#), .run(routeId: "r1", slot: 1, job: nil))

    guard case .jobEnd(let entry) = parse(#"{"v":1,"at":"x","type":"job-end","# + line.dropFirst(7)) else {
      return XCTFail("job-end should parse")
    }
    XCTAssertEqual(entry.title, "test")
    XCTAssertEqual(entry.outcome, .failed)
    XCTAssertEqual(entry.slot, 2)
    XCTAssertEqual(entry.typicalMs, 300_000)
  }

  func testCountsTheLastHoursSpillover() {
    let now = Date(timeIntervalSince1970: 1_763_460_000)
    let ms = now.timeIntervalSince1970 * 1000
    XCTAssertEqual(Spillover.lastHour([ms - 2 * 3_600_000, ms - 60_000, ms], now: now), 2)
    XCTAssertEqual(Spillover.lastHour([], now: now), 0)
  }

  func testOffersOneMoreSlotWhileThereIsRoom() {
    XCTAssertEqual(Spillover.moreSlots(than: 2, memory: 0.6), 3)
    XCTAssertEqual(Spillover.moreSlots(than: 2, memory: nil), 3)
    XCTAssertNil(Spillover.moreSlots(than: 2, memory: 0.9))
    XCTAssertNil(Spillover.moreSlots(than: 8, memory: 0.2))
    XCTAssertNil(Spillover.moreSlots(than: nil, memory: 0.2))
  }

  func testWritesShortTimes() {
    XCTAssertEqual(Durations.short(45_000), "45s")
    XCTAssertEqual(Durations.short(250_000), "4m 10s")
    XCTAssertEqual(Durations.short(3_720_000), "1h 02m")
    XCTAssertEqual(Durations.clock(48), "0:48")
    XCTAssertEqual(Durations.clock(3729), "1:02:09")
    XCTAssertEqual(Durations.about(300_000), "~5m")
    XCTAssertEqual(Durations.about(4_200_000), "~1h 10m")
    XCTAssertEqual(Durations.progress(elapsed: 192, typicalMs: 300_000), "about 1:48 left")
    XCTAssertEqual(Durations.progress(elapsed: 400, typicalMs: 312_000), "usual 5:12")
    XCTAssertNil(Durations.progress(elapsed: 10, typicalMs: nil))
    let now = Date()
    XCTAssertEqual(Durations.ago(now.addingTimeInterval(-12 * 60), now: now), "12m ago")
  }

  func testTimedPauses() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/New_York")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 18, hour: 21, minute: 30))!
    XCTAssertEqual(PauseLength.oneHour.end(from: now, calendar: calendar), now.addingTimeInterval(3600))
    XCTAssertEqual(
      PauseLength.untilTomorrow.end(from: now, calendar: calendar),
      calendar.date(from: DateComponents(year: 2026, month: 11, day: 19, hour: 8))
    )
    XCTAssertNil(PauseLength.untilResumed.end(from: now, calendar: calendar))
  }

  func testShareOfTheUsualTime() {
    XCTAssertNil(Durations.share(elapsed: 10, typicalMs: nil))
    XCTAssertEqual(Durations.share(elapsed: 30, typicalMs: 60_000)?.fraction, 0.5)
    XCTAssertEqual(Durations.share(elapsed: 30, typicalMs: 60_000)?.over, false)
    XCTAssertEqual(Durations.share(elapsed: 90, typicalMs: 60_000)?.fraction, 1)
    XCTAssertEqual(Durations.share(elapsed: 90, typicalMs: 60_000)?.over, true)
  }
}
