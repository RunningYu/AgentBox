import AVFoundation
import Foundation
import Speech

struct SpeechMessage: Codable {
    let kind: String
    let text: String?
    let message: String?
    let isFinal: Bool?
}

struct SpeechHelperError: LocalizedError {
    let message: String

    var errorDescription: String? { message }
}

final class SpeechSession: @unchecked Sendable {
    private let recognizer: SFSpeechRecognizer
    private let locale: Locale
    private let audioEngine = AVAudioEngine()
    private var audioFile: AVAudioFile?
    private var audioFrameCount: AVAudioFramePosition = 0
    private var audioWriteError: String?
    private var audioURL: URL?
    private var task: SFSpeechRecognitionTask?
    private var stopping = false
    private var stoppedEmitted = false
    private let outputLock = NSLock()
    private let audioLock = NSLock()
    private let diagnosticLock = NSLock()

    init(locale: String) {
        let requestedLocale = Locale(identifier: locale)
        self.locale = requestedLocale
        recognizer = SFSpeechRecognizer(locale: requestedLocale) ?? SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))!
    }

    func emit(kind: String, text: String? = nil, message: String? = nil, isFinal: Bool? = nil) {
        let payload = SpeechMessage(kind: kind, text: text, message: message, isFinal: isFinal)
        guard let data = try? JSONEncoder().encode(payload) else { return }
        outputLock.lock()
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
        fflush(stdout)
        outputLock.unlock()
    }

    private func diagnose(_ stage: String, _ detail: String = "") {
        let suffix = detail.isEmpty ? "" : " \(detail)"
        let line = "\(Date().ISO8601Format()) [\(stage)]\(suffix)\n"
        guard let data = line.data(using: .utf8) else { return }
        diagnosticLock.lock()
        defer { diagnosticLock.unlock() }
        FileHandle.standardError.write(data)
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/AgentBox", isDirectory: true)
        let url = directory.appendingPathComponent("speech.log")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: url.path) {
                FileManager.default.createFile(atPath: url.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: url)
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            try handle.close()
        } catch {
            // stderr remains available to the parent process when file logging fails.
        }
    }

    func start() {
        diagnose("start", "locale=\(locale.identifier)")
        if #available(macOS 26.0, *) {
            requestMicrophonePermission()
            return
        }
        requestLegacySpeechAuthorization()
    }

    private func requestLegacySpeechAuthorization() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                self.diagnose("speech_authorization", "status=\(status.rawValue)")
                guard status == .authorized else {
                    self.emit(kind: "error", message: "macOS 语音识别权限未授权，请在系统设置的隐私与安全性中允许语音识别")
                    return
                }
                self.requestMicrophonePermission()
            }
        }
    }

    private func requestMicrophonePermission() {
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                self.diagnose("microphone_authorization", "granted=\(granted)")
                guard granted else {
                    self.emit(kind: "error", message: "麦克风权限未授权，请在系统设置的隐私与安全性中允许 AgentBox 使用麦克风")
                    return
                }
                self.beginRecognition()
            }
        }
    }

    private func beginRecognition() {
        guard !stopping else { return }
        if #unavailable(macOS 26.0), !recognizer.isAvailable {
            emit(kind: "error", message: "当前 macOS 语音识别服务不可用，请确认系统语音识别语言已安装并重试")
            return
        }
        let inputNode = audioEngine.inputNode
        let recordingURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentbox-speech-\(UUID().uuidString).caf")
        let format = inputNode.outputFormat(forBus: 0)
        diagnose("recording_prepare", "sampleRate=\(format.sampleRate) channels=\(format.channelCount)")
        do {
            audioFile = try AVAudioFile(forWriting: recordingURL, settings: format.settings)
            audioURL = recordingURL
        } catch {
            emit(kind: "error", message: "无法创建临时录音：\(error.localizedDescription)")
            return
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.audioLock.lock()
            defer { self.audioLock.unlock() }
            do {
                try self.audioFile?.write(from: buffer)
                self.audioFrameCount += AVAudioFramePosition(buffer.frameLength)
            } catch {
                self.audioWriteError = error.localizedDescription
            }
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
            diagnose("recording_started")
            emit(kind: "ready")
        } catch {
            inputNode.removeTap(onBus: 0)
            diagnose("recording_start_failed", error.localizedDescription)
            emit(kind: "error", message: "无法启动麦克风：\(error.localizedDescription)")
        }
    }

    func stop() {
        guard !stopping else { return }
        stopping = true
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        audioLock.lock()
        audioFile = nil
        let capturedFrames = audioFrameCount
        let writeError = audioWriteError
        audioLock.unlock()

        guard capturedFrames > 0, let recordingURL = audioURL else {
            diagnose("recording_empty", "frames=\(capturedFrames) writeError=\(writeError ?? "none")")
            emit(kind: "error", message: "没有录到麦克风声音，请检查系统输入设备后重试")
            finishStop()
            return
        }

        do {
            let recordedFile = try AVAudioFile(forReading: recordingURL)
            let bytes = (try? FileManager.default.attributesOfItem(atPath: recordingURL.path)[.size] as? NSNumber)?.int64Value ?? 0
            let duration = recordedFile.fileFormat.sampleRate > 0
                ? Double(recordedFile.length) / recordedFile.fileFormat.sampleRate
                : 0
            diagnose(
                "recording_stopped",
                "callbackFrames=\(capturedFrames) fileFrames=\(recordedFile.length) duration=\(String(format: "%.3f", duration)) bytes=\(bytes) writeError=\(writeError ?? "none")"
            )
            guard recordedFile.length > 0, bytes > 0 else {
                emit(kind: "error", message: "麦克风回调已启动，但没有生成有效录音文件，请检查系统输入设备后重试")
                finishStop()
                return
            }
        } catch {
            diagnose("recording_validation_failed", error.localizedDescription)
            emit(kind: "error", message: "录音文件无效，无法进行语音转文字：\(error.localizedDescription)")
            finishStop()
            return
        }

        if #available(macOS 26.0, *) {
            Task { [weak self] in
                await self?.transcribeWithSpeechAnalyzer(recordingURL)
            }
        } else {
            transcribeWithLegacyRecognizer(recordingURL)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 120) { [weak self] in
            guard let self, !self.stoppedEmitted else { return }
            self.emit(kind: "error", message: "语音转文字超时，请检查网络后重试")
            self.finishStop()
        }
    }

    @available(macOS 26.0, *)
    private func transcribeWithSpeechAnalyzer(_ recordingURL: URL) async {
        do {
            guard let supportedLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
                throw SpeechHelperError(message: "当前系统不支持 \(locale.identifier) 语音识别")
            }

            let transcriber = SpeechTranscriber(locale: supportedLocale, preset: .transcription)
            let modules: [any SpeechModule] = [transcriber]
            var status = await AssetInventory.status(forModules: modules)
            diagnose("model_status", "status=\(String(describing: status)) locale=\(supportedLocale.identifier)")
            if status == .unsupported {
                throw SpeechHelperError(message: "当前系统不支持中文语音模型")
            }
            if status != .installed {
                emit(kind: "status", message: "正在准备中文语音模型")
                if let installation = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                    try await installation.downloadAndInstall()
                }
                status = await AssetInventory.status(forModules: modules)
                diagnose("model_install_finished", "status=\(String(describing: status))")
                guard status == .installed else {
                    throw SpeechHelperError(message: "中文语音模型尚未安装完成，请检查网络后重试")
                }
            }

            emit(kind: "status", message: "正在转写语音")
            let audioFile = try AVAudioFile(forReading: recordingURL)
            let analyzer = SpeechAnalyzer(modules: modules)
            let resultTask = Task { () throws -> String in
                var transcript = ""
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    self.diagnose("transcriber_result", "final=\(result.isFinal) characters=\(text.count)")
                    transcript.append(text)
                    if result.isFinal {
                        return transcript
                    }
                }
                return transcript
            }
            do {
                diagnose("analyzer_start")
                try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true)
                try await analyzer.finalizeAndFinishThroughEndOfInput()
                diagnose("analyzer_finished")
                let transcript = try await resultTask.value
                completeTranscription(transcript)
            } catch {
                resultTask.cancel()
                throw error
            }
        } catch {
            let nsError = error as NSError
            diagnose("transcription_failed", "domain=\(nsError.domain) code=\(nsError.code) message=\(nsError.localizedDescription)")
            emit(kind: "error", message: "语音转文字失败：\(error.localizedDescription)")
            DispatchQueue.main.async { [weak self] in self?.finishStop() }
        }
    }

    private func transcribeWithLegacyRecognizer(_ recordingURL: URL) {
        let fileRequest = SFSpeechURLRecognitionRequest(url: recordingURL)
        fileRequest.taskHint = .dictation
        fileRequest.shouldReportPartialResults = false
        task = recognizer.recognitionTask(with: fileRequest) { [weak self] result, error in
            guard let self else { return }
            if let result, result.isFinal {
                self.completeTranscription(result.bestTranscription.formattedString)
                return
            }
            if let error {
                self.emit(kind: "error", message: "语音转文字失败：\(error.localizedDescription)")
                DispatchQueue.main.async { [weak self] in self?.finishStop() }
            }
        }
    }

    private func completeTranscription(_ transcript: String) {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        diagnose("transcription_completed", "characters=\(text.count)")
        if text.isEmpty {
            emit(kind: "error", message: "没有识别到可用文字，请靠近麦克风后重试")
        } else {
            emit(kind: "transcript", text: text, isFinal: true)
        }
        DispatchQueue.main.async { [weak self] in self?.finishStop() }
    }

    private func finishStop() {
        guard !stoppedEmitted else { return }
        stoppedEmitted = true
        task?.cancel()
        task = nil
        if let audioURL {
            try? FileManager.default.removeItem(at: audioURL)
        }
        audioURL = nil
        diagnose("stopped")
        emit(kind: "stopped")
        exit(0)
    }
}

let locale = CommandLine.arguments.dropFirst().first ?? "zh-CN"
let session = SpeechSession(locale: locale)
session.start()

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        if line.trimmingCharacters(in: .whitespacesAndNewlines) == "stop" {
            DispatchQueue.main.async {
                session.stop()
            }
            break
        }
    }
}

RunLoop.main.run()
