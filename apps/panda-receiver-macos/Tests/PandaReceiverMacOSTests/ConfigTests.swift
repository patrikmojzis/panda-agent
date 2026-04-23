import Foundation
import Testing

@testable import PandaReceiverMacOS

private final class FakeTokenSecretStore: TokenSecretStoring {
    private(set) var tokens: [String: String] = [:]
    private(set) var deleteAllCount = 0

    private func key(agentKey: String, deviceId: String) -> String {
        "\(agentKey)::\(deviceId)"
    }

    func loadToken(agentKey: String, deviceId: String) throws -> String? {
        tokens[key(agentKey: agentKey, deviceId: deviceId)]
    }

    func saveToken(_ token: String, agentKey: String, deviceId: String) throws {
        tokens[key(agentKey: agentKey, deviceId: deviceId)] = token
    }

    func clearTokens() {
        tokens.removeAll()
    }

    func deleteAllTokens() throws {
        deleteAllCount += 1
        tokens.removeAll()
    }
}

private func temporaryConfigURL(name: String = UUID().uuidString) throws -> URL {
    let directoryURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("panda-telepathy-tests-\(name)", isDirectory: true)
    try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    return directoryURL.appendingPathComponent("config.json")
}

private func sampleConfig(token: String = "secret") throws -> Config {
    try Config.make(
        serverURLRaw: "ws://127.0.0.1:8787/telepathy",
        agentKeyRaw: "panda",
        deviceIdRaw: "home-mac",
        tokenRaw: token,
        labelRaw: "Home Mac",
        reconnectDelayRaw: "2",
        tunnelHostRaw: "",
        tunnelUserRaw: "",
        tunnelPortRaw: "",
        tunnelLocalPortRaw: ""
    )
}

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
func configEncodingDoesNotExposeToken() throws {
    let config = try sampleConfig(token: "super-secret-token")

    let data = try JSONEncoder().encode(config)
    let text = String(decoding: data, as: UTF8.self)

    #expect(!text.contains("super-secret-token"))
    #expect(!text.contains("\"token\""))
}

@Test
func configStoreSavesTokenInSecretStoreOnly() throws {
    let configURL = try temporaryConfigURL()
    defer {
        try? FileManager.default.removeItem(at: configURL.deletingLastPathComponent())
    }
    let tokenStore = FakeTokenSecretStore()
    let config = try sampleConfig(token: "super-secret-token")

    try ConfigStore.save(config, to: configURL, tokenStore: tokenStore)

    let savedText = try String(contentsOf: configURL, encoding: .utf8)
    #expect(!savedText.contains("super-secret-token"))
    #expect(!savedText.contains("\"token\""))
    #expect(tokenStore.tokens["panda::home-mac"] == "super-secret-token")

    let loaded = try ConfigStore.load(from: [configURL], tokenStore: tokenStore)
    #expect(loaded?.token == "super-secret-token")
    #expect(loaded?.agentKey == "panda")
}

@Test
func configStoreMigratesLegacyPlaintextTokenToSecretStore() throws {
    let configURL = try temporaryConfigURL()
    defer {
        try? FileManager.default.removeItem(at: configURL.deletingLastPathComponent())
    }
    let tokenStore = FakeTokenSecretStore()
    let legacyJSON = """
    {
      "serverURL": "ws://127.0.0.1:8787/telepathy",
      "agentKey": "panda",
      "deviceId": "home-mac",
      "token": "legacy-secret-token",
      "label": "Home Mac",
      "reconnectDelaySeconds": 2
    }
    """
    try legacyJSON.write(to: configURL, atomically: true, encoding: .utf8)

    let loaded = try ConfigStore.load(from: [configURL], tokenStore: tokenStore)

    #expect(loaded?.token == "legacy-secret-token")
    #expect(tokenStore.tokens["panda::home-mac"] == "legacy-secret-token")
    let migratedText = try String(contentsOf: configURL, encoding: .utf8)
    #expect(!migratedText.contains("legacy-secret-token"))
    #expect(!migratedText.contains("\"token\""))
}

@Test
func configStoreReturnsNilWhenKeychainTokenIsMissing() throws {
    let configURL = try temporaryConfigURL()
    defer {
        try? FileManager.default.removeItem(at: configURL.deletingLastPathComponent())
    }
    let tokenStore = FakeTokenSecretStore()
    let config = try sampleConfig(token: "super-secret-token")
    try ConfigStore.save(config, to: configURL, tokenStore: tokenStore)
    tokenStore.clearTokens()

    let loaded = try ConfigStore.load(from: [configURL], tokenStore: tokenStore)

    #expect(loaded == nil)
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
