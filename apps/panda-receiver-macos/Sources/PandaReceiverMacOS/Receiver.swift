import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

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

private struct PendingContextAck {
    let continuation: CheckedContinuation<Void, Error>
    let timeoutTask: Task<Void, Never>
}

private enum RequestErrorDisposition {
    case failPending(requestId: String)
    case ignoreStale(requestId: String)
    case fatal
}

actor ReceiverService {
    private let config: Config
    private let statusContinuation: AsyncStream<ReceiverStatus>.Continuation
    private let onPullScreenshot: @MainActor @Sendable () -> Void
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var isEnabled = true
    private var allowPullScreenshots: Bool
    private var runTask: Task<Void, Never>?
    private var currentSocket: URLSessionWebSocketTask?
    private var currentTunnel: TunnelSupervisor?
    private var hasConnectedOnce = false
    private var pendingContextAcks: [String: PendingContextAck] = [:]

    init(
        config: Config,
        statusContinuation: AsyncStream<ReceiverStatus>.Continuation,
        onPullScreenshot: @escaping @MainActor @Sendable () -> Void = {}
    ) {
        self.config = config
        self.statusContinuation = statusContinuation
        self.onPullScreenshot = onPullScreenshot
        self.allowPullScreenshots = config.allowPullScreenshots
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
            await publish(.starting, "Starting receiver")
            return
        }

        await stopRunning(reportDisabled: true)
    }

    func setPullScreenshotsEnabled(_ enabled: Bool) {
        allowPullScreenshots = enabled
    }

    func captureTestScreenshot() async throws -> URL {
        guard isEnabled else {
            throw ReceiverError.telepathyPaused
        }

        let screenshotData = try await captureScreenshotData()
        return try saveJPEGData(screenshotData, prefix: "telepathy-test")
    }

    func makeScreenshotContextItem() async throws -> ContextSubmitItem {
        guard isEnabled else {
            throw ReceiverError.telepathyPaused
        }

        let screenshotData = try await captureScreenshotData()
        return .image(ContextImageItem(
            mimeType: "image/jpeg",
            data: screenshotData.base64EncodedString(),
            bytes: screenshotData.count,
            filename: "telepathy-screenshot.jpg"
        ))
    }

    func submitContext(
        mode: TelepathyContextMode,
        items: [ContextSubmitItem],
        metadata: ContextSubmitMetadata?
    ) async throws {
        guard isEnabled else {
            throw ReceiverError.telepathyPaused
        }

        guard let socket = currentSocket else {
            throw ReceiverError("Panda Telepathy is not connected")
        }

        let requestId = UUID().uuidString
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                await self?.failPendingContextAck(
                    requestId: requestId,
                    error: ReceiverError("Panda Telepathy did not acknowledge the pushed context in time")
                )
            }
            pendingContextAcks[requestId] = PendingContextAck(
                continuation: continuation,
                timeoutTask: timeoutTask
            )

            Task { [weak self] in
                guard let self else {
                    return
                }

                do {
                    try await self.send(ContextSubmit(
                        requestId: requestId,
                        mode: mode.rawValue,
                        items: items,
                        metadata: metadata
                    ), over: socket)
                } catch {
                    await self.failPendingContextAck(requestId: requestId, error: error)
                }
            }
        }
    }

    func shutdown() async {
        isEnabled = false
        await stopRunning(reportDisabled: false)
    }

    private func runLoop() async {
        await publish(.starting, "Starting receiver")

        while !Task.isCancelled {
            guard isEnabled else {
                break
            }

            do {
                try Task.checkCancellation()
                await publish(connectionAttemptState(), connectLabel())
                try await connectOnce()
                if Task.isCancelled {
                    break
                }
                await publish(.reconnecting, "Panda connection closed. Reconnecting…")
            } catch is CancellationError {
                break
            } catch {
                if Task.isCancelled {
                    break
                }

                let issue = normalizeReceiverIssue(error, serverURL: config.serverURL)
                let state = issue.state == .waitingForPanda && hasConnectedOnce ? ReceiverConnectionState.reconnecting : issue.state
                fputs("[telepathy] \(issue.message)\n", stderr)
                await publish(state, issue.message)
            }

            do {
                try await Task.sleep(nanoseconds: config.reconnectDelaySeconds * 1_000_000_000)
            } catch {
                break
            }
        }

        currentSocket = nil
        currentTunnel?.stop()
        currentTunnel = nil
        failAllPendingContextAcks(error: ReceiverError("Panda Telepathy connection closed"))
        runTask = nil
    }

    private func connectOnce() async throws {
        let targetURL: URL
        if let tunnelConfig = config.tunnel {
            let tunnel = TunnelSupervisor(remoteURL: config.serverURL, config: tunnelConfig)
            try tunnel.start()
            currentTunnel = tunnel
            targetURL = tunnel.localURL
        } else {
            targetURL = config.serverURL
        }

        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.waitsForConnectivity = false
        sessionConfiguration.timeoutIntervalForRequest = 15
        sessionConfiguration.timeoutIntervalForResource = 15
        let session = URLSession(configuration: sessionConfiguration)
        let socket = session.webSocketTask(with: targetURL)
        currentSocket = socket

        defer {
            currentSocket = nil
            currentTunnel?.stop()
            currentTunnel = nil
            session.invalidateAndCancel()
        }

        socket.resume()

        try await send(DeviceHello(
            agentKey: config.agentKey,
            deviceId: config.deviceId,
            token: config.token,
            label: config.label
        ), over: socket)

        while !Task.isCancelled {
            let message = try await receive(over: socket)
            switch message {
            case .string(let text):
                try await handle(text: text, socket: socket)
            case .data(let data):
                guard let text = String(data: data, encoding: .utf8) else {
                    throw ReceiverError("Server sent non-UTF8 data")
                }
                try await handle(text: text, socket: socket)
            @unknown default:
                throw ReceiverError("Server sent an unsupported WebSocket message")
            }
        }
    }

    private func handle(text: String, socket: URLSessionWebSocketTask) async throws {
        let data = Data(text.utf8)
        let envelope = try decoder.decode(MessageEnvelope.self, from: data)

        switch envelope.type {
        case "context.accepted":
            let accepted = try decoder.decode(ContextAccepted.self, from: data)
            resolvePendingContextAck(requestId: accepted.requestId)
        case "device.ready":
            let ready = try decoder.decode(DeviceReady.self, from: data)
            hasConnectedOnce = true
            await publish(.connected, connectedLabel(agentKey: ready.agentKey, deviceId: ready.deviceId))
        case "request.error":
            let error = try decoder.decode(RequestError.self, from: data)
            switch classifyRequestError(error) {
            case .failPending(let requestId):
                _ = failPendingContextAck(requestId: requestId, error: ReceiverError(error.error))
                return
            case .ignoreStale(let requestId):
                fputs("[telepathy] ignoring stale request error for \(requestId): \(error.error)\n", stderr)
                return
            case .fatal:
                throw ReceiverError("Hub rejected request: \(error.error)")
            }
        case "screenshot.request":
            let request = try decoder.decode(ScreenshotRequest.self, from: data)
            do {
                let response = try await captureScreenshot(for: request.requestId)
                try await send(response, over: socket)
                await publish(.connected, connectedLabel())
            } catch {
                let issue = normalizeReceiverIssue(error, serverURL: config.serverURL)
                if issue.message == ReceiverError.pullScreenshotsDisabled.message {
                    await publish(.connected, connectedLabel())
                } else {
                    await publish(issue.state, issue.message)
                }
                try await send(ScreenshotFailure(
                    requestId: request.requestId,
                    error: issue.message
                ), over: socket)
            }
        default:
            throw ReceiverError("Unsupported telepathy message type \(envelope.type)")
        }
    }

    private func send<T: Encodable>(_ payload: T, over socket: URLSessionWebSocketTask) async throws {
        let data = try encoder.encode(payload)
        guard let text = String(data: data, encoding: .utf8) else {
            throw ReceiverError("Failed to encode telepathy payload")
        }

        // Foundation's async WebSocket helpers were flaky during reconnects.
        // Use the callback API and bridge it ourselves so cold-start retries
        // do not strand the receiver in a half-connected state.
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                socket.send(.string(text)) { error in
                    if let error {
                        continuation.resume(throwing: error)
                        return
                    }

                    continuation.resume()
                }
            }
        }, onCancel: {
            socket.cancel(with: .goingAway, reason: nil)
        })
    }

    private func receive(over socket: URLSessionWebSocketTask) async throws -> URLSessionWebSocketTask.Message {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URLSessionWebSocketTask.Message, Error>) in
                socket.receive { result in
                    continuation.resume(with: result)
                }
            }
        }, onCancel: {
            socket.cancel(with: .goingAway, reason: nil)
        })
    }

    private func stopRunning(reportDisabled: Bool) async {
        runTask?.cancel()
        runTask = nil
        currentSocket?.cancel(with: .goingAway, reason: nil)
        currentSocket = nil
        currentTunnel?.stop()
        currentTunnel = nil
        hasConnectedOnce = false
        failAllPendingContextAcks(error: ReceiverError("Panda Telepathy stopped"))

        if reportDisabled {
            await publish(.disabled, ReceiverError.telepathyPaused.message)
        }
    }

    private func captureScreenshot(for requestId: String) async throws -> ScreenshotSuccess {
        guard isEnabled else {
            throw ReceiverError.telepathyPaused
        }

        guard allowPullScreenshots else {
            throw ReceiverError.pullScreenshotsDisabled
        }

        await onPullScreenshot()
        let screenshotData = try await captureScreenshotData()

        return ScreenshotSuccess(
            requestId: requestId,
            mimeType: "image/jpeg",
            data: screenshotData.base64EncodedString(),
            bytes: screenshotData.count
        )
    }

    private func captureScreenshotData() async throws -> Data {
        // ScreenCaptureKit fixes fullscreen Spaces on modern macOS, but keep
        // an older screencapture fallback so the prototype still runs on 13.x.
        if #available(macOS 14.0, *) {
            return try await capturePrimaryDisplayJPEG()
        }

        return try capturePrimaryDisplayJPEGFallback()
    }

    @available(macOS 14.0, *)
    private func capturePrimaryDisplayJPEG() async throws -> Data {
        let shareableContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let displayID = CGMainDisplayID()

        guard let display = shareableContent.displays.first(where: { $0.displayID == displayID }) else {
            throw ReceiverError("Primary display \(displayID) is not available to ScreenCaptureKit")
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = false
        configuration.width = max(1, Int(display.width))
        configuration.height = max(1, Int(display.height))

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )

        return try encodeJPEG(image)
    }

    private func capturePrimaryDisplayJPEGFallback() throws -> Data {
        let screenshotURL = try saveTemporaryURL(prefix: "telepathy-fallback")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = [
            "-x",
            "-D",
            String(CGMainDisplayID()),
            "-t",
            "jpg",
            screenshotURL.path(),
        ]

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw ReceiverError("screencapture exited with status \(process.terminationStatus)")
        }

        let screenshotData = try Data(contentsOf: screenshotURL)
        try? FileManager.default.removeItem(at: screenshotURL)
        return screenshotData
    }

    private func encodeJPEG(_ image: CGImage) throws -> Data {
        let destinationData = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            destinationData,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw ReceiverError("Failed to create a JPEG image destination")
        }

        let properties: CFDictionary = [
            kCGImageDestinationLossyCompressionQuality: 0.9,
        ] as CFDictionary
        CGImageDestinationAddImage(destination, image, properties)

        guard CGImageDestinationFinalize(destination) else {
            throw ReceiverError("Failed to encode the screenshot as JPEG")
        }

        return destinationData as Data
    }

    private func saveJPEGData(_ data: Data, prefix: String) throws -> URL {
        let screenshotURL = try saveTemporaryURL(prefix: prefix)
        try data.write(to: screenshotURL, options: .atomic)
        return screenshotURL
    }

    private func saveTemporaryURL(prefix: String) throws -> URL {
        let fileManager = FileManager.default
        let screenshotURL = fileManager.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
            .appendingPathExtension("jpg")

        if fileManager.fileExists(atPath: screenshotURL.path()) {
            try? fileManager.removeItem(at: screenshotURL)
        }

        return screenshotURL
    }

    private func resolvePendingContextAck(requestId: String) {
        guard let pending = pendingContextAcks.removeValue(forKey: requestId) else {
            return
        }

        pending.timeoutTask.cancel()
        pending.continuation.resume()
    }

    @discardableResult
    private func failPendingContextAck(requestId: String, error: Error) -> Bool {
        guard let pending = pendingContextAcks.removeValue(forKey: requestId) else {
            return false
        }

        pending.timeoutTask.cancel()
        pending.continuation.resume(throwing: error)
        return true
    }

    private func failAllPendingContextAcks(error: Error) {
        let pending = pendingContextAcks
        pendingContextAcks.removeAll()
        for entry in pending.values {
            entry.timeoutTask.cancel()
            entry.continuation.resume(throwing: error)
        }
    }

    private func classifyRequestError(_ error: RequestError) -> RequestErrorDisposition {
        guard let requestId = error.requestId else {
            return .fatal
        }

        if pendingContextAcks[requestId] != nil {
            return .failPending(requestId: requestId)
        }

        // Push requests time out client-side. If the hub reports a late error
        // after we already gave up on that request, treat it as stale noise
        // instead of tearing down the whole socket.
        return .ignoreStale(requestId: requestId)
    }

    private func publish(_ state: ReceiverConnectionState, _ detail: String) async {
        statusContinuation.yield(ReceiverStatus(state: state, detail: detail))
    }

    private func connectionAttemptState() -> ReceiverConnectionState {
        hasConnectedOnce ? .reconnecting : .connecting
    }

    private func connectLabel() -> String {
        let verb = hasConnectedOnce ? "Reconnecting" : "Connecting"
        if let tunnel = config.tunnel {
            return "\(verb) through SSH tunnel to \(tunnel.destination)"
        }

        return "\(verb) to \(config.serverURL.host ?? config.serverURL.absoluteString)"
    }

    private func connectedLabel(agentKey: String? = nil, deviceId: String? = nil) -> String {
        "Connected as \(agentKey ?? config.agentKey)/\(deviceId ?? config.deviceId)"
    }
}
