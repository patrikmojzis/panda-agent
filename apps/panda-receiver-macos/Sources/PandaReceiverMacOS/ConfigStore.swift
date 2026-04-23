import Foundation

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

    static func load() throws -> Config? {
        for configURL in try [defaultURL()] + legacyURLs() {
            do {
                let data = try Data(contentsOf: configURL)
                return try JSONDecoder().decode(Config.self, from: data)
            } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                continue
            }
        }

        return nil
    }

    @discardableResult
    static func save(_ config: Config) throws -> URL {
        let configURL = try defaultURL()
        let directoryURL = configURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: configDirectoryPermissions]
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: configDirectoryPermissions],
            ofItemAtPath: directoryURL.path()
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)
        try data.write(to: configURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: configFilePermissions],
            ofItemAtPath: configURL.path()
        )
        return configURL
    }

    static func remove() throws {
        for configURL in try [defaultURL()] + legacyURLs() {
            if FileManager.default.fileExists(atPath: configURL.path()) {
                try FileManager.default.removeItem(at: configURL)
            }
        }
    }
}
