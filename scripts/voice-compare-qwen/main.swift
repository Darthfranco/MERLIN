import Foundation
import CryptoKit
import QwenANE
import GVoiceKit

let runtimeName = "Swift Core ML; talker CPU/GPU, code predictor CPU/ANE"
let modelDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
var engine: QwenANEEngine?
var cachedVoice: QwenVoiceFiles?
var cachedVoiceKey: String?

func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
func emit(_ object: [String: Any]) {
    if let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(bytes)
        FileHandle.standardOutput.write(Data([10]))
    }
}
func invalid(_ message: String) -> NSError {
    NSError(domain: "MERLINVoiceCompareQwen", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

func writeWAV(_ samples: [Float], sampleRate: Int, to output: URL) throws {
    guard !samples.isEmpty, samples.allSatisfy(\.isFinite), samples.count <= sampleRate * 180 else {
        throw invalid("Qwen returned invalid or excessively long audio.")
    }
    var data = Data()
    func ascii(_ value: String) { data.append(contentsOf: value.utf8) }
    func uint16(_ value: UInt16) { var little = value.littleEndian; withUnsafeBytes(of: &little) { data.append(contentsOf: $0) } }
    func uint32(_ value: UInt32) { var little = value.littleEndian; withUnsafeBytes(of: &little) { data.append(contentsOf: $0) } }
    ascii("RIFF"); uint32(UInt32(36 + samples.count * 2)); ascii("WAVEfmt "); uint32(16)
    uint16(1); uint16(1); uint32(UInt32(sampleRate)); uint32(UInt32(sampleRate * 2)); uint16(2); uint16(16)
    ascii("data"); uint32(UInt32(samples.count * 2))
    for sample in samples { uint16(UInt16(bitPattern: Int16((min(1, max(-1, sample)) * 32767).rounded()))) }
    try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: output, options: .atomic)
}

while let line = readLine() {
    var requestID: Any = NSNull()
    do {
        guard let bytes = line.data(using: .utf8),
              let request = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw invalid("Expected a JSON object.")
        }
        requestID = request["id"] ?? NSNull()
        guard let text = request["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.count <= 2000, let outputPath = request["outputPath"] as? String, outputPath.hasPrefix("/") else {
            throw invalid("Provide 1–2000 characters and an absolute outputPath.")
        }
        guard let referencePath = request["referencePath"] as? String, referencePath.hasPrefix("/"),
              let referenceText = request["referenceText"] as? String,
              !referenceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, referenceText.count <= 4000 else {
            throw invalid("Qwen Base needs a reference recording and its exact transcript; it has no preset voice.")
        }
        let referenceURL = URL(fileURLWithPath: referencePath)
        let attributes = try FileManager.default.attributesOfItem(atPath: referencePath)
        guard let size = attributes[.size] as? NSNumber, size.intValue <= 20 * 1024 * 1024 else {
            throw invalid("Reference recording must be at most 20 MB.")
        }
        let reference = try Data(contentsOf: referenceURL)
        let hash = "reference-standard-v1\u{1f}" + SHA256.hash(data: reference).map { String(format: "%02x", $0) }.joined() + "\u{1f}" + referenceText
        var loadMs = 0.0
        if engine == nil {
            let start = now()
            engine = try QwenANEEngine(modelsDirectory: modelDirectory)
            loadMs = now() - start
        }
        var preparationMs = 0.0
        if cachedVoiceKey != hash || cachedVoice == nil {
            let start = now()
            let preparedReference = ReferenceStandard.applied(to: reference)
            cachedVoice = try QwenVoicePrep.prepare(referenceWAV: preparedReference, transcript: referenceText, modelsDirectory: modelDirectory)
            cachedVoiceKey = hash
            preparationMs = now() - start
        }
        let session = QwenTalkSession(engine: engine!, voice: cachedVoice!, language: "en", seed: 7, seedText: text)
        let synthesisStart = now()
        let rendered = try session.renderBreak(text)
        let synthesisMs = now() - synthesisStart
        guard !rendered.parts.contains(where: { $0.stopReason == .maxTokens || $0.stopReason == .contextFull || $0.stopReason == .cancelled }) else {
            throw invalid("Qwen stopped before finishing this text; try a shorter sentence or a clearer reference.")
        }
        try writeWAV(rendered.samples, sampleRate: rendered.sampleRate, to: URL(fileURLWithPath: outputPath))
        emit(["id": requestID, "ok": true, "outputPath": outputPath, "sampleRate": rendered.sampleRate,
              "durationSeconds": Double(rendered.samples.count) / Double(rendered.sampleRate),
              "loadMs": loadMs, "preparationMs": preparationMs, "synthesisMs": synthesisMs,
              "runtime": runtimeName, "voiceMode": "reference-clone", "seed": 7,
              "referencePreparation": "Upstream ReferenceStandard: tail cleanup and loudness normalization",
              "takes": rendered.parts.map(\.takes).reduce(0, +)])
    } catch {
        emit(["id": requestID, "ok": false, "error": error.localizedDescription])
    }
}
