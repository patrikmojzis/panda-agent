import Foundation
import Testing

@testable import PandaReceiverMacOS

@Test
func normalizesScreenRecordingDeniedErrors() {
    let error = NSError(
        domain: "com.apple.ScreenCaptureKit.SCStreamErrorDomain",
        code: -3801,
        userInfo: [NSLocalizedDescriptionKey: "The user declined TCCs for application, window, display capture"]
    )

    let issue = normalizeReceiverIssue(error)

    #expect(issue.state == .screenRecordingDenied)
    #expect(issue.message == ReceiverError.screenRecordingDenied.message)
}

@Test
func normalizesConnectionRefusedIntoWaitingForPanda() {
    let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)

    let issue = normalizeReceiverIssue(error, serverURL: URL(string: "ws://127.0.0.1:8897/telepathy"))

    #expect(issue.state == .waitingForPanda)
    #expect(issue.message == "Waiting for Panda at 127.0.0.1:8897")
}

@Test
func normalizesDroppedSocketIntoReconnectingState() {
    let error = NSError(domain: NSPOSIXErrorDomain, code: 57)

    let issue = normalizeReceiverIssue(error)

    #expect(issue.state == .reconnecting)
    #expect(issue.message == "Panda connection dropped. Reconnecting…")
}
