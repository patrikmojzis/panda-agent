import Foundation

private struct StoredConfig: Codable {
    let serverURL: URL
    let agentKey: String
    let deviceId: String
    let token: String?
    let label: String?
    let reconnectDelaySeconds: UInt64
    let allowPullScreenshots: Bool
    let pushToTalkShortcuts: PushToTalkShortcutBindings
    let tunnel: TunnelConfig?

    init(config: Config) {
        serverURL = config.serverURL
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
        serverURL = try container.decode(URL.self, forKey: .serverURL)
        agentKey = try container.decode(String.self, forKey: .agentKey)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        token = try container.decodeIfPresent(String.self, forKey: .token)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        reconnectDelaySeconds = try container.decode(UInt64.self, forKey: .reconnectDelaySeconds)
        allowPullScreenshots = try container.decodeIfPresent(Bool.self, forKey: .allowPullScreenshots) ?? true
        pushToTalkShortcuts = try container.decodeIfPresent(PushToTalkShortcutBindings.self, forKey: .pushToTalkShortcuts) ?? .defaults
        tunnel = try container.decodeIfPresent(TunnelConfig.self, forKey: .tunnel)
    }

    func makeConfig(token resolvedToken: String) -> Config {
        Config(
            serverURL: serverURL,
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
            do {
                let data = try Data(contentsOf: configURL)
                let storedConfig = try JSONDecoder().decode(StoredConfig.self, from: data)
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
            } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                continue
            }
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
