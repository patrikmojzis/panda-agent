import Foundation
import Testing

@testable import PandaReceiverMacOS

@Test
func rejectsNonWebSocketServerURL() throws {
    #expect(throws: ReceiverError.self) {
        try Config.make(
            serverURLRaw: "https://example.com/telepathy",
            agentKeyRaw: "panda",
            deviceIdRaw: "home-mac",
            tokenRaw: "secret",
            labelRaw: "",
            reconnectDelayRaw: "2",
            tunnelHostRaw: "",
            tunnelUserRaw: "",
            tunnelPortRaw: "",
            tunnelLocalPortRaw: ""
        )
    }
}

@Test
func acceptsSecureWebSocketServerURL() throws {
    let config = try Config.make(
        serverURLRaw: "wss://example.com/telepathy",
        agentKeyRaw: "panda",
        deviceIdRaw: "home-mac",
        tokenRaw: "secret",
        labelRaw: "Home Mac",
        reconnectDelayRaw: "2",
        tunnelHostRaw: "",
        tunnelUserRaw: "",
        tunnelPortRaw: "",
        tunnelLocalPortRaw: ""
    )

    #expect(config.serverURL.scheme == "wss")
    #expect(config.serverURL.host == "example.com")
    #expect(config.allowPullScreenshots)
}

@Test
func decodesLegacyConfigWithoutShortcutOverrides() throws {
    let legacyJSON = """
    {
      "serverURL": "ws://127.0.0.1:8787/telepathy",
      "agentKey": "panda",
      "deviceId": "home-mac",
      "token": "secret",
      "label": "Home Mac",
      "reconnectDelaySeconds": 2
    }
    """

    let config = try JSONDecoder().decode(Config.self, from: Data(legacyJSON.utf8))

    #expect(config.allowPullScreenshots)
    #expect(config.pushToTalkShortcuts.voiceOnly == .defaultVoiceOnly)
    #expect(config.pushToTalkShortcuts.voiceWithScreenshot == .defaultVoiceWithScreenshot)
}

@Test
func acceptsPullScreenshotsDisabled() throws {
    let config = try Config.make(
        serverURLRaw: "ws://127.0.0.1:8787/telepathy",
        agentKeyRaw: "panda",
        deviceIdRaw: "home-mac",
        tokenRaw: "secret",
        labelRaw: "Home Mac",
        reconnectDelayRaw: "2",
        tunnelHostRaw: "",
        tunnelUserRaw: "",
        tunnelPortRaw: "",
        tunnelLocalPortRaw: "",
        allowPullScreenshots: false
    )

    #expect(config.allowPullScreenshots == false)
}

@Test
func rejectsDuplicatePushToTalkShortcuts() {
    #expect(throws: ReceiverError.self) {
        try Config.make(
            serverURLRaw: "ws://127.0.0.1:8787/telepathy",
            agentKeyRaw: "panda",
            deviceIdRaw: "home-mac",
            tokenRaw: "secret",
            labelRaw: "Home Mac",
            reconnectDelayRaw: "2",
            tunnelHostRaw: "",
            tunnelUserRaw: "",
            tunnelPortRaw: "",
            tunnelLocalPortRaw: "",
            pushToTalkShortcuts: PushToTalkShortcutBindings(
                voiceOnly: .defaultVoiceOnly,
                voiceWithScreenshot: .defaultVoiceOnly
            )
        )
    }
}
