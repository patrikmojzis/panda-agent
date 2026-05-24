import Foundation

private struct StoredConfig: Codable {
    let gatewayBaseURL: URL
    let agentKey: String
    let deviceId: String
    let token: String?
    let label: String?
    let reconnectDelaySeconds: UInt64
    let allowPullScreenshots: Bool
    let pushToTalkShortcuts: PushToTalkShortcutBindings
    let tunnel: TunnelConfig?

    private enum CodingKeys: String, CodingKey {
        case gatewayBaseURL
        case legacyServerURL = "serverURL"
        case agentKey
        case deviceId
        case token
        case label
        case reconnectDelaySeconds
        case allowPullScreenshots
        case pushToTalkShortcuts
        case tunnel
    }

    init(config: Config) {
        gatewayBaseURL = config.gatewayBaseURL
        agentKey = config.agentKey
        deviceId = config.deviceId
        token = nil
        label = config.label
        reconnectDelaySeconds = config.reconnectDelaySeconds
        allowPullScreenshots = config.allowPullScreenshots
        pushToTalkShortcuts = config.pushToTalkShortcuts
        tunnel = config.tunnel
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedBaseURL = try container.decodeIfPresent(URL.self, forKey: .gatewayBaseURL)
            ?? container.decode(URL.self, forKey: .legacyServerURL)
        gatewayBaseURL = try Config.validateGatewayBaseURL(url: decodedBaseURL)
        agentKey = try container.decode(String.self, forKey: .agentKey)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        token = try container.decodeIfPresent(String.self, forKey: .token)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        reconnectDelaySeconds = try container.decode(UInt64.self, forKey: .reconnectDelaySeconds)
        allowPullScreenshots = try container.decodeIfPresent(Bool.self, forKey: .allowPullScreenshots) ?? true
        pushToTalkShortcuts = try container.decodeIfPresent(PushToTalkShortcutBindings.self, forKey: .pushToTalkShortcuts) ?? .defaults
        tunnel = try container.decodeIfPresent(TunnelConfig.self, forKey: .tunnel)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(gatewayBaseURL, forKey: .gatewayBaseURL)
        try container.encode(agentKey, forKey: .agentKey)
        try container.encode(deviceId, forKey: .deviceId)
        try container.encodeIfPresent(token, forKey: .token)
        try container.encodeIfPresent(label, forKey: .label)
        try container.encode(reconnectDelaySeconds, forKey: .reconnectDelaySeconds)
        try container.encode(allowPullScreenshots, forKey: .allowPullScreenshots)
        try container.encode(pushToTalkShortcuts, forKey: .pushToTalkShortcuts)
        try container.encodeIfPresent(tunnel, forKey: .tunnel)
    }

    func makeConfig(token resolvedToken: String) -> Config {
        Config(
            gatewayBaseURL: gatewayBaseURL,
            agentKey: agentKey,
            deviceId: deviceId,
            token: resolvedToken,
            label: label,
            reconnectDelaySeconds: reconnectDelaySeconds,
            allowPullScreenshots: allowPullScreenshots,
            pushToTalkShortcuts: pushToTalkShortcuts,
            tunnel: tunnel
        )
    }
}

enum ConfigStore {
    private static let configDirectoryPermissions = 0o700
    private static let configFilePermissions = 0o600

    private static func applicationSupportURL() throws -> URL {
        let fileManager = FileManager.default
        guard let applicationSupportURL = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw ReceiverError("Could not locate Application Support")
        }

        return applicationSupportURL
    }

    private static func configURL(forSupportDirectoryName directoryName: String) throws -> URL {
        try applicationSupportURL()
            .appendingPathComponent(directoryName, isDirectory: true)
            .appendingPathComponent("config.json", isDirectory: false)
    }

    static func defaultURL() throws -> URL {
        try configURL(forSupportDirectoryName: AppIdentity.supportDirectoryName)
    }

    private static func legacyURLs() throws -> [URL] {
        try AppIdentity.legacySupportDirectoryNames.map(configURL(forSupportDirectoryName:))
    }

    private static func fileSystemPath(_ url: URL) -> String {
        url.path
    }

    private static func trimmedToken(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    static func load(
        from configURLs: [URL],
        tokenStore: any TokenSecretStoring = KeychainTokenStore()
    ) throws -> Config? {
        for configURL in configURLs {
            let data: Data
            do {
                data = try Data(contentsOf: configURL)
            } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                continue
            }

            let storedConfig: StoredConfig
            do {
                storedConfig = try JSONDecoder().decode(StoredConfig.self, from: data)
            } catch is ReceiverError {
                continue
            } catch is DecodingError {
                continue
            }

            let keychainToken = try trimmedToken(tokenStore.loadToken(
                agentKey: storedConfig.agentKey,
                deviceId: storedConfig.deviceId
            ))
            let legacyToken = trimmedToken(storedConfig.token)
            guard let token = keychainToken ?? legacyToken else {
                return nil
            }

            let config = storedConfig.makeConfig(token: token)
            if keychainToken == nil {
                try tokenStore.saveToken(token, agentKey: config.agentKey, deviceId: config.deviceId)
            }
            if legacyToken != nil {
                try writeStoredConfig(StoredConfig(config: config), to: configURL)
            }
            return config
        }

        return nil
    }

    static func load() throws -> Config? {
        try load(from: try [defaultURL()] + legacyURLs())
    }

    @discardableResult
    static func save(
        _ config: Config,
        to configURL: URL,
        tokenStore: any TokenSecretStoring = KeychainTokenStore()
    ) throws -> URL {
        try tokenStore.saveToken(config.token, agentKey: config.agentKey, deviceId: config.deviceId)
        try writeStoredConfig(StoredConfig(config: config), to: configURL)
        return configURL
    }

    @discardableResult
    static func save(_ config: Config) throws -> URL {
        try save(config, to: try defaultURL())
    }

    private static func writeStoredConfig(_ storedConfig: StoredConfig, to configURL: URL) throws {
        let directoryURL = configURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: configDirectoryPermissions]
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: configDirectoryPermissions],
            ofItemAtPath: fileSystemPath(directoryURL)
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(storedConfig)
        try data.write(to: configURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: configFilePermissions],
            ofItemAtPath: fileSystemPath(configURL)
        )
    }

    static func remove(
        from configURLs: [URL],
        tokenStore: any TokenSecretStoring = KeychainTokenStore()
    ) throws {
        try tokenStore.deleteAllTokens()
        for configURL in configURLs {
            if FileManager.default.fileExists(atPath: fileSystemPath(configURL)) {
                try FileManager.default.removeItem(at: configURL)
            }
        }
    }

    static func remove() throws {
        try remove(from: try [defaultURL()] + legacyURLs())
    }
}
