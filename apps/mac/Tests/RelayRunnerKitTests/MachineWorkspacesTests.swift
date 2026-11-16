import Foundation
import RelayRunnerKit
import XCTest

final class MachineWorkspacesTests: XCTestCase {
  func testReadsTheCLIsJSON() throws {
    let json = #"""
      {
        "machine": { "id": "m1", "name": "Mac", "sharing": "only_me" },
        "workspaces": [{ "id": "w2", "name": "beta", "slug": "beta", "logo": "https://avatars.githubusercontent.com/u/1?v=4" }],
        "others": [{ "id": "w1", "name": "Acme", "slug": null }]
      }
      """#
    let parsed = try XCTUnwrap(MachineWorkspaces.parse(Data(json.utf8)))
    XCTAssertEqual(parsed.machine.sharing, .onlyMe)
    XCTAssertEqual(parsed.machine.sharing.argument, "only-me")
    XCTAssertEqual(parsed.all.map(\.workspace.id), ["w1", "w2"])
    XCTAssertEqual(parsed.all.map(\.on), [false, true])
    XCTAssertEqual(parsed.all.map(\.workspace.logo?.host), [nil, "avatars.githubusercontent.com"])
  }

  func testRefusesSomethingElse() {
    XCTAssertNil(MachineWorkspaces.parse(Data("Not signed in.".utf8)))
  }
}
