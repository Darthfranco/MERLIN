// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MerlinChatterboxComparison",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/iliasaz/chatterbox-coreml.git",
                 revision: "b8288834e783f3a6210757fbaf62f9014220bff9"),
    ],
    targets: [
        .executableTarget(name: "merlin-chatterbox-worker", dependencies: [
            .product(name: "ChatterboxCoreML", package: "chatterbox-coreml"),
        ]),
    ]
)
