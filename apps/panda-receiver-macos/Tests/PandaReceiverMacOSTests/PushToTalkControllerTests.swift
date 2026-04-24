import Foundation
import Testing

@testable import PandaReceiverMacOS

@Test
func pushToTalkDurationUsesWallClockInterval() {
    let startedAt = Date(timeIntervalSince1970: 100)
    let endedAt = startedAt.addingTimeInterval(20)

    #expect(pushToTalkDurationMs(startedAt: startedAt, endedAt: endedAt) == 20_000)
}

@Test
func pushToTalkDurationKeepsOneMillisecondFloor() {
    let startedAt = Date(timeIntervalSince1970: 100)

    #expect(pushToTalkDurationMs(startedAt: startedAt, endedAt: startedAt) == 1)
}
