import Foundation
import Testing

@testable import PandaReceiverMacOS

private final class LockIsolated<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: Value

    init(_ value: Value) {
        self._value = value
    }

    var value: Value {
        lock.lock()
        defer { lock.unlock() }
        return _value
    }

    func withValue(_ body: (inout Value) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        body(&_value)
    }
}

private actor ManualSleeper {
    private var waiters: [CheckedContinuation<Void, Error>] = []

    func hasWaiters() -> Bool {
        !waiters.isEmpty
    }

    func sleep(nanoseconds: UInt64) async throws {
        try await withCheckedThrowingContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func resumeAll() {
        let current = waiters
        waiters.removeAll()
        for waiter in current {
            waiter.resume(returning: ())
        }
    }
}

private final class Gate: @unchecked Sendable {
    private var isOpen = false
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen {
            return
        }

        await withCheckedContinuation { continuation in
            continuations.append(continuation)
        }
    }

    func open() {
        isOpen = true
        let current = continuations
        continuations.removeAll()
        for continuation in current {
            continuation.resume()
        }
    }
}

private func awaitEventually(
    maxYields: Int = 1_000,
    _ condition: @escaping @Sendable () async -> Bool
) async -> Bool {
    for _ in 0..<maxYields {
        if await condition() {
            return true
        }
        await Task.yield()
    }

    return await condition()
}

@Test
func startSendsImmediatelyAndTransitionsToRunning() async throws {
    let clock = LockIsolated(Date(timeIntervalSince1970: 100))
    let sleeper = ManualSleeper()
    let sentCount = LockIsolated(0)

    let controller = await MainActor.run {
        IntervalScreenshotController(
            intervalSeconds: 60,
            frontmostAppProvider: { nil },
            sendScreenshot: { _, _ in
                sentCount.withValue { $0 += 1 }
            },
            now: { clock.value },
            sleep: { nanos in
                try await sleeper.sleep(nanoseconds: nanos)
            },
            onStateChanged: { _ in }
        )
    }

    await MainActor.run { controller.start() }

    #expect(await awaitEventually { sentCount.value == 1 })
    #expect(await awaitEventually { await sleeper.hasWaiters() })

    clock.withValue { $0 = $0.addingTimeInterval(60) }
    await sleeper.resumeAll()

    #expect(await awaitEventually { sentCount.value == 2 })

    let isRunning = await awaitEventually {
        let state = await MainActor.run { controller.state }
        if case .running = state {
            return true
        }
        return false
    }

    if isRunning {
        #expect(true)
    } else {
        let state = await MainActor.run { controller.state }
        Issue.record("Expected controller to be running, got: \(state)")
    }
}

@Test
func pauseStopsFurtherSends() async throws {
    let clock = LockIsolated(Date(timeIntervalSince1970: 100))
    let sleeper = ManualSleeper()
    let sentCount = LockIsolated(0)

    let controller = await MainActor.run {
        IntervalScreenshotController(
            intervalSeconds: 60,
            frontmostAppProvider: { nil },
            sendScreenshot: { _, _ in
                sentCount.withValue { $0 += 1 }
            },
            now: { clock.value },
            sleep: { nanos in
                try await sleeper.sleep(nanoseconds: nanos)
            },
            onStateChanged: { _ in }
        )
    }

    await MainActor.run { controller.start() }
    await Task.yield()
    #expect(sentCount.value == 1)

    await MainActor.run { controller.pause() }

    clock.withValue { $0 = $0.addingTimeInterval(60) }
    await sleeper.resumeAll()
    await Task.yield()

    #expect(sentCount.value == 1)
    let state = await MainActor.run { controller.state }
    if case .paused = state {
        #expect(true)
    } else {
        Issue.record("Expected paused state, got: \(state)")
    }
}

@Test
func resumeSendsImmediatelyAgain() async throws {
    let clock = LockIsolated(Date(timeIntervalSince1970: 100))
    let sleeper = ManualSleeper()
    let sentCount = LockIsolated(0)

    let controller = await MainActor.run {
        IntervalScreenshotController(
            intervalSeconds: 60,
            frontmostAppProvider: { nil },
            sendScreenshot: { _, _ in
                sentCount.withValue { $0 += 1 }
            },
            now: { clock.value },
            sleep: { nanos in
                try await sleeper.sleep(nanoseconds: nanos)
            },
            onStateChanged: { _ in }
        )
    }

    await MainActor.run { controller.start() }
    await Task.yield()
    #expect(sentCount.value == 1)

    await MainActor.run { controller.pause() }
    await MainActor.run { controller.resume() }
    await Task.yield()

    #expect(sentCount.value == 2)
}

@Test
func skipsTickWhenSendIsInFlight() async throws {
    let clock = LockIsolated(Date(timeIntervalSince1970: 100))
    let sleeper = ManualSleeper()
    let started = LockIsolated(0)
    let gate = Gate()

    let controller = await MainActor.run {
        IntervalScreenshotController(
            intervalSeconds: 60,
            frontmostAppProvider: { nil },
            sendScreenshot: { _, _ in
                started.withValue { $0 += 1 }
                await gate.wait()
            },
            now: { clock.value },
            sleep: { nanos in
                try await sleeper.sleep(nanoseconds: nanos)
            },
            onStateChanged: { _ in }
        )
    }

    await MainActor.run { controller.start() }
    #expect(await awaitEventually { started.value == 1 })

    let initialNextCaptureAt = await MainActor.run { () -> Date in
        let state = controller.state
        if case .sending(let nextCaptureAt, _) = state {
            return nextCaptureAt
        }

        Issue.record("Expected controller to be sending after start, got: \(state)")
        return clock.value
    }

    #expect(await awaitEventually { await sleeper.hasWaiters() })
    clock.withValue { $0 = $0.addingTimeInterval(60) }
    await sleeper.resumeAll()

    #expect(await awaitEventually {
        let state = await MainActor.run { controller.state }
        if case .sending(let nextCaptureAt, _) = state {
            return nextCaptureAt > initialNextCaptureAt
        }
        return false
    })

    #expect(started.value == 1)

    gate.open()
    #expect(await awaitEventually {
        let state = await MainActor.run { controller.state }
        if case .running = state {
            return true
        }
        return false
    })

    #expect(await awaitEventually { await sleeper.hasWaiters() })
    clock.withValue { $0 = $0.addingTimeInterval(60) }
    await sleeper.resumeAll()

    #expect(await awaitEventually { started.value == 2 })
}

@Test
func pauseWhileSendIsInFlightKeepsPausedStateAndClearsTransientError() async throws {
    let clock = LockIsolated(Date(timeIntervalSince1970: 100))
    let sleeper = ManualSleeper()
    let started = LockIsolated(0)
    let gate = Gate()

    let controller = await MainActor.run {
        IntervalScreenshotController(
            intervalSeconds: 60,
            frontmostAppProvider: { nil },
            sendScreenshot: { _, _ in
                started.withValue { $0 += 1 }
                await gate.wait()
            },
            now: { clock.value },
            sleep: { nanos in
                try await sleeper.sleep(nanoseconds: nanos)
            },
            onStateChanged: { _ in }
        )
    }

    await MainActor.run { controller.start() }
    await Task.yield()
    #expect(started.value == 1)

    await MainActor.run { controller.pause() }

    gate.open()
    await Task.yield()

    await sleeper.resumeAll()
    await Task.yield()

    let state = await MainActor.run { controller.state }
    if case .paused = state {
        #expect(true)
    } else {
        Issue.record("Expected paused state, got: \(state)")
    }

    let transient = await MainActor.run { controller.transientErrorMessage }
    #expect(transient == nil)
}

@Test
func stopWhileSendIsInFlightKeepsStoppedStateAndClearsTransientError() async throws {
    let clock = LockIsolated(Date(timeIntervalSince1970: 100))
    let sleeper = ManualSleeper()
    let started = LockIsolated(0)
    let gate = Gate()

    let controller = await MainActor.run {
        IntervalScreenshotController(
            intervalSeconds: 60,
            frontmostAppProvider: { nil },
            sendScreenshot: { _, _ in
                started.withValue { $0 += 1 }
                await gate.wait()
            },
            now: { clock.value },
            sleep: { nanos in
                try await sleeper.sleep(nanoseconds: nanos)
            },
            onStateChanged: { _ in }
        )
    }

    await MainActor.run { controller.start() }
    await Task.yield()
    #expect(started.value == 1)

    await MainActor.run { controller.stop() }

    gate.open()
    await Task.yield()

    await sleeper.resumeAll()
    await Task.yield()

    let state = await MainActor.run { controller.state }
    #expect(state == .stopped)

    let transient = await MainActor.run { controller.transientErrorMessage }
    #expect(transient == nil)
}

@Test
func fatalGatewayAuthErrorStopsController() async throws {
    let clock = LockIsolated(Date(timeIntervalSince1970: 100))
    let sleeper = ManualSleeper()

    let controller = await MainActor.run {
        IntervalScreenshotController(
            intervalSeconds: 60,
            frontmostAppProvider: { nil },
            sendScreenshot: { _, _ in
                throw GatewayClientError.httpStatus(statusCode: 401, message: "unauthorized")
            },
            now: { clock.value },
            sleep: { nanos in
                try await sleeper.sleep(nanoseconds: nanos)
            },
            onStateChanged: { _ in }
        )
    }

    await MainActor.run { controller.start() }
    await Task.yield()

    let state = await MainActor.run { controller.state }
    if case .error = state {
        #expect(true)
    } else {
        Issue.record("Expected error state, got: \(state)")
    }
}

@Test
func screenRecordingDeniedStopsController() async throws {
    let clock = LockIsolated(Date(timeIntervalSince1970: 100))
    let sleeper = ManualSleeper()

    let controller = await MainActor.run {
        IntervalScreenshotController(
            intervalSeconds: 60,
            frontmostAppProvider: { nil },
            sendScreenshot: { _, _ in
                throw ReceiverError.screenRecordingDenied
            },
            now: { clock.value },
            sleep: { nanos in
                try await sleeper.sleep(nanoseconds: nanos)
            },
            onStateChanged: { _ in }
        )
    }

    await MainActor.run { controller.start() }
    await Task.yield()

    let state = await MainActor.run { controller.state }
    if case .error(let message, _) = state {
        #expect(message == ReceiverError.screenRecordingDenied.message)
    } else {
        Issue.record("Expected error state, got: \(state)")
    }
}
