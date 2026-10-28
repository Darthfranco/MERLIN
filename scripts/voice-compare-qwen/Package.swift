// swift-tools-version:6.2
import PackageDescription

// Setup copies the pinned upstream sources into ignored local storage beside this manifest.
let package = Package(
    name: "MERLINVoiceCompareQwen",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "voice-compare-qwen", targets: ["VoiceCompareQwen"])],
    dependencies: [.package(url: "https://github.com/weichsel/ZIPFoundation.git", exact: "0.9.19")],
    targets: [
        .target(name: "GVoiceKit", dependencies: [.product(name: "ZIPFoundation", package: "ZIPFoundation")]),
        .target(name: "GVoiceProductionKit", dependencies: ["GVoiceKit"]),
        .target(name: "QwenANE", dependencies: ["GVoiceKit", "GVoiceProductionKit"], exclude: ["README.md"]),
        .executableTarget(name: "VoiceCompareQwen", dependencies: ["QwenANE", "GVoiceKit"]),
    ]
)
