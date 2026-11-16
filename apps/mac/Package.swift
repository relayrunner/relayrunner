// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "RelayRunner",
  platforms: [.macOS(.v14)],
  dependencies: [
    // Updates. Keep in step with scripts/setup-sparkle.sh, which fetches the same version's
    // framework (embedded in the app) and its signing tools.
    .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.9.4"),
  ],
  targets: [
    // What the app reads from and says to `relayrunner connect --events`, kept apart from the UI so
    // `swift test` covers it.
    .target(name: "RelayRunnerKit"),
    .executableTarget(
      name: "RelayRunner",
      dependencies: ["RelayRunnerKit", .product(name: "Sparkle", package: "Sparkle")],
      // build-app.sh puts Sparkle.framework in Contents/Frameworks.
      linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
    ),
    .testTarget(
      name: "RelayRunnerKitTests",
      dependencies: ["RelayRunnerKit"]
    ),
  ]
)
