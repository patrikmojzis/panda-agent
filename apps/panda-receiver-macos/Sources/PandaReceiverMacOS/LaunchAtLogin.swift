import Foundation
import ServiceManagement

enum LaunchAtLoginCommand: String {
    case status
    case enable
    case disable
}

struct LaunchAtLoginInfo {
    let available: Bool
    let enabled: Bool
    let requiresApproval: Bool
    let detail: String
}

enum LaunchAtLoginManager {
    static func statusInfo() -> LaunchAtLoginInfo {
        guard isPackagedApp else {
            return LaunchAtLoginInfo(
                available: false,
                enabled: false,
                requiresApproval: false,
                detail: "Unavailable outside the packaged .app bundle"
            )
        }

        switch SMAppService.mainApp.status {
        case .enabled:
            return LaunchAtLoginInfo(available: true, enabled: true, requiresApproval: false, detail: "Enabled")
        case .notRegistered:
            return LaunchAtLoginInfo(available: true, enabled: false, requiresApproval: false, detail: "Disabled")
        case .requiresApproval:
            return LaunchAtLoginInfo(
                available: true,
                enabled: false,
                requiresApproval: true,
                detail: "Waiting for approval in System Settings"
            )
        case .notFound:
            return LaunchAtLoginInfo(
                available: true,
                enabled: false,
                requiresApproval: false,
                detail: "Service Management could not find this app bundle"
            )
        @unknown default:
            return LaunchAtLoginInfo(
                available: true,
                enabled: false,
                requiresApproval: false,
                detail: "Unknown Service Management state"
            )
        }
    }

    @discardableResult
    static func setEnabled(_ enabled: Bool) throws -> LaunchAtLoginInfo {
        guard isPackagedApp else {
            throw ReceiverError("Launch at login only works from the packaged .app bundle")
        }

        let currentInfo = statusInfo()
        if enabled == currentInfo.enabled && !currentInfo.requiresApproval {
            return currentInfo
        }

        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }

        let updatedInfo = statusInfo()
        if updatedInfo.requiresApproval {
            SMAppService.openSystemSettingsLoginItems()
        }

        return updatedInfo
    }

    static func handleCommand(_ command: LaunchAtLoginCommand) throws -> String {
        switch command {
        case .status:
            return statusInfo().detail
        case .enable:
            return try setEnabled(true).detail
        case .disable:
            return try setEnabled(false).detail
        }
    }

    private static var isPackagedApp: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
            && Bundle.main.bundleIdentifier == AppIdentity.bundleIdentifier
    }
}
