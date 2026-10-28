import AVFoundation
import CryptoKit
import Darwin
import FluidAudio
import Foundation

// Native companion to the Python JSON-lines launcher. ModelHub is offline during
// all inference; the setup script installs the public FluidInference conversion.
@main
struct PocketWorker {
    static let runtime = "Pocket TTS 100M / FluidAudio CoreML fp16 / automatic placement"

    static func main() async {
        let protocolOutput = FileHandle(fileDescriptor: dup(STDOUT_FILENO), closeOnDealloc: true)
        dup2(STDERR_FILENO, STDOUT_FILENO)
        func emit(_ object: [String: Any]) {
            if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
                protocolOutput.write(data)
                protocolOutput.write(Data([10]))
            }
        }
        let rootPath = ProcessInfo.processInfo.environment["MERLIN_POCKET_ROOT"] ?? FileManager.default.currentDirectoryPath
        let local = URL(fileURLWithPath: rootPath).appendingPathComponent("local/voice-compare")
        let cache = local.appendingPathComponent("pocket-coreml-models")
        ModelHub.offlineMode = true
        var manager: PocketTtsManager?
        var cachedReference: (digest: SHA256.Digest, voice: PocketTtsVoiceData)?
        while let line = readLine() {
            var requestID: Any = NSNull()
            do {
                guard line.utf8.count <= 32000,
                    let data = line.data(using: .utf8),
                    let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                    let id = request["id"] as? String
                else { throw WorkerError.invalid("Request must contain a string id.") }
                requestID = id
                guard let rawText = request["text"] as? String else {
                    throw WorkerError.invalid("Text is required.")
                }
                let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty, text.count <= 2000 else {
                    throw WorkerError.invalid("Text must contain between 1 and 2000 characters.")
                }
                guard let path = request["outputPath"] as? String else {
                    throw WorkerError.invalid("An outputPath is required.")
                }
                let output = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
                let localPath = local.standardizedFileURL.resolvingSymlinksInPath().path + "/"
                guard output.path.hasPrefix(localPath), output.pathExtension.lowercased() == "wav" else {
                    throw WorkerError.invalid("Output must be a WAV inside local/voice-compare.")
                }
                var reference: URL?
                if let value = request["referencePath"], !(value is NSNull) {
                    guard let path = value as? String, !path.isEmpty else {
                        throw WorkerError.invalid("Reference path must identify a local audio file.")
                    }
                    let url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
                    guard url != output,
                        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                        size <= 20 * 1024 * 1024
                    else { throw WorkerError.invalid("Reference audio is missing, too large, or matches the output path.") }
                    let audio = try AVAudioFile(forReading: url)
                    let duration = Double(audio.length) / audio.processingFormat.sampleRate
                    guard duration >= 1, duration <= 30 else {
                        throw WorkerError.invalid("Pocket reference audio must last between 1 and 30 seconds.")
                    }
                    reference = url
                }
                var loadMS = 0.0
                if manager == nil {
                    let started = DispatchTime.now().uptimeNanoseconds
                    let candidate = PocketTtsManager(directory: cache, precision: .fp16)
                    try await candidate.initialize()
                    manager = candidate
                    loadMS = elapsedMS(started)
                }
                guard let manager else { throw WorkerError.invalid("Pocket model did not initialize.") }
                let prepStarted = DispatchTime.now().uptimeNanoseconds
                let voiceData: PocketTtsVoiceData?
                if let reference {
                    let digest = SHA256.hash(data: try Data(contentsOf: reference))
                    if let cachedReference, cachedReference.digest == digest {
                        voiceData = cachedReference.voice
                    } else {
                        let encoded = try await manager.cloneVoice(from: reference)
                        cachedReference = (digest, encoded)
                        voiceData = encoded
                    }
                } else {
                    voiceData = nil
                }
                let prepMS = elapsedMS(prepStarted)
                let synthStarted = DispatchTime.now().uptimeNanoseconds
                let audio: Data
                if let voiceData {
                    audio = try await manager.synthesize(text: text, voiceData: voiceData, deEss: false)
                } else {
                    audio = try await manager.synthesize(text: text, voice: "alba", deEss: false)
                }
                let synthMS = elapsedMS(synthStarted)
                try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
                try audio.write(to: output, options: [.atomic])
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
                let wav = try AVAudioFile(forReading: output)
                let duration = Double(wav.length) / wav.processingFormat.sampleRate
                guard duration > 0, duration <= 240 else {
                    try? FileManager.default.removeItem(at: output)
                    throw WorkerError.invalid("Pocket generated invalid audio duration.")
                }
                emit([
                    "id": id, "ok": true, "outputPath": output.path,
                    "sampleRate": Int(wav.processingFormat.sampleRate), "durationSeconds": duration,
                    "loadMs": loadMS, "preparationMs": prepMS, "synthesisMs": synthMS,
                    "runtime": runtime, "voiceMode": reference == nil ? "builtin-alba" : "reference-clone",
                ])
            } catch {
                emit(["id": requestID, "ok": false, "error": error.localizedDescription])
            }
        }
    }

    static func elapsedMS(_ start: UInt64) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
    }

    enum WorkerError: LocalizedError {
        case invalid(String)
        var errorDescription: String? {
            switch self { case .invalid(let value): return value }
        }
    }
}
