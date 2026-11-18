import Foundation
import RelayRunnerKit
import XCTest

final class GatewayJobsTests: XCTestCase {
  func testReadsAPageOfJobs() throws {
    let json = """
      {"jobs":[{"id":7,"name":"test","workflow":"CI","repo":"acme/app",
      "url":"https://github.com/acme/app/actions/runs/3/job/7","runId":3,"runAttempt":1,
      "conclusion":"failure","failedStep":"3. Run tests","queuedAt":1000,"startedAt":6000,"completedAt":66000}],
      "next":66000}
      """
    let page = try XCTUnwrap(GatewayJobPage.parse(Data(json.utf8)))
    let job = try XCTUnwrap(page.jobs.first)
    XCTAssertEqual(job.outcome, .failed)
    XCTAssertEqual(job.waitedMs, 5000)
    XCTAssertEqual(job.ranMs, 60000)
    XCTAssertEqual(job.shortRepo, "app")
    XCTAssertEqual(page.next, 66000)
    XCTAssertTrue(job.matches("ACME"))
    XCTAssertTrue(job.matches(" ci "))
    XCTAssertFalse(job.matches("lint"))
  }

  func testAddsAnOlderPageWithoutRepeats() {
    let url = URL(string: "https://github.com")!
    let first = GatewayJobPage(jobs: [GatewayJob(id: 1, name: "a", repo: "r", url: url)], next: 10)
    let older = GatewayJobPage(
      jobs: [GatewayJob(id: 1, name: "a", repo: "r", url: url), GatewayJob(id: 2, name: "b", repo: "r", url: url)],
      next: nil)
    let both = first.adding(older)
    XCTAssertEqual(both.jobs.map(\.id), [1, 2])
    XCTAssertNil(both.next)
  }

  func testReadsADetailWithItsFailure() throws {
    let json = """
      {"job":{"id":7,"name":"test","workflow":null,"repo":"acme/app",
      "url":"https://github.com/acme/app/actions/runs/3/job/7","runId":3,"runAttempt":2,
      "conclusion":"failure","failedStep":null,"queuedAt":null,"startedAt":null,"completedAt":null},
      "steps":[{"number":1,"name":"Set up job","status":"completed","conclusion":"success","startedAt":0,"completedAt":2000}],
      "failure":{"id":7,"name":"test","conclusion":"failure","runner":"self-hosted","runnerFailed":false,
      "failedStep":"3. Run tests","annotations":["exit code 1"],"log":["ok","##[error]boom"],
      "cause":{"kind":"flaky","confidence":0.8,"passesOnRerun":0.9,"rerun":"passes"}}}
      """
    let detail = try XCTUnwrap(GatewayJobDetail.parse(Data(json.utf8)))
    XCTAssertEqual(detail.steps?.first?.durationMs, 2000)
    XCTAssertEqual(detail.failure?.annotations, ["exit code 1"])
    XCTAssertEqual(
      detail.failure?.cause?.summary, "Likely something intermittent (80% sure). A re-run will probably pass.")
    XCTAssertEqual(LogLine("##[error]boom"), LogLine("boom").with(error: true))
  }

  func testReadsADetailWithoutStepsOrFailure() throws {
    let json = """
      {"job":{"id":7,"name":"test","repo":"acme/app","url":"https://github.com/acme/app/actions/runs/3/job/7",
      "runId":3,"runAttempt":1,"conclusion":"success"},"steps":null,"failure":null}
      """
    let detail = try XCTUnwrap(GatewayJobDetail.parse(Data(json.utf8)))
    XCTAssertNil(detail.steps)
    XCTAssertNil(detail.failure)
    XCTAssertEqual(detail.job.waitedMs, 0)
  }

  func testPlacesStepsOnTheJobsTimeline() {
    let steps = [
      JobStep(number: 1, name: "Set up", startedAt: 0, completedAt: 1000),
      JobStep(number: 2, name: "Test", startedAt: 1000, completedAt: 10000),
      JobStep(number: 3, name: "Never ran", conclusion: "skipped"),
      JobStep(number: 4, name: "Post", startedAt: 10000, completedAt: 10000),
    ]
    let bars = StepTimeline.bars(steps)
    XCTAssertEqual(bars[0], StepTimeline.Bar(start: 0, width: 0.1))
    XCTAssertEqual(bars[1], StepTimeline.Bar(start: 0.1, width: 0.9))
    XCTAssertNil(bars[2])
    XCTAssertEqual(bars[3]?.start, 1)
    XCTAssertEqual(bars[3]?.width, 0)
    XCTAssertEqual(StepTimeline.bars([JobStep(number: 1, name: "x")]), [nil])
  }
}

extension LogLine {
  fileprivate func with(error: Bool) -> LogLine {
    var line = self
    line.isError = error
    return line
  }
}
