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
        .appendingPathComponent("panda-gateway-tests-\(name)", isDirectory: true)
    try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    return directoryURL.appendingPathComponent("config.json")
}

private func sampleConfig(token: String = "secret") throws -> Config {
    try Config.make(
        gatewayBaseURLRaw: "http://127.0.0.1:8094",
        agentKeyRaw: "panda",
        deviceIdRaw: "home-mac",
        tokenRaw: token,
        labelRaw: "Home Mac",
        reconnectDelayRaw: "2",
        tunnelHostRaw: "",
        tunnelUserRaw: "",
        tunnelPortRaw: "",
        tunnelLocalPortRaw: "",
        intervalMinutesRaw: ""
    )
}

@Test
func rejectsWebSocketGatewayBaseURL() throws {
    #expect(throws: ReceiverError.self) {
        try Config.make(
            gatewayBaseURLRaw: "ws://127.0.0.1:8787/telepathy",
            agentKeyRaw: "panda",
            deviceIdRaw: "home-mac",
            tokenRaw: "secret",
            labelRaw: "",
            reconnectDelayRaw: "2",
            tunnelHostRaw: "",
            tunnelUserRaw: "",
            tunnelPortRaw: "",
            tunnelLocalPortRaw: "",
            intervalMinutesRaw: ""
        )
    }

    #expect(throws: ReceiverError.self) {
        try Config.make(
            gatewayBaseURLRaw: "wss://example.com/telepathy",
            agentKeyRaw: "panda",
            deviceIdRaw: "home-mac",
            tokenRaw: "secret",
            labelRaw: "",
            reconnectDelayRaw: "2",
            tunnelHostRaw: "",
            tunnelUserRaw: "",
            tunnelPortRaw: "",
            tunnelLocalPortRaw: "",
            intervalMinutesRaw: ""
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
    #expect(text.contains("\"gatewayBaseURL\""))
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
    #expect(savedText.contains("\"gatewayBaseURL\""))
    #expect(tokenStore.tokens["panda::home-mac"] == "super-secret-token")

    let loaded = try ConfigStore.load(from: [configURL], tokenStore: tokenStore)
    #expect(loaded?.token == "super-secret-token")
    #expect(loaded?.agentKey == "panda")
    #expect(loaded?.gatewayBaseURL.scheme == "http")
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
      "serverURL": "http://127.0.0.1:8094",
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
    #expect(loaded?.gatewayBaseURL.absoluteString == "http://127.0.0.1:8094")
    #expect(tokenStore.tokens["panda::home-mac"] == "legacy-secret-token")
    let migratedText = try String(contentsOf: configURL, encoding: .utf8)
    #expect(!migratedText.contains("legacy-secret-token"))
    #expect(!migratedText.contains("\"token\""))
    #expect(migratedText.contains("\"gatewayBaseURL\""))
}

@Test
func configStoreSkipsLegacyWebSocketConfigSoSetupCanStart() throws {
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

    #expect(loaded == nil)
    #expect(tokenStore.tokens.isEmpty)
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
func acceptsHTTPAndHTTPSGatewayBaseURLs() throws {
    let httpConfig = try Config.make(
        gatewayBaseURLRaw: "http://127.0.0.1:8094",
        agentKeyRaw: "panda",
        deviceIdRaw: "home-mac",
        tokenRaw: "secret",
        labelRaw: "Home Mac",
        reconnectDelayRaw: "2",
        tunnelHostRaw: "",
        tunnelUserRaw: "",
        tunnelPortRaw: "",
        tunnelLocalPortRaw: "",
        intervalMinutesRaw: ""
    )
    let httpsConfig = try Config.make(
        gatewayBaseURLRaw: "https://gateway.example.com",
        agentKeyRaw: "panda",
        deviceIdRaw: "home-mac",
        tokenRaw: "secret",
        labelRaw: "Home Mac",
        reconnectDelayRaw: "2",
        tunnelHostRaw: "",
        tunnelUserRaw: "",
        tunnelPortRaw: "",
        tunnelLocalPortRaw: "",
        intervalMinutesRaw: ""
    )

    #expect(httpConfig.gatewayBaseURL.scheme == "http")
    #expect(httpConfig.gatewayBaseURL.host == "127.0.0.1")
    #expect(httpsConfig.gatewayBaseURL.scheme == "https")
    #expect(httpsConfig.gatewayBaseURL.host == "gateway.example.com")
    #expect(httpsConfig.allowPullScreenshots)
}

@Test
func decodesLegacyConfigWithoutShortcutOverrides() throws {
    let legacyJSON = """
    {
      "serverURL": "http://127.0.0.1:8094",
      "agentKey": "panda",
      "deviceId": "home-mac",
      "token": "secret",
      "label": "Home Mac",
      "reconnectDelaySeconds": 2
    }
    """

    let config = try JSONDecoder().decode(Config.self, from: Data(legacyJSON.utf8))

    #expect(config.gatewayBaseURL.absoluteString == "http://127.0.0.1:8094")
    #expect(config.allowPullScreenshots)
    #expect(config.intervalScreenshots.intervalSeconds == IntervalScreenshotConfig.defaultIntervalSeconds)
    #expect(config.pushToTalkShortcuts.voiceOnly == .defaultVoiceOnly)
    #expect(config.pushToTalkShortcuts.voiceWithScreenshot == .defaultVoiceWithScreenshot)
}

@Test
func rejectsLegacyWebSocketConfigInGatewayMode() throws {
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

    #expect(throws: ReceiverError.self) {
        try JSONDecoder().decode(Config.self, from: Data(legacyJSON.utf8))
    }
}

@Test
func acceptsPullScreenshotsDisabled() throws {
    let config = try Config.make(
        gatewayBaseURLRaw: "http://127.0.0.1:8094",
        agentKeyRaw: "panda",
        deviceIdRaw: "home-mac",
        tokenRaw: "secret",
        labelRaw: "Home Mac",
        reconnectDelayRaw: "2",
        tunnelHostRaw: "",
        tunnelUserRaw: "",
        tunnelPortRaw: "",
        tunnelLocalPortRaw: "",
        intervalMinutesRaw: "",
        allowPullScreenshots: false
    )

    #expect(config.allowPullScreenshots == false)
}

@Test
func rejectsDuplicatePushToTalkShortcuts() {
    #expect(throws: ReceiverError.self) {
        try Config.make(
            gatewayBaseURLRaw: "http://127.0.0.1:8094",
            agentKeyRaw: "panda",
            deviceIdRaw: "home-mac",
            tokenRaw: "secret",
            labelRaw: "Home Mac",
            reconnectDelayRaw: "2",
            tunnelHostRaw: "",
            tunnelUserRaw: "",
            tunnelPortRaw: "",
            tunnelLocalPortRaw: "",
            intervalMinutesRaw: "",
            pushToTalkShortcuts: PushToTalkShortcutBindings(
                voiceOnly: .defaultVoiceOnly,
                voiceWithScreenshot: .defaultVoiceOnly
            )
        )
    }
}

@Test
func validatesIntervalScreenshotMinutesRange() throws {
    #expect(throws: ReceiverError.self) {
        _ = try IntervalScreenshotConfig.resolve(intervalMinutesRaw: "0")
    }

    #expect(try IntervalScreenshotConfig.resolve(intervalMinutesRaw: "1").intervalSeconds == 60)
    #expect(try IntervalScreenshotConfig.resolve(intervalMinutesRaw: "1440").intervalSeconds == 86_400)

    #expect(throws: ReceiverError.self) {
        _ = try IntervalScreenshotConfig.resolve(intervalMinutesRaw: "1441")
    }
}

@Test
func configStoreRoundTripPersistsIntervalScreenshots() throws {
    let configURL = try temporaryConfigURL()
    defer {
        try? FileManager.default.removeItem(at: configURL.deletingLastPathComponent())
    }

    let tokenStore = FakeTokenSecretStore()
    let config = try Config.make(
        gatewayBaseURLRaw: "http://127.0.0.1:8094",
        agentKeyRaw: "panda",
        deviceIdRaw: "home-mac",
        tokenRaw: "super-secret-token",
        labelRaw: "Home Mac",
        reconnectDelayRaw: "2",
        tunnelHostRaw: "",
        tunnelUserRaw: "",
        tunnelPortRaw: "",
        tunnelLocalPortRaw: "",
        intervalMinutesRaw: "10"
    )

    try ConfigStore.save(config, to: configURL, tokenStore: tokenStore)

    let loaded = try ConfigStore.load(from: [configURL], tokenStore: tokenStore)

    #expect(loaded?.intervalScreenshots.intervalSeconds == 600)
}
