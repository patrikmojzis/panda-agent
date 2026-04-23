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
}
