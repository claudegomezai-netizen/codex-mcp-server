// swift-tools-version: 6.0
import PackageDescription

// IronholdCore is deliberately free of SpriteKit/UIKit so the whole simulation
// — combat, economy, wave pacing — can be built and tested on any platform.
// The iOS app in Ironhold/ is a thin rendering layer on top of it.
let package = Package(
    name: "IronholdCore",
    products: [
        .library(name: "IronholdCore", targets: ["IronholdCore"])
    ],
    targets: [
        .target(name: "IronholdCore"),
        // Balance inspector: `swift run IronholdTune`.
        .executableTarget(name: "IronholdTune", dependencies: ["IronholdCore"]),
        .testTarget(name: "IronholdCoreTests", dependencies: ["IronholdCore"]),
    ]
)
