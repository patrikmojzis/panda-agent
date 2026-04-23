// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "PandaReceiverMacOS",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(
            name: "panda-receiver-macos",
            targets: ["PandaReceiverMacOS"]
        ),
    ],
    targets: [
        .executableTarget(
            name: "PandaReceiverMacOS",
            path: "Sources/PandaReceiverMacOS"
        ),
        .testTarget(
            name: "PandaReceiverMacOSTests",
            dependencies: ["PandaReceiverMacOS"],
            path: "Tests/PandaReceiverMacOSTests"
        ),
    ]
)
