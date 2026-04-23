import Foundation

struct TunnelConfig: Codable, Sendable {
    let host: String
    let user: String?
    let sshPort: UInt16
    let localPort: UInt16

    var destination: String {
        guard let user, !user.isEmpty else {
            return host
        }

        return "\(user)@\(host)"
    }
}

struct Config: Codable {
    let serverURL: URL
    let agentKey: String
    let deviceId: String
    let token: String
    let label: String?
    let reconnectDelaySeconds: UInt64
    let allowPullScreenshots: Bool
    let pushToTalkShortcuts: PushToTalkShortcutBindings
    let tunnel: TunnelConfig?

    private enum CodingKeys: String, CodingKey {
        case serverURL
        case agentKey
        case deviceId
        case token
        case label
        case reconnectDelaySeconds
        case allowPullScreenshots
        case pushToTalkShortcuts
        case tunnel
    }

    init(
        serverURL: URL,
        agentKey: String,
        deviceId: String,
        token: String,
        label: String?,
        reconnectDelaySeconds: UInt64,
        allowPullScreenshots: Bool = true,
        pushToTalkShortcuts: PushToTalkShortcutBindings = .defaults,
        tunnel: TunnelConfig?
    ) {
        self.serverURL = serverURL
        self.agentKey = agentKey
        self.deviceId = deviceId
        self.token = token
        self.label = label
        self.reconnectDelaySeconds = reconnectDelaySeconds
        self.allowPullScreenshots = allowPullScreenshots
        self.pushToTalkShortcuts = pushToTalkShortcuts
        self.tunnel = tunnel
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        serverURL = try container.decode(URL.self, forKey: .serverURL)
        agentKey = try container.decode(String.self, forKey: .agentKey)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        token = try container.decode(String.self, forKey: .token)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        reconnectDelaySeconds = try container.decode(UInt64.self, forKey: .reconnectDelaySeconds)
        allowPullScreenshots = try container.decodeIfPresent(Bool.self, forKey: .allowPullScreenshots) ?? true
        pushToTalkShortcuts = try container.decodeIfPresent(PushToTalkShortcutBindings.self, forKey: .pushToTalkShortcuts) ?? .defaults
        tunnel = try container.decodeIfPresent(TunnelConfig.self, forKey: .tunnel)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(serverURL, forKey: .serverURL)
        try container.encode(agentKey, forKey: .agentKey)
        try container.encode(deviceId, forKey: .deviceId)
        try container.encodeIfPresent(label, forKey: .label)
        try container.encode(reconnectDelaySeconds, forKey: .reconnectDelaySeconds)
        try container.encode(allowPullScreenshots, forKey: .allowPullScreenshots)
        try container.encode(pushToTalkShortcuts, forKey: .pushToTalkShortcuts)
        try container.encodeIfPresent(tunnel, forKey: .tunnel)
    }

    var displayName: String {
        let trimmedLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmedLabel.isEmpty ? deviceId : trimmedLabel
    }

    private static func validateServerURL(rawValue: String) throws -> URL {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let serverURL = URL(string: trimmed) else {
            throw ReceiverError("Enter a valid server WebSocket URL")
        }

        guard let scheme = serverURL.scheme?.lowercased(), scheme == "ws" || scheme == "wss" else {
            throw ReceiverError("Server URL must use ws:// or wss://")
        }

        guard serverURL.host != nil else {
            throw ReceiverError("Server URL must include a host")
        }

        return serverURL
    }

    static func make(
        serverURLRaw: String,
        agentKeyRaw: String,
        deviceIdRaw: String,
        tokenRaw: String,
        labelRaw: String,
        reconnectDelayRaw: String,
        tunnelHostRaw: String,
        tunnelUserRaw: String,
        tunnelPortRaw: String,
        tunnelLocalPortRaw: String,
        allowPullScreenshots: Bool = true,
        pushToTalkShortcuts: PushToTalkShortcutBindings = .defaults
    ) throws -> Config {
        let serverTrimmed = serverURLRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        let agentTrimmed = agentKeyRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        let deviceTrimmed = deviceIdRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        let tokenTrimmed = tokenRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        let labelTrimmed = labelRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        let reconnectTrimmed = reconnectDelayRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        let tunnelHostTrimmed = tunnelHostRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        let tunnelUserTrimmed = tunnelUserRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        let tunnelPortTrimmed = tunnelPortRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        let tunnelLocalPortTrimmed = tunnelLocalPortRaw.trimmingCharacters(in: .whitespacesAndNewlines)

        let serverURL = try validateServerURL(rawValue: serverTrimmed)

        guard !agentTrimmed.isEmpty else {
            throw ReceiverError("Agent key is required")
        }

        guard !deviceTrimmed.isEmpty else {
            throw ReceiverError("Device ID is required")
        }

        guard !tokenTrimmed.isEmpty else {
            throw ReceiverError("Token is required")
        }

        let reconnectDelaySeconds: UInt64
        if reconnectTrimmed.isEmpty {
            reconnectDelaySeconds = 2
        } else if let parsed = UInt64(reconnectTrimmed), parsed > 0 {
            reconnectDelaySeconds = parsed
        } else {
            throw ReceiverError("Reconnect delay must be a positive number")
        }

        guard pushToTalkShortcuts.voiceOnly.hasRequiredModifiers,
              pushToTalkShortcuts.voiceWithScreenshot.hasRequiredModifiers else {
            throw ReceiverError("Each push-to-talk shortcut needs at least one modifier key")
        }

        guard pushToTalkShortcuts.voiceOnly != pushToTalkShortcuts.voiceWithScreenshot else {
            throw ReceiverError("Voice shortcuts must be different")
        }

        let tunnelConfig: TunnelConfig?
        if tunnelHostTrimmed.isEmpty {
            tunnelConfig = nil
        } else {
            let sshPort: UInt16
            if tunnelPortTrimmed.isEmpty {
                sshPort = 22
            } else if let parsed = UInt16(tunnelPortTrimmed), parsed > 0 {
                sshPort = parsed
            } else {
                throw ReceiverError("SSH port must be a valid port number")
            }

            let localPort: UInt16
            if tunnelLocalPortTrimmed.isEmpty {
                localPort = 43190
            } else if let parsed = UInt16(tunnelLocalPortTrimmed), parsed > 0 {
                localPort = parsed
            } else {
                throw ReceiverError("Local tunnel port must be a valid port number")
            }

            tunnelConfig = TunnelConfig(
                host: tunnelHostTrimmed,
                user: tunnelUserTrimmed.isEmpty ? nil : tunnelUserTrimmed,
                sshPort: sshPort,
                localPort: localPort
            )
        }

        return Config(
            serverURL: serverURL,
            agentKey: agentTrimmed,
            deviceId: deviceTrimmed,
            token: tokenTrimmed,
            label: labelTrimmed.isEmpty ? nil : labelTrimmed,
            reconnectDelaySeconds: reconnectDelaySeconds,
            allowPullScreenshots: allowPullScreenshots,
            pushToTalkShortcuts: pushToTalkShortcuts,
            tunnel: tunnelConfig
        )
    }

    static func parseLaunch(arguments: [String]) throws -> LaunchRequest {
        var values: [String: String] = [:]
        var saveConfig = false
        var printConfigPath = false
        var dumpConfig = false
        var resetConfig = false
        var disableTunnel = false
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "--help" || argument == "-h" {
                throw ReceiverError.usage
            }

            if argument == "--save-config" {
                saveConfig = true
                index += 1
                continue
            }

            if argument == "--print-config-path" {
                printConfigPath = true
                index += 1
                continue
            }

            if argument == "--dump-config" {
                dumpConfig = true
                index += 1
                continue
            }

            if argument == "--reset-config" {
                resetConfig = true
                index += 1
                continue
            }

            if argument == "--no-ssh-tunnel" {
                disableTunnel = true
                index += 1
                continue
            }

            guard argument.hasPrefix("--") else {
                throw ReceiverError("Unexpected argument \(argument)")
            }

            let key = String(argument.dropFirst(2))
            guard index + 1 < arguments.count else {
                throw ReceiverError("Missing value for --\(key)")
            }

            values[key] = arguments[index + 1]
            index += 2
        }

        if resetConfig {
            try ConfigStore.remove()
        }

        let savedConfig = try ConfigStore.load()
        let launchAtLoginCommand = try parseLaunchAtLoginCommand(rawValue: values["launch-at-login"])
        let mergedConfig = try merge(savedConfig: savedConfig, overrides: values, disableTunnel: disableTunnel)

        if saveConfig, let mergedConfig {
            try ConfigStore.save(mergedConfig)
        }

        return LaunchRequest(
            config: mergedConfig,
            saveConfig: saveConfig,
            printConfigPath: printConfigPath,
            dumpConfig: dumpConfig,
            resetConfig: resetConfig,
            launchAtLoginCommand: launchAtLoginCommand
        )
    }

    private static func merge(savedConfig: Config?, overrides: [String: String], disableTunnel: Bool) throws -> Config? {
        let serverRaw = overrides["server"] ?? savedConfig?.serverURL.absoluteString
        let agentKey = overrides["agent"] ?? savedConfig?.agentKey
        let deviceId = overrides["device-id"] ?? savedConfig?.deviceId
        let token = overrides["token"] ?? savedConfig?.token
        let label = resolvedLabel(overrides["label"], fallback: savedConfig?.label)
        let reconnectDelaySeconds = try resolveReconnectDelay(overrides["reconnect-delay"], fallback: savedConfig?.reconnectDelaySeconds)
        let tunnelHost = disableTunnel ? nil : resolvedTunnelHost(overrides["ssh-host"], fallback: savedConfig?.tunnel?.host)
        let tunnelUser = disableTunnel ? nil : resolvedTunnelUser(overrides["ssh-user"], fallback: savedConfig?.tunnel?.user)
        let sshPort = try resolveTunnelPort(overrides["ssh-port"], fallback: savedConfig?.tunnel?.sshPort)
        let tunnelLocalPort = try resolveTunnelLocalPort(overrides["tunnel-local-port"], fallback: savedConfig?.tunnel?.localPort)

        let hasAnyConfig = [serverRaw, agentKey, deviceId, token].contains { value in
            guard let value else {
                return false
            }
            return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }

        if !hasAnyConfig {
            return nil
        }

        guard let serverRaw else {
            throw ReceiverError("Missing or invalid --server value")
        }
        let serverURL = try validateServerURL(rawValue: serverRaw)

        guard let agentKey, !agentKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ReceiverError("Missing --agent")
        }

        guard let deviceId, !deviceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ReceiverError("Missing --device-id")
        }

        guard let token, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ReceiverError("Missing --token")
        }

        return Config(
            serverURL: serverURL,
            agentKey: agentKey,
            deviceId: deviceId,
            token: token,
            label: label,
            reconnectDelaySeconds: reconnectDelaySeconds,
            allowPullScreenshots: savedConfig?.allowPullScreenshots ?? true,
            pushToTalkShortcuts: savedConfig?.pushToTalkShortcuts ?? .defaults,
            tunnel: tunnelHost.map { host in
                TunnelConfig(
                    host: host,
                    user: tunnelUser,
                    sshPort: sshPort,
                    localPort: tunnelLocalPort
                )
            }
        )
    }

    static func usage() -> String {
        """
        panda-receiver-macos \
          --server ws://127.0.0.1:8787/telepathy \
          --agent panda \
          --device-id home-mac \
          --token shared-secret \
          [--label "Patrik MacBook"] \
          [--reconnect-delay 2] \
          [--save-config] \
          [--print-config-path] \
          [--dump-config] \
          [--reset-config] \
          [--ssh-host clankerino] \
          [--ssh-user panda] \
          [--ssh-port 22] \
          [--tunnel-local-port 43190] \
          [--no-ssh-tunnel] \
          [--launch-at-login status|enable|disable]
        """
    }

    private static func resolvedLabel(_ override: String?, fallback: String?) -> String? {
        guard let candidate = override ?? fallback else {
            return nil
        }

        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func resolveReconnectDelay(_ override: String?, fallback: UInt64?) throws -> UInt64 {
        guard let rawValue = override else {
            return fallback ?? 2
        }

        guard let reconnectDelay = UInt64(rawValue), reconnectDelay > 0 else {
            throw ReceiverError("Invalid --reconnect-delay value")
        }

        return reconnectDelay
    }

    private static func parseLaunchAtLoginCommand(rawValue: String?) throws -> LaunchAtLoginCommand? {
        guard let rawValue else {
            return nil
        }

        guard let command = LaunchAtLoginCommand(rawValue: rawValue) else {
            throw ReceiverError("Invalid --launch-at-login value \(rawValue)")
        }

        return command
    }

    private static func resolvedTunnelHost(_ override: String?, fallback: String?) -> String? {
        guard let candidate = override ?? fallback else {
            return nil
        }

        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func resolvedTunnelUser(_ override: String?, fallback: String?) -> String? {
        guard let candidate = override ?? fallback else {
            return nil
        }

        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func resolveTunnelPort(_ override: String?, fallback: UInt16?) throws -> UInt16 {
        guard let rawValue = override else {
            return fallback ?? 22
        }

        guard let port = UInt16(rawValue), port > 0 else {
            throw ReceiverError("Invalid --ssh-port value")
        }

        return port
    }

    private static func resolveTunnelLocalPort(_ override: String?, fallback: UInt16?) throws -> UInt16 {
        guard let rawValue = override else {
            return fallback ?? 43190
        }

        guard let port = UInt16(rawValue), port > 0 else {
            throw ReceiverError("Invalid --tunnel-local-port value")
        }

        return port
    }
}

struct LaunchRequest {
    let config: Config?
    let saveConfig: Bool
    let printConfigPath: Bool
    let dumpConfig: Bool
    let resetConfig: Bool
    let launchAtLoginCommand: LaunchAtLoginCommand?
}

struct ReceiverError: LocalizedError, Sendable {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    static let usage = ReceiverError("usage")

    var errorDescription: String? {
        message == "usage" ? nil : message
    }
}

private let screenCaptureKitErrorDomain = "com.apple.ScreenCaptureKit.SCStreamErrorDomain"
private let screenCapturePermissionDeniedCode = -3801

extension ReceiverError {
    static let screenRecordingDenied = ReceiverError(
        "Screen Recording permission is denied. Re-enable \(AppIdentity.appDisplayName) in System Settings -> Privacy & Security -> Screen Recording, then retry."
    )

    static let microphoneDenied = ReceiverError(
        "Microphone permission is denied. Re-enable \(AppIdentity.appDisplayName) in System Settings -> Privacy & Security -> Microphone, then retry."
    )

    static let telepathyPaused = ReceiverError(
        "\(AppIdentity.appDisplayName) is paused from the menu bar toggle."
    )

    static let pullScreenshotsDisabled = ReceiverError(
        "Agent screenshot requests are disabled in \(AppIdentity.appDisplayName) settings."
    )
}

struct NormalizedReceiverIssue: Sendable {
    let state: ReceiverConnectionState
    let message: String
}

func normalizeReceiverIssue(_ error: Error, serverURL: URL? = nil) -> NormalizedReceiverIssue {
    if let receiverError = error as? ReceiverError {
        if receiverError.message == ReceiverError.screenRecordingDenied.message {
            return NormalizedReceiverIssue(state: .screenRecordingDenied, message: receiverError.message)
        }

        return NormalizedReceiverIssue(state: .error, message: receiverError.message)
    }

    let nsError = error as NSError
    if nsError.domain == screenCaptureKitErrorDomain && nsError.code == screenCapturePermissionDeniedCode {
        return NormalizedReceiverIssue(
            state: .screenRecordingDenied,
            message: ReceiverError.screenRecordingDenied.message
        )
    }

    if nsError.domain == NSURLErrorDomain {
        switch nsError.code {
        case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost:
            if let serverURL {
                let host = serverURL.host ?? serverURL.absoluteString
                let port = serverURL.port.map { ":\($0)" } ?? ""
                return NormalizedReceiverIssue(
                    state: .waitingForPanda,
                    message: "Waiting for Panda at \(host)\(port)"
                )
            }
            return NormalizedReceiverIssue(state: .waitingForPanda, message: "Waiting for Panda")
        case NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet:
            return NormalizedReceiverIssue(
                state: .reconnecting,
                message: "Panda connection dropped. Reconnecting…"
            )
        default:
            break
        }
    }

    if nsError.domain == NSPOSIXErrorDomain && nsError.code == 57 {
        return NormalizedReceiverIssue(
            state: .reconnecting,
            message: "Panda connection dropped. Reconnecting…"
        )
    }

    return NormalizedReceiverIssue(state: .error, message: String(describing: error))
}

func normalizeReceiverError(_ error: Error, serverURL: URL? = nil) -> ReceiverError {
    ReceiverError(normalizeReceiverIssue(error, serverURL: serverURL).message)
}

func isScreenRecordingDeniedError(_ error: Error) -> Bool {
    normalizeReceiverIssue(error).state == .screenRecordingDenied
}

struct DeviceHello: Encodable {
    let type = "device.hello"
    let agentKey: String
    let deviceId: String
    let token: String
    let label: String?
}

struct DeviceReady: Decodable {
    let type: String
    let agentKey: String
    let deviceId: String
}

struct ContextAccepted: Decodable {
    let type: String
    let requestId: String
}

struct ScreenshotRequest: Decodable {
    let type: String
    let requestId: String
}

struct ScreenshotSuccess: Encodable {
    let type = "screenshot.result"
    let requestId: String
    let ok = true
    let mimeType: String
    let data: String
    let bytes: Int
}

struct ScreenshotFailure: Encodable {
    let type = "screenshot.result"
    let requestId: String
    let ok = false
    let error: String
}

struct RequestError: Decodable {
    let type: String
    let requestId: String?
    let error: String
}

enum TelepathyContextMode: String, Sendable {
    case pushToTalk = "push_to_talk"
}

struct ContextSubmitMetadata: Encodable, Sendable {
    let submittedAt: Int64
    let frontmostApp: String?
    let windowTitle: String?
    let trigger: String?
}

struct ContextTextItem: Encodable, Sendable {
    let type = "text"
    let text: String
}

struct ContextAudioItem: Encodable, Sendable {
    let type = "audio"
    let mimeType: String
    let data: String
    let bytes: Int
    let filename: String?
}

struct ContextImageItem: Encodable, Sendable {
    let type = "image"
    let mimeType: String
    let data: String
    let bytes: Int
    let filename: String?
}

enum ContextSubmitItem: Encodable, Sendable {
    case text(ContextTextItem)
    case audio(ContextAudioItem)
    case image(ContextImageItem)

    func encode(to encoder: Encoder) throws {
        switch self {
        case .text(let item):
            try item.encode(to: encoder)
        case .audio(let item):
            try item.encode(to: encoder)
        case .image(let item):
            try item.encode(to: encoder)
        }
    }
}

struct ContextSubmit: Encodable, Sendable {
    let type = "context.submit"
    let requestId: String
    let mode: String
    let items: [ContextSubmitItem]
    let metadata: ContextSubmitMetadata?
}

struct MessageEnvelope: Decodable {
    let type: String
}
