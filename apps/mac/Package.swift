// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "RelayRunner",
  platforms: [.macOS(.v14)],
  targets: [
    // What the app reads from and says to `relayrunner connect --events`, kept apart from the UI so
    // `swift test` covers it.
    .target(name: "RelayRunnerKit", swiftSettings: [.swiftLanguageMode(.v5)]),
    .executableTarget(
      name: "RelayRunner",
      dependencies: ["RelayRunnerKit"],
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    .testTarget(
      name: "RelayRunnerKitTests",
      dependencies: ["RelayRunnerKit"],
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
  ]
)
