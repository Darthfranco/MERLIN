import Foundation
import AVFoundation
import CryptoKit
import Darwin
import ChatterboxCoreML

// A persistent, sequential JSON-lines adapter. The Python setup command downloads
// model files; browser requests never download or choose another model.
let runtimeName = "Chatterbox Nano · Swift/Core ML (community port)"
let fileManager = FileManager.default
let environment = ProcessInfo.processInfo.environment
let cacheRoot = URL(fileURLWithPath: environment["HF_HOME"] ?? "local/voice-compare/chatterbox-cache")
// Third-party libraries may print diagnostics. Reserve the original stdout
// descriptor for protocol responses and route every ordinary print to stderr.
let protocolOutput = FileHandle(fileDescriptor: dup(STDOUT_FILENO), closeOnDealloc: true)
dup2(STDERR_FILENO, STDOUT_FILENO)

func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
@MainActor func emit(_ value: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
        protocolOutput.write(data)
        protocolOutput.write(Data([10]))
    } catch {
        FileHandle.standardError.write(Data("Could not serialize worker response.\n".utf8))
    }
}
@MainActor func modelDirectory() -> URL? {
    if let path = environment["MERLIN_CHATTERBOX_MODEL_DIR"] { return URL(fileURLWithPath: path) }
    return ModelRepository.existingModelDirectory(hfHome: cacheRoot, repoId: ModelRepository.defaultNanoRepoId)
}
func failure(_ reason: String) -> NSError {
    NSError(domain: "MerlinVoiceCompare", code: 1, userInfo: [NSLocalizedDescriptionKey: reason])
}
@MainActor func watermarkDirectory() throws -> URL {
    let dir = ModelRepository.downloadDirectory(hfHome: cacheRoot, repoId: ModelRepository.perthRepoId)
    guard ["mlpackage", "mlmodelc"].contains(where: {
        fileManager.fileExists(atPath: dir.appendingPathComponent("PerthEncoder.\($0)").path)
    }) else { throw failure("The local Perth watermark encoder is missing; rerun Nano setup.") }
    return dir
}
@MainActor func validatedModelDirectory() throws -> URL {
    if environment["MERLIN_CHATTERBOX_MODEL_DIR"] == nil,
       !fileManager.fileExists(atPath: cacheRoot.appendingPathComponent("installation.json").path) {
        throw failure("Nano setup has not finished verifying its model files. Run python3 scripts/voice-compare-chatterbox.py --setup.")
    }
    guard let dir = modelDirectory() else {
        throw failure("Nano model files are missing. Run python3 scripts/voice-compare-chatterbox.py --setup.")
    }
    guard ModelRepository.detectVariant(in: dir) == .nano else {
        throw failure("The configured model is not Chatterbox Nano; refusing to substitute another variant.")
    }
    for name in ["default-conds.safetensors", "speech_emb.npy", "text_emb.npy", "spkr_enc_weight.npy", "spkr_enc_bias.npy", "tokenizer.json"] {
        guard fileManager.fileExists(atPath: dir.appendingPathComponent(name).path) else {
            throw failure("Nano installation is incomplete (\(name)); rerun setup.")
        }
    }
    for name in ["T3LM", "S3Encoder", "S3CFM", "S3Vocoder"] {
        guard ["mlpackage", "mlmodelc"].contains(where: {
            fileManager.fileExists(atPath: dir.appendingPathComponent("\(name).\($0)").path)
        }) else { throw failure("Nano installation is incomplete (\(name)); rerun setup.") }
    }
    _ = try watermarkDirectory()
    return dir
}

if CommandLine.arguments.contains("--probe") {
    do { _ = try validatedModelDirectory(); emit(["available": true, "runtime": runtimeName]) }
    catch { emit(["available": false, "runtime": runtimeName, "reason": error.localizedDescription]) }
    exit(0)
}

var model: ChatterboxCoreMLModel?
var cloner: VoiceCloner?
var conditionedVoices: [String: Data] = [:]
while let line = readLine() {
    var requestID: Any = NSNull()
    do {
        guard let data = line.data(using: .utf8),
              let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw failure("Expected a JSON request object.")
        }
        requestID = request["id"] ?? NSNull()
        guard let text = request["text"] as? String,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.count <= 2000 else { throw failure("Text must contain 1–2000 characters.") }
        guard let path = request["outputPath"] as? String, path.hasPrefix("/"), path.hasSuffix(".wav") else {
            throw failure("outputPath must be an absolute WAV path.")
        }
        let directory = try validatedModelDirectory()
        var loadMs = 0.0
        if model == nil {
            let start = nowMs()
            let perthDirectory = try watermarkDirectory()
            let watermark = PerthWatermark(watermarker: try .init(modelDirectory: perthDirectory))
            model = try await ChatterboxCoreMLModel.load(from: directory, watermarker: watermark)
            loadMs = nowMs() - start
            guard model?.loadedVariant == .nano else {
                model = nil
                throw failure("Loaded model does not identify itself as Nano.")
            }
        }
        let preparationStart = nowMs()
        var voice: URL?
        defer { if let voice { try? fileManager.removeItem(at: voice) } }
        var voiceMode = "Built-in default voice (not trained or cloned)"
        if let reference = request["referencePath"] as? String, !reference.isEmpty {
            let referenceURL = URL(fileURLWithPath: reference)
            let audio = try AVAudioFile(forReading: referenceURL)
            let seconds = Double(audio.length) / audio.processingFormat.sampleRate
            guard seconds >= 10, seconds <= 120 else {
                throw failure("Nano needs a clean 10–120 second reference; 25–30 seconds is recommended.")
            }
            let bytes = try Data(contentsOf: referenceURL, options: .mappedIfSafe)
            let fingerprint = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            let voicesDirectory = URL(fileURLWithPath: path).deletingLastPathComponent()
            try fileManager.createDirectory(at: voicesDirectory, withIntermediateDirectories: true)
            let destination = voicesDirectory.appendingPathComponent("\(UUID().uuidString)-conds.safetensors")
            voice = destination
            if let cached = conditionedVoices[fingerprint] {
                try cached.write(to: destination, options: .atomic)
            } else {
                if cloner == nil { cloner = try await VoiceCloner(modelDirectory: directory) }
                try cloner!.cloneVoice(from: referenceURL, to: destination)
                conditionedVoices[fingerprint] = try Data(contentsOf: destination)
            }
            voiceMode = "Reference-conditioned voice clone (no weight training)"
        }
        let preparationMs = nowMs() - preparationStart
        let synthesisStart = nowMs()
        var samples: [Float] = []
        var firstAudioMs: Double?
        var options = GenerationOptions.default
        options.seed = 42
        for try await chunk in model!.generateStream(text, voice: voice, options: options) {
            if firstAudioMs == nil { firstAudioMs = nowMs() - synthesisStart }
            samples.append(contentsOf: chunk.samples)
        }
        let synthesisMs = nowMs() - synthesisStart
        guard !samples.isEmpty, samples.allSatisfy({ $0.isFinite }) else {
            throw failure("Nano returned empty or invalid audio.")
        }
        // Standard PCM16 WAV for consistent browser playback and inspection.
        var wav = Data()
        func appendLE<T: FixedWidthInteger>(_ value: T) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { wav.append(contentsOf: $0) }
        }
        let byteCount = UInt32(samples.count * 2)
        wav.append(Data("RIFF".utf8)); appendLE(byteCount + 36)
        wav.append(Data("WAVEfmt ".utf8)); appendLE(UInt32(16))
        appendLE(UInt16(1)); appendLE(UInt16(1)); appendLE(UInt32(24000))
        appendLE(UInt32(48000)); appendLE(UInt16(2)); appendLE(UInt16(16))
        wav.append(Data("data".utf8)); appendLE(byteCount)
        for sample in samples { appendLE(Int16(max(-1, min(1, sample)) * 32767)) }
        let output = URL(fileURLWithPath: path)
        try fileManager.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
        try wav.write(to: output, options: .atomic)
        var response: [String: Any] = [
            "id": requestID, "ok": true, "outputPath": output.path,
            "sampleRate": 24000, "durationSeconds": Double(samples.count) / 24000,
            "loadMs": loadMs, "preparationMs": preparationMs, "synthesisMs": synthesisMs,
            "runtime": runtimeName, "voiceMode": voiceMode,
        ]
        if let value = firstAudioMs { response["firstAudioMs"] = value }
        emit(response)
    } catch {
        emit(["id": requestID, "ok": false, "error": error.localizedDescription])
    }
}
