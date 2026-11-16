import Foundation
import RelayRunnerKit
import XCTest

final class MachineWorkspacesTests: XCTestCase {
  func testReadsTheCLIsJSON() throws {
    let json = #"""
      {
        "machine": { "id": "m1", "name": "Mac", "sharing": "only_me" },
        "workspaces": [{ "id": "w2", "name": "beta", "slug": "beta" }],
        "others": [{ "id": "w1", "name": "Acme", "slug": null }]
      }
      """#
    let parsed = try XCTUnwrap(MachineWorkspaces.parse(Data(json.utf8)))
    XCTAssertEqual(parsed.machine.sharing, .onlyMe)
    XCTAssertEqual(parsed.machine.sharing.argument, "only-me")
    XCTAssertEqual(parsed.all.map(\.workspace.id), ["w1", "w2"])
    XCTAssertEqual(parsed.all.map(\.on), [false, true])
  }

  func testRefusesSomethingElse() {
    XCTAssertNil(MachineWorkspaces.parse(Data("Not signed in.".utf8)))
  }
}
