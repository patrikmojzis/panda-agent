import AppKit
import AVFoundation
import Carbon
import Foundation

struct PushToTalkStatus {
    let detail: String
    let isRecording: Bool
    let isSending: Bool
}

private enum PushToTalkPhase: Equatable {
    case idle
    case starting(PushToTalkShortcutMode)
    case recording(PushToTalkShortcutMode)
    case sending(PushToTalkShortcutMode)
}

enum PushToTalkShortcutMode: CaseIterable {
    case voiceOnly
    case voiceWithScreenshot

    var id: UInt32 {
        switch self {
        case .voiceOnly:
            return 1
        case .voiceWithScreenshot:
            return 2
        }
    }

    var includesScreenshot: Bool {
        switch self {
        case .voiceOnly:
            return false
        case .voiceWithScreenshot:
            return true
        }
    }

    var label: String {
        switch self {
        case .voiceOnly:
            return "Voice"
        case .voiceWithScreenshot:
            return "Voice + Screen"
        }
    }

    var detail: String {
        switch self {
        case .voiceOnly:
            return "voice"
        case .voiceWithScreenshot:
            return "voice + screen"
        }
    }

    var trigger: String {
        switch self {
        case .voiceOnly:
            return "voice_only_hotkey"
        case .voiceWithScreenshot:
            return "voice_with_screenshot_hotkey"
        }
    }

    var shortcutLabel: String {
        switch self {
        case .voiceOnly:
            return "Ctrl+Opt+Cmd+V"
        case .voiceWithScreenshot:
            return "Ctrl+Opt+Cmd+S"
        }
    }

    var shortcut: GlobalHotkeyService.Shortcut {
        let modifiers = UInt32(controlKey | optionKey | cmdKey)
        switch self {
        case .voiceOnly:
            return .init(id: id, keyCode: UInt32(kVK_ANSI_V), modifiers: modifiers)
        case .voiceWithScreenshot:
            return .init(id: id, keyCode: UInt32(kVK_ANSI_S), modifiers: modifiers)
        }
    }

    static func from(shortcutId: UInt32) -> PushToTalkShortcutMode? {
        Self.allCases.first(where: { $0.id == shortcutId })
    }
}

enum MicrophoneAccess {
    static func status() -> AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .audio)
    }

    static func requestIfNeeded() async -> Bool {
        switch status() {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    continuation.resume(returning: granted)
                }
            }
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }
}

private struct RecordedPushToTalkAudio {
    let data: Data
    let durationMs: Int
}

@MainActor
private final class PushToTalkRecorder {
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?

    func start() async throws {
        let granted = await MicrophoneAccess.requestIfNeeded()
        guard granted else {
            throw ReceiverError.microphoneDenied
        }

        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("telepathy-voice-\(UUID().uuidString)")
            .appendingPathExtension("m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        let recorder = try AVAudioRecorder(url: fileURL, settings: settings)
        recorder.isMeteringEnabled = false
        guard recorder.record() else {
            throw ReceiverError("Could not start recording audio")
        }

        self.recordingURL = fileURL
        self.recorder = recorder
    }

    func finish() throws -> RecordedPushToTalkAudio {
        guard let recorder, let recordingURL else {
            throw ReceiverError("No active push-to-talk recording")
        }

        recorder.stop()
        self.recorder = nil
        self.recordingURL = nil

        let durationMs = max(1, Int(recorder.currentTime * 1_000))
        let data = try Data(contentsOf: recordingURL)
        try? FileManager.default.removeItem(at: recordingURL)
        return RecordedPushToTalkAudio(data: data, durationMs: durationMs)
    }

    func cancel() {
        recorder?.stop()
        if let recordingURL {
            try? FileManager.default.removeItem(at: recordingURL)
        }

        recorder = nil
        recordingURL = nil
    }
}

@MainActor
final class PushToTalkController {
    private var hotkeys: GlobalHotkeyService?
    private let recorder = PushToTalkRecorder()
    private let onError: (Error) -> Void
    private let onStatusChanged: (PushToTalkStatus) -> Void
    private let receiverProvider: () -> ReceiverService?
    private var phase: PushToTalkPhase = .idle
    private var startTask: Task<Void, Never>?

    init(
        receiverProvider: @escaping () -> ReceiverService?,
        onStatusChanged: @escaping (PushToTalkStatus) -> Void,
        onError: @escaping (Error) -> Void
    ) throws {
        self.receiverProvider = receiverProvider
        self.onStatusChanged = onStatusChanged
        self.onError = onError
        self.hotkeys = try GlobalHotkeyService(
            shortcuts: PushToTalkShortcutMode.allCases.map(\.shortcut)
        ) { [weak self] shortcutId, isPressed in
            self?.handleHotkey(shortcutId: shortcutId, isPressed: isPressed)
        }

        onStatusChanged(PushToTalkController.idleStatus())
    }

    func cancel() {
        startTask?.cancel()
        startTask = nil
        recorder.cancel()
        phase = .idle
        onStatusChanged(Self.idleStatus())
    }

    func shortcutsDescription() -> String {
        PushToTalkShortcutMode.allCases
            .map { "\($0.label): \($0.shortcutLabel)" }
            .joined(separator: " | ")
    }

    private func handleHotkey(shortcutId: UInt32, isPressed: Bool) {
        guard let mode = PushToTalkShortcutMode.from(shortcutId: shortcutId) else {
            return
        }

        if isPressed {
            beginRecording(mode: mode)
        } else {
            finishRecording(mode: mode)
        }
    }

    private func beginRecording(mode: PushToTalkShortcutMode) {
        guard phase == .idle else {
            return
        }

        guard receiverProvider() != nil else {
            onError(ReceiverError("Panda Telepathy is not configured"))
            onStatusChanged(Self.idleStatus(detail: "Receiver is not configured"))
            return
        }

        // Starting can pause on the macOS mic permission prompt, so keep a
        // separate phase and only mark the session as actively recording once
        // AVAudioRecorder is really live.
        phase = .starting(mode)
        onStatusChanged(PushToTalkStatus(
            detail: "Preparing \(mode.detail)…",
            isRecording: false,
            isSending: false
        ))

        startTask = Task { @MainActor in
            do {
                try await recorder.start()
                startTask = nil
                guard phase == .starting(mode) else {
                    recorder.cancel()
                    return
                }

                phase = .recording(mode)
                onStatusChanged(PushToTalkStatus(
                    detail: "Recording \(mode.detail)…",
                    isRecording: true,
                    isSending: false
                ))
            } catch is CancellationError {
                startTask = nil
            } catch {
                startTask = nil
                guard phase == .starting(mode) else {
                    return
                }

                phase = .idle
                onStatusChanged(Self.idleStatus())
                onError(error)
            }
        }
    }

    private func finishRecording(mode: PushToTalkShortcutMode) {
        switch phase {
        case .starting(let activeMode) where activeMode == mode:
            startTask?.cancel()
            startTask = nil
            recorder.cancel()
            phase = .idle
            onStatusChanged(Self.idleStatus())
            return
        case .recording(let activeMode) where activeMode == mode:
            phase = .sending(mode)
        default:
            return
        }

        let frontmostApp = NSWorkspace.shared.frontmostApplication?.localizedName
        let recordedAudio: RecordedPushToTalkAudio
        do {
            recordedAudio = try recorder.finish()
        } catch {
            phase = .idle
            onStatusChanged(Self.idleStatus())
            onError(error)
            return
        }

        guard let receiver = receiverProvider() else {
            phase = .idle
            onStatusChanged(Self.idleStatus(detail: "Receiver is not configured"))
            onError(ReceiverError("Panda Telepathy is not configured"))
            return
        }

        onStatusChanged(PushToTalkStatus(
            detail: "Sending \(mode.detail)…",
            isRecording: false,
            isSending: true
        ))

        Task { @MainActor in
            do {
                var items: [ContextSubmitItem] = [
                    .audio(ContextAudioItem(
                        mimeType: "audio/m4a",
                        data: recordedAudio.data.base64EncodedString(),
                        bytes: recordedAudio.data.count,
                        filename: "telepathy-voice-note.m4a"
                    )),
                ]
                if mode.includesScreenshot {
                    items.append(try await receiver.makeScreenshotContextItem())
                }

                try await receiver.submitContext(
                    mode: .pushToTalk,
                    items: items,
                    metadata: ContextSubmitMetadata(
                        submittedAt: Int64(Date().timeIntervalSince1970 * 1_000),
                        frontmostApp: frontmostApp,
                        windowTitle: nil,
                        trigger: mode.trigger
                    )
                )
                let time = DateFormatter.localizedString(
                    from: Date(),
                    dateStyle: .none,
                    timeStyle: .medium
                )
                phase = .idle
                onStatusChanged(Self.idleStatus(detail: "Last sent \(mode.detail) at \(time)"))
            } catch {
                phase = .idle
                onStatusChanged(Self.idleStatus())
                onError(error)
            }
        }
    }

    private static func idleStatus(detail: String? = nil) -> PushToTalkStatus {
        PushToTalkStatus(
            detail: detail ?? "Ready: \(PushToTalkShortcutMode.voiceOnly.shortcutLabel) / \(PushToTalkShortcutMode.voiceWithScreenshot.shortcutLabel)",
            isRecording: false,
            isSending: false
        )
    }
}
