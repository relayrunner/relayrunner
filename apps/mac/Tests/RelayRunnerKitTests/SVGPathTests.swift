import RelayRunnerKit
import XCTest

final class SVGPathTests: XCTestCase {
  private typealias P = SVGPath.Point

  func testReadsRelativeCommandsAndPackedNumbers() {
    XCTAssertEqual(
      SVGPath.parse("m12 8 2.5-.5 2.5 6-2.5.5z"),
      [.move(P(12, 8)), .line(P(14.5, 7.5)), .line(P(17, 13.5)), .line(P(14.5, 14)), .close]
    )
  }

  func testReadsAbsoluteCurvesAndLines() {
    XCTAssertEqual(
      SVGPath.parse("M3 18q0-2.5 2-3.5L10 12Q1 2 3 4v2h-1Z"),
      [
        .move(P(3, 18)), .quad(P(3, 15.5), to: P(5, 14.5)), .line(P(10, 12)),
        .quad(P(1, 2), to: P(3, 4)), .line(P(3, 6)), .line(P(2, 6)), .close,
      ]
    )
  }

  func testReadsEveryPathOfTheRobotHead() {
    for layer in RobotHead.color + RobotHead.template { XCTAssertNotNil(SVGPath.parse(layer.d), layer.d) }
  }

  func testRefusesWhatItDoesNotCover() {
    XCTAssertNil(SVGPath.parse("M0 0a1 1 0 0 0 2 2"))
    XCTAssertNil(SVGPath.parse("0 0"))
  }
}
