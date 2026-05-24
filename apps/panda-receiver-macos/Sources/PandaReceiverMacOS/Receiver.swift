import Foundation

enum ReceiverConnectionState: Sendable {
    case starting
    case connecting
    case waitingForPanda
    case reconnecting
    case connected
    case screenRecordingDenied
    case disabled
    case error
}

struct ReceiverStatus: Sendable {
    let state: ReceiverConnectionState
    let detail: String
}

private struct GatewayContextAttachment: Sendable {
    let data: Data
    let mimeType: String
    let filename: String
}

actor ReceiverService {
    private static let contextEventType = "mac.context.push"
    private static let connectedHeartbeatIntervalSeconds: UInt64 = 45

    private let config: Config
    private let statusContinuation: AsyncStream<ReceiverStatus>.Continuation
    private let screenshotCapture: ScreenshotCapturing
    private var isEnabled = true
    private var runTask: Task<Void, Never>?
    private var currentTunnel: TunnelSupervisor?
    private var hasConnectedOnce = false

    init(
        config: Config,
        statusContinuation: AsyncStream<ReceiverStatus>.Continuation,
        screenshotCapture: ScreenshotCapturing = DefaultScreenshotCaptureService()
    ) {
        self.config = config
        self.statusContinuation = statusContinuation
        self.screenshotCapture = screenshotCapture
    }

    func start() {
        guard runTask == nil else {
            return
        }

        runTask = Task {
            await runLoop()
        }
    }

    func setEnabled(_ enabled: Bool) async {
        guard enabled != isEnabled else {
            return
        }

        isEnabled = enabled
        if enabled {
            start()
            await publish(.starting, "Starting Gateway receiver")
            return
        }

        await stopRunning(reportDisabled: true)
    }

    func setPullScreenshotsEnabled(_ enabled: Bool) {
        _ = enabled
        // Pull screenshots are still a legacy Telepathy concern until Gateway
        // command parity lands. Keep the setting persisted, but PR1 does not
        // start a Gateway pull-command loop.
    }

    func captureTestScreenshot() async throws -> URL {
        guard isEnabled else {
            throw ReceiverError.telepathyPaused
        }

        let screenshotData = try await screenshotCapture.captureJPEG()
        return try saveJPEGData(screenshotData, prefix: "gateway-test")
    }

    func submitPushToTalk(
        audioData: Data,
        durationMs: Int,
        includeScreenshot: Bool,
        frontmostApp: String?,
        trigger: String
    ) async throws {
        guard isEnabled else {
            throw ReceiverError.telepathyPaused
        }

        var attachments = [GatewayContextAttachment(
            data: audioData,
            mimeType: "audio/m4a",
            filename: "mac-voice-note.m4a"
        )]

        if includeScreenshot {
            attachments.append(GatewayContextAttachment(
                data: try await screenshotCapture.captureJPEG(),
                mimeType: "image/jpeg",
                filename: "mac-screenshot.jpg"
            ))
        }

        try await pushContext(
            text: pushToTalkText(
                includeScreenshot: includeScreenshot,
                durationMs: durationMs,
                frontmostApp: frontmostApp,
                trigger: trigger
            ),
            attachments: attachments
        )
    }

    func sendClipboardText(_ text: String, frontmostApp: String?) async throws {
        guard isEnabled else {
            throw ReceiverError.telepathyPaused
        }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw ReceiverError("Clipboard does not contain text to send")
        }

        try await pushContext(
            text: clipboardText(trimmed, frontmostApp: frontmostApp),
            attachments: []
        )
    }

    func sendScreenshotNow(frontmostApp: String?) async throws {
        guard isEnabled else {
            throw ReceiverError.telepathyPaused
        }

        let screenshotData = try await screenshotCapture.captureJPEG()
        try await pushContext(
            text: manualScreenshotText(frontmostApp: frontmostApp),
            attachments: [GatewayContextAttachment(
                data: screenshotData,
                mimeType: "image/jpeg",
                filename: "mac-manual-screenshot.jpg"
            )]
        )
    }

    func shutdown() async {
        isEnabled = false
        await stopRunning(reportDisabled: false)
    }

    private func runLoop() async {
        await publish(.starting, "Starting Gateway receiver")

        while !Task.isCancelled {
            guard isEnabled else {
                break
            }

            var sleepSeconds = config.reconnectDelaySeconds
            do {
                try Task.checkCancellation()
                await publish(connectionAttemptState(), connectLabel())
                let client = try gatewayClient()
                _ = try await client.deviceHeartbeat()
                hasConnectedOnce = true
                await publish(.connected, connectedLabel())
                sleepSeconds = Self.connectedHeartbeatIntervalSeconds
            } catch is CancellationError {
                break
            } catch {
                if Task.isCancelled {
                    break
                }

                let issue = normalizeReceiverIssue(error, gatewayBaseURL: config.gatewayBaseURL)
                let state = issue.state == .waitingForPanda && hasConnectedOnce ? ReceiverConnectionState.reconnecting : issue.state
                fputs("[gateway] \(issue.message)\n", stderr)
                await publish(state, issue.message)
            }

            do {
                try await Task.sleep(nanoseconds: sleepSeconds * 1_000_000_000)
            } catch {
                break
            }
        }

        currentTunnel?.stop()
        currentTunnel = nil
        runTask = nil
    }

    private func pushContext(text: String, attachments: [GatewayContextAttachment]) async throws {
        let contextId = UUID().uuidString.lowercased()
        let client = try gatewayClient()
        var refs: [GatewayAttachmentRef] = []

        for (index, attachment) in attachments.enumerated() {
            let response = try await client.uploadAttachment(GatewayAttachmentUpload(
                data: attachment.data,
                mimeType: attachment.mimeType,
                filename: attachment.filename,
                idempotencyKey: "mac.context.push:\(contextId):attachment:\(index)"
            ))
            refs.append(GatewayAttachmentRef(id: response.attachmentId, sha256: response.sha256))
        }

        _ = try await client.postEvent(
            type: Self.contextEventType,
            delivery: .wake,
            text: text,
            attachments: refs,
            idempotencyKey: "mac.context.push:\(contextId):event"
        )
        await publish(.connected, connectedLabel())
    }

    private func gatewayClient() throws -> GatewayClient {
        GatewayClient(baseURL: try gatewayBaseURL(), token: config.token)
    }

    private func gatewayBaseURL() throws -> URL {
        guard let tunnelConfig = config.tunnel else {
            return config.gatewayBaseURL
        }

        if let currentTunnel {
            if currentTunnel.isRunning {
                return currentTunnel.localURL
            }

            currentTunnel.stop()
            self.currentTunnel = nil
        }

        let tunnel = TunnelSupervisor(remoteURL: config.gatewayBaseURL, config: tunnelConfig)
        try tunnel.start()
        currentTunnel = tunnel
        return tunnel.localURL
    }

    private func stopRunning(reportDisabled: Bool) async {
        runTask?.cancel()
        runTask = nil
        currentTunnel?.stop()
        currentTunnel = nil
        hasConnectedOnce = false

        if reportDisabled {
            await publish(.disabled, ReceiverError.telepathyPaused.message)
        }
    }

    private func publish(_ state: ReceiverConnectionState, _ detail: String) async {
        statusContinuation.yield(ReceiverStatus(state: state, detail: detail))
    }

    private func connectionAttemptState() -> ReceiverConnectionState {
        hasConnectedOnce ? .reconnecting : .connecting
    }

    private func connectLabel() -> String {
        let verb = hasConnectedOnce ? "Checking" : "Connecting"
        if let tunnel = config.tunnel {
            return "\(verb) through SSH tunnel to \(tunnel.destination)"
        }

        return "\(verb) to \(config.gatewayBaseURL.host ?? config.gatewayBaseURL.absoluteString)"
    }

    private func connectedLabel() -> String {
        "Connected to Gateway as \(config.displayName) (\(config.deviceId))"
    }

    private func pushToTalkText(
        includeScreenshot: Bool,
        durationMs: Int,
        frontmostApp: String?,
        trigger: String
    ) -> String {
        var lines = [
            "Mac push-to-talk context.",
            "mode: \(includeScreenshot ? "voice_with_screenshot" : "voice_only")",
            "duration_ms: \(durationMs)",
            "trigger: \(trigger)",
        ]
        if let frontmostApp, !frontmostApp.isEmpty {
            lines.append("frontmost_app: \(frontmostApp)")
        }
        return lines.joined(separator: "\n")
    }

    private func clipboardText(_ text: String, frontmostApp: String?) -> String {
        var lines = ["Mac clipboard text push."]
        if let frontmostApp, !frontmostApp.isEmpty {
            lines.append("frontmost_app: \(frontmostApp)")
        }
        lines.append("\nclipboard_text:\n\(text)")
        return lines.joined(separator: "\n")
    }

    private func manualScreenshotText(frontmostApp: String?) -> String {
        var lines = ["Mac manual screenshot push."]
        if let frontmostApp, !frontmostApp.isEmpty {
            lines.append("frontmost_app: \(frontmostApp)")
        }
        return lines.joined(separator: "\n")
    }
}
