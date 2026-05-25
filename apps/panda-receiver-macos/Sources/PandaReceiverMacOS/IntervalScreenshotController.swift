import Foundation

enum IntervalScreenshotState: Equatable, Sendable {
    case stopped
    case running(nextCaptureAt: Date, lastSentAt: Date?)
    case paused(lastSentAt: Date?)
    case sending(nextCaptureAt: Date, lastSentAt: Date?)
    case error(message: String, lastSentAt: Date?)
}

@MainActor
final class IntervalScreenshotController {
    private let intervalSeconds: UInt64
    private let frontmostAppProvider: @Sendable () -> String?
    private let sendScreenshot: @Sendable (_ frontmostApp: String?, _ intervalSeconds: UInt64) async throws -> Void
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (_ nanoseconds: UInt64) async throws -> Void
    private let onStateChanged: @MainActor @Sendable (IntervalScreenshotState) -> Void

    private(set) var state: IntervalScreenshotState = .stopped {
        didSet {
            onStateChanged(state)
        }
    }

    private var loopTask: Task<Void, Never>?
    private var sendTask: Task<Void, Never>?
    private var generation: UInt64 = 0

    private(set) var lastSentAt: Date?
    private(set) var transientErrorMessage: String?

    init(
        intervalSeconds: UInt64,
        frontmostAppProvider: @escaping @Sendable () -> String?,
        sendScreenshot: @escaping @Sendable (_ frontmostApp: String?, _ intervalSeconds: UInt64) async throws -> Void,
        now: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping @Sendable (_ nanoseconds: UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) },
        onStateChanged: @escaping @MainActor @Sendable (IntervalScreenshotState) -> Void
    ) {
        self.intervalSeconds = intervalSeconds
        self.frontmostAppProvider = frontmostAppProvider
        self.sendScreenshot = sendScreenshot
        self.now = now
        self.sleep = sleep
        self.onStateChanged = onStateChanged
    }

    func start() {
        guard loopTask == nil else {
            return
        }

        bumpGeneration()
        transientErrorMessage = nil
        startLoop(firstTick: now())
    }

    func pause() {
        guard loopTask != nil else {
            return
        }

        bumpGeneration()
        loopTask?.cancel()
        loopTask = nil
        sendTask?.cancel()
        sendTask = nil
        state = .paused(lastSentAt: lastSentAt)
    }

    func resume() {
        guard loopTask == nil else {
            return
        }

        bumpGeneration()
        transientErrorMessage = nil
        startLoop(firstTick: now())
    }

    func stop(clearError: Bool = true) {
        bumpGeneration()
        loopTask?.cancel()
        loopTask = nil

        sendTask?.cancel()
        sendTask = nil

        if clearError {
            transientErrorMessage = nil
        }

        state = .stopped
    }

    private func bumpGeneration() {
        generation &+= 1
    }

    private func startLoop(firstTick: Date) {
        loopTask?.cancel()
        loopTask = nil

        let loopGeneration = generation

        let nextCaptureAt = firstTick.addingTimeInterval(TimeInterval(intervalSeconds))
        state = .sending(nextCaptureAt: nextCaptureAt, lastSentAt: lastSentAt)
        beginSend(nextTick: nextCaptureAt, generation: loopGeneration)

        loopTask = Task { @MainActor [weak self] in
            guard let self else {
                return
            }

            var nextTick = firstTick

            while !Task.isCancelled, self.generation == loopGeneration {
                let current = self.now()
                let delaySeconds = nextTick.timeIntervalSince(current)
                if delaySeconds > 0 {
                    do {
                        try await self.sleep(UInt64(delaySeconds * 1_000_000_000))
                    } catch {
                        break
                    }
                }

                if Task.isCancelled || self.generation != loopGeneration {
                    break
                }

                let scheduledFor = nextTick
                nextTick = scheduledFor.addingTimeInterval(TimeInterval(self.intervalSeconds))
                self.handleTick(nextTick: nextTick, generation: loopGeneration)
            }
        }
    }

    private func handleTick(nextTick: Date, generation: UInt64) {
        guard self.generation == generation else {
            return
        }

        if sendTask != nil {
            state = .sending(nextCaptureAt: nextTick, lastSentAt: lastSentAt)
            return
        }

        state = .sending(nextCaptureAt: nextTick, lastSentAt: lastSentAt)
        beginSend(nextTick: nextTick, generation: generation)
    }

    private func beginSend(nextTick: Date, generation: UInt64) {
        guard sendTask == nil else {
            return
        }

        let frontmostApp = frontmostAppProvider()
        let intervalSecondsValue = intervalSeconds
        let sendScreenshotAction = sendScreenshot
        let nowProvider = now

        // Run send completion state updates on the MainActor to avoid races with tick handling.
        sendTask = Task { @MainActor [weak self] in
            guard let self else {
                return
            }

            do {
                try await sendScreenshotAction(frontmostApp, intervalSecondsValue)

                if Task.isCancelled {
                    return
                }

                guard self.generation == generation, self.sendTask != nil, !Task.isCancelled else {
                    return
                }

                self.lastSentAt = nowProvider()
                self.transientErrorMessage = nil
                self.sendTask = nil

                if self.loopTask == nil {
                    // paused/stopped
                    return
                }

                self.state = .running(nextCaptureAt: nextTick, lastSentAt: self.lastSentAt)
            } catch is CancellationError {
                // user-initiated cancellation (pause/stop)
                return
            } catch {
                if Task.isCancelled {
                    return
                }

                guard self.generation == generation, self.sendTask != nil, !Task.isCancelled else {
                    return
                }

                self.sendTask = nil

                let normalizedError = normalizeReceiverError(error)
                if normalizedError.message == ReceiverError.screenRecordingDenied.message {
                    self.transientErrorMessage = nil
                    self.loopTask?.cancel()
                    self.loopTask = nil
                    self.state = .error(message: normalizedError.message, lastSentAt: self.lastSentAt)
                    return
                }

                if self.isFatalGatewayError(error) {
                    self.transientErrorMessage = nil
                    self.loopTask?.cancel()
                    self.loopTask = nil
                    self.state = .error(message: normalizedError.message, lastSentAt: self.lastSentAt)
                    return
                }

                self.transientErrorMessage = normalizedError.message
                if self.loopTask == nil {
                    // paused/stopped
                    return
                }

                self.state = .running(nextCaptureAt: nextTick, lastSentAt: self.lastSentAt)
            }
        }
    }

    private func isFatalGatewayError(_ error: Error) -> Bool {
        if let gatewayError = error as? GatewayClientError {
            if case .httpStatus(let statusCode, _) = gatewayError {
                return statusCode == 401 || statusCode == 403
            }
            return false
        }

        return false
    }
}
