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
