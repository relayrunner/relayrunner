import Foundation
import RelayRunnerKit
import XCTest

final class CrashReportTests: XCTestCase {
  // A trimmed macOS crash report: the header line, then the report.
  private func ips(
    path: String = "/Applications/RelayRunner.app/Contents/MacOS/RelayRunner",
    bugType: String = "309"
  ) -> Data {
    let header = #"{"app_name":"RelayRunner","timestamp":"2026-11-23 14:02:12.00 -0800","app_version":"0.6.0","bug_type":"\#(bugType)","os_version":"macOS 15.1 (24B83)","bundleID":"app.relayrunner.mac","incident_id":"8C1F0E7A-0000-0000-0000-000000000000","name":"RelayRunner"}"#
    let body = #"""
      {
        "uptime": 12345,
        "userID": 501,
        "modelCode": "Mac15,3",
        "captureTime": "2026-11-23 14:02:11.8123 -0800",
        "procName": "RelayRunner",
        "procPath": "\#(path)",
        "bundleInfo": {"CFBundleShortVersionString": "0.6.0", "CFBundleIdentifier": "app.relayrunner.mac"},
        "crashReporterKey": "A1B2C3D4-SECRET-KEY",
        "sleepWakeUUID": "2F0E5D7C-0000-0000-0000-000000000000",
        "exception": {"codes": "0x1, 0x0", "type": "EXC_BREAKPOINT", "signal": "SIGTRAP"},
        "termination": {"namespace": "SIGNAL", "indicator": "Trace/BPT trap: 5", "byProc": "exc handler"},
        "asi": {"libswiftCore.dylib": ["/Users/someone/Code/relayrunner/apps/mac/Sources/RelayRunner/Connection.swift:120: Fatal error: Unexpectedly found nil"]},
        "faultingThread": 0,
        "threads": [
          {"triggered": true, "queue": "com.apple.main-thread", "frames": [
            {"imageOffset": 4660, "symbol": "Connection.handle(_:)", "symbolLocation": 44, "imageIndex": 0},
            {"imageOffset": 12345, "imageIndex": 0},
            {"imageOffset": 999, "symbol": "_dispatch_call_block_and_release", "symbolLocation": 32, "imageIndex": 1}
          ]},
          {"name": "other", "frames": [{"imageOffset": 1, "symbol": "secret_other_thread", "imageIndex": 1}]}
        ],
        "usedImages": [
          {"name": "RelayRunner", "path": "/Users/someone/Applications/RelayRunner.app/Contents/MacOS/RelayRunner"},
          {"name": "libdispatch.dylib", "path": "/usr/lib/system/libdispatch.dylib"}
        ]
      }
      """#
    return Data((header + "\n" + body).utf8)
  }

  func testKeepsWhatHelpsAndNothingAboutThePerson() throws {
    let report = try XCTUnwrap(CrashReport(ips: ips()))
    XCTAssertEqual(report.origin, .app)
    XCTAssertEqual(report.summary, "RelayRunner for Mac 0.6.0 crashed: EXC_BREAKPOINT (SIGTRAP)")
    XCTAssertEqual(
      report.text,
      """
      RelayRunner for Mac 0.6.0 crashed: EXC_BREAKPOINT (SIGTRAP)

      Process: the app
      macOS: 15.1 (24B83)
      Mac: Mac15,3
      When: 2026-11-23 22:02 UTC
      Exception: EXC_BREAKPOINT (SIGTRAP)
      Reason: Trace/BPT trap: 5
      Message: ~/Code/relayrunner/apps/mac/Sources/RelayRunner/Connection.swift:120: Fatal error: Unexpectedly found nil

      Crashed thread (com.apple.main-thread):
      0  RelayRunner        Connection.handle(_:) + 44
      1  RelayRunner        0x3039
      2  libdispatch.dylib  _dispatch_call_block_and_release + 32
      """
    )
    for secret in ["someone", "A1B2C3D4", "2F0E5D7C", "8C1F0E7A", "501", "secret_other_thread"] {
      XCTAssertFalse(report.text.contains(secret), secret)
    }
  }

  func testTheBundledCLI() throws {
    let report = try XCTUnwrap(
      CrashReport(ips: ips(path: "/Applications/RelayRunner.app/Contents/Helpers/relayrunner")))
    XCTAssertEqual(report.origin, .cli)
    XCTAssertEqual(report.summary, "RelayRunner for Mac 0.6.0: the bundled CLI crashed: EXC_BREAKPOINT (SIGTRAP)")
  }

  func testSkipsOtherProcessesHangsAndJunk() {
    XCTAssertNil(CrashReport(ips: ips(path: "/opt/homebrew/lib/node_modules/relayrunner/bin/relayrunner")))
    XCTAssertNil(CrashReport(ips: ips(bugType: "298")))
    XCTAssertNil(CrashReport(ips: Data("not a report".utf8)))
  }

  func testFindsNewReportsOnly() throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let old = folder.appendingPathComponent("RelayRunner-2026-11-20-100000.ips")
    let new = folder.appendingPathComponent("RelayRunner-2026-11-23-140212.ips")
    try ips().write(to: old)
    try ips().write(to: new)
    try ips().write(to: folder.appendingPathComponent("Safari-2026-11-23-140212.ips"))
    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSinceNow: -7200)], ofItemAtPath: old.path)
    XCTAssertEqual(CrashReport.find(in: folder, since: Date(timeIntervalSinceNow: -3600)).count, 1)
  }
}
