import Foundation
import RelayRunnerKit
import XCTest

final class EventTests: XCTestCase {
  private func parse(_ line: String) -> Event? { Event.parse(Data(line.utf8)) }

  func testParsesTheEventsTheAppUses() {
    XCTAssertEqual(
      parse(#"{"v":1,"at":"2026-11-16T18:16:23.281Z","type":"machine","id":"m1","name":"M3P0","server":"https://app.relayrunner.dev"}"#),
      .machine(id: "m1", name: "M3P0", server: URL(string: "https://app.relayrunner.dev")!)
    )
    XCTAssertEqual(
      parse(#"{"v":1,"at":"x","type":"state","link":"online","paused":true,"jobs":["r1"]}"#),
      .state(.init(link: .online, paused: true, jobs: ["r1"]))
    )
    XCTAssertEqual(
      parse(#"{"v":1,"at":"x","type":"state","link":"online","paused":false,"jobs":[],"waiting":3,"slots":2}"#),
      .state(.init(link: .online, paused: false, jobs: [], waiting: 3, slots: 2))
    )
    XCTAssertEqual(
      parse(
        #"{"v":1,"at":"x","type":"state","link":"online","paused":false,"jobs":[],"waiting":1,"queue":[{"repo":"acme/app","since":1763481600000,"name":"test","workflow":"CI"}],"spilled":[1763481000000],"slots":2}"#
      ),
      .state(
        .init(
          link: .online, paused: false, jobs: [], waiting: 1, spilled: [1_763_481_000_000], slots: 2))
    )
    XCTAssertEqual(
      parse(#"{"v":1,"at":"x","type":"sign-in","url":"https://app.relayrunner.dev/device?user_code=AB","code":"AB"}"#),
      .signIn(url: URL(string: "https://app.relayrunner.dev/device?user_code=AB")!, code: "AB")
    )
    XCTAssertEqual(
      parse(#"{"v":1,"at":"x","type":"job-repo","routeId":"r1","repo":"acme/api"}"#),
      .jobRepo(routeId: "r1", repo: "acme/api")
    )
    XCTAssertEqual(
      parse(#"{"v":1,"at":"x","type":"job-result","routeId":"r1","job":"test","result":"Failed"}"#),
      .jobResult(routeId: "r1", job: "test", result: "Failed")
    )
    XCTAssertEqual(parse(#"{"v":1,"at":"x","type":"offline","reason":"stopped"}"#), .offline(reason: "stopped", message: nil))
    XCTAssertEqual(
      parse(#"{"v":1,"at":"x","type":"error","code":"UNKNOWN_COMMAND","message":"m","command":"bogus"}"#),
      .error(code: "UNKNOWN_COMMAND", message: "m", command: "bogus")
    )
  }

  /// The lines the CLI writes (apps/cli/fixtures/events.jsonl, checked against the CLI by its
  /// events.rs tests), read the way the app reads them.
  func testReadsTheLinesTheCLIWrites() throws {
    let fixture = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("../../../cli/fixtures/events.jsonl")
    let lines = try String(contentsOf: fixture, encoding: .utf8)
      .split(separator: "\n")
      .map { Event.parse(Data($0.utf8)) }
    let job = RunJob(
      name: "test", workflow: "CI", repo: "acme/app",
      url: URL(string: "https://github.com/acme/app/actions/runs/1/job/2")!,
      runAttempt: 1, typicalMs: 150_000)
    let expected: [Event?] = [
      .signIn(url: URL(string: "https://app.relayrunner.dev/device?user_code=ABCD-EFGH")!, code: "ABCD-EFGH"),
      .machine(id: "m1", name: "ada-mbp", server: URL(string: "https://app.relayrunner.dev/")!),
      .other(type: "connecting"),
      .other(type: "connected"),
      .state(.init(link: .online, paused: false, jobs: [], slots: 2)),
      .other(type: "waiting"),
      .state(
        .init(
          link: .online, paused: true, jobs: ["r1"], waiting: 1, spilled: [1_763_481_000_000],
          slots: 2)),
      .other(type: "paused"),
      .run(routeId: "r1", slot: 1, job: job),
      .run(routeId: "r2", slot: 2, job: nil),
      .jobRepo(routeId: "r1", repo: "acme/app"),
      .other(type: "job"),
      .jobResult(routeId: "r1", job: "test", result: "Failed"),
      .other(type: "job-end"),
      .other(type: "disconnected"),
      .offline(reason: "stopped", message: nil),
      .offline(reason: "rejected", message: "This machine was removed from the workspace."),
      .error(code: "NOT_SIGNED_IN", message: "Sign in first.", command: nil),
      .error(code: "UNKNOWN_COMMAND", message: "Commands are `pause` and `resume`.", command: "bogus"),
    ]
    XCTAssertEqual(lines.count, expected.count)
    for (index, (read, want)) in zip(lines, expected).enumerated() {
      XCTAssertEqual(read, want, "line \(index + 1)")
    }
  }

  func testPassesOverConnectionEventsAndSkipsWhatItCantRead() {
    XCTAssertEqual(parse(#"{"v":1,"at":"x","type":"connected"}"#), .other(type: "connected"))
    XCTAssertNil(parse(#"{"v":2,"at":"x","type":"connected"}"#))
    XCTAssertNil(parse("Online. Waiting for jobs."))
    XCTAssertNil(parse(#"{"v":1,"at":"x","type":"state","link":"sideways","paused":false,"jobs":[]}"#))
  }

  func testLaunchArguments() {
    XCTAssertEqual(LaunchOptions().arguments, ["connect", "--events"])
    XCTAssertEqual(
      LaunchOptions(concurrency: 2, cpus: 4, memoryGB: 8, macOSJobs: true, localNetwork: true, share: .anyone).arguments,
      ["connect", "--events", "--concurrency", "2", "--cpus", "4", "--memory", "8", "--macos", "--local-network", "--share", "anyone"]
    )
  }
}
