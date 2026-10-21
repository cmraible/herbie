// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "HerbieCore",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [.library(name: "HerbieCore", targets: ["HerbieCore"])],
  targets: [
    .target(name: "HerbieCore", path: "Herbie/Core"),
    .testTarget(name: "HerbieCoreTests", dependencies: ["HerbieCore"], path: "Tests"),
  ]
)
