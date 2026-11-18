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

  func testReadsTheHistoryFileNewestFirst() throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("history-\(UUID()).jsonl")
    defer { try? FileManager.default.removeItem(at: file) }
    let second = line.replacingOccurrences(of: #""routeId":"r1""#, with: #""routeId":"r2""#)
    try (line + "\nnot json\n" + second + "\n").write(to: file, atomically: true, encoding: .utf8)
    let entries = History.read(file)
    XCTAssertEqual(entries.map(\.routeId), ["r2", "r1"])
    XCTAssertEqual(History.read(file, limit: 1).map(\.routeId), ["r2"])
    XCTAssertEqual(History.read(file.appendingPathExtension("missing")), [])

    let again = HistoryEntry(routeId: "r1", startedAtMs: 0, durationMs: 1)
    XCTAssertEqual(History.adding(again, to: entries).map(\.routeId), ["r1", "r2"])
  }

  func testSumsUpTheDay() {
    let calendar = Calendar(identifier: .gregorian)
    let now = Date(timeIntervalSince1970: 1_763_460_000)
    let ms = now.timeIntervalSince1970 * 1000
    let entries = [
      HistoryEntry(routeId: "a", result: "Succeeded", startedAtMs: ms - 600_000, durationMs: 250_000),
      HistoryEntry(routeId: "b", result: "Failed", startedAtMs: ms - 300_000, durationMs: 100_000),
      HistoryEntry(routeId: "c", result: "Succeeded", startedAtMs: ms - 3 * 86_400_000, durationMs: 100_000),
    ]
    XCTAssertEqual(History.day(entries, of: now, calendar: calendar), .init(jobs: 2, busyMs: 350_000, failed: 1))
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
}
