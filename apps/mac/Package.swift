// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "RelayRunner",
  platforms: [.macOS(.v14)],
  targets: [
    // What the app reads from and says to `relayrunner connect --events`, kept apart from the UI so
    // `swift test` covers it.
    .target(name: "RelayRunnerKit"),
    .executableTarget(
      name: "RelayRunner",
      dependencies: ["RelayRunnerKit"]
    ),
    .testTarget(
      name: "RelayRunnerKitTests",
      dependencies: ["RelayRunnerKit"]
    ),
  ]
)
