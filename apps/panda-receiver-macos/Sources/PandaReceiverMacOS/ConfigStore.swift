import Foundation

private struct StoredConfig: Codable {
    let gatewayBaseURL: URL
    let agentKey: String
    let deviceId: String
    let label: String?
    let reconnectDelaySeconds: UInt64
    let intervalScreenshots: IntervalScreenshotConfig
    let pushToTalkShortcuts: PushToTalkShortcutBindings
    let tunnel: TunnelConfig?

    private enum CodingKeys: String, CodingKey {
        case gatewayBaseURL
        case agentKey
        case deviceId
        case label
        case reconnectDelaySeconds
        case intervalScreenshots
        case pushToTalkShortcuts
        case tunnel
    }

    init(config: Config) {
        gatewayBaseURL = config.gatewayBaseURL
        agentKey = config.agentKey
        deviceId = config.deviceId
        label = config.label
        reconnectDelaySeconds = config.reconnectDelaySeconds
        intervalScreenshots = config.intervalScreenshots
        pushToTalkShortcuts = config.pushToTalkShortcuts
        tunnel = config.tunnel
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        gatewayBaseURL = try Config.validateGatewayBaseURL(url: container.decode(URL.self, forKey: .gatewayBaseURL))
        agentKey = try container.decode(String.self, forKey: .agentKey)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        reconnectDelaySeconds = try container.decode(UInt64.self, forKey: .reconnectDelaySeconds)
        intervalScreenshots = try container.decodeIfPresent(IntervalScreenshotConfig.self, forKey: .intervalScreenshots) ?? IntervalScreenshotConfig(intervalSeconds: IntervalScreenshotConfig.defaultIntervalSeconds)
        pushToTalkShortcuts = try container.decodeIfPresent(PushToTalkShortcutBindings.self, forKey: .pushToTalkShortcuts) ?? .defaults
        tunnel = try container.decodeIfPresent(TunnelConfig.self, forKey: .tunnel)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(gatewayBaseURL, forKey: .gatewayBaseURL)
        try container.encode(agentKey, forKey: .agentKey)
        try container.encode(deviceId, forKey: .deviceId)
        try container.encodeIfPresent(label, forKey: .label)
        try container.encode(reconnectDelaySeconds, forKey: .reconnectDelaySeconds)
        try container.encode(intervalScreenshots, forKey: .intervalScreenshots)
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
            intervalScreenshots: intervalScreenshots,
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

            guard let token = try trimmedToken(tokenStore.loadToken(
                agentKey: storedConfig.agentKey,
                deviceId: storedConfig.deviceId
            )) else {
                return nil
            }

            return storedConfig.makeConfig(token: token)
        }

        return nil
    }

    static func load() throws -> Config? {
        try load(from: try [defaultURL()])
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
        try remove(from: try [defaultURL()])
    }
}
