import AppKit
import AVFoundation
import CoreGraphics
import Foundation

@MainActor
final class MenuBarAppController: NSObject, NSApplicationDelegate {
    private var currentConfig: Config?
    private let statusStream: AsyncStream<ReceiverStatus>
    private let statusContinuation: AsyncStream<ReceiverStatus>.Continuation
    private var receiver: ReceiverService?
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let menu = NSMenu()
    private let titleItem = NSMenuItem(title: AppIdentity.appDisplayName, action: nil, keyEquivalent: "")
    private let statusMenuItem = NSMenuItem(title: "Status: Starting", action: nil, keyEquivalent: "")
    private let deviceMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let permissionMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let microphoneMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let pushStatusItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let shortcutMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let launchAtLoginStatusItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private lazy var enableCaptureItem = NSMenuItem(title: "Capture Enabled", action: #selector(toggleCaptureEnabled), keyEquivalent: "")
    private lazy var launchAtLoginToggleItem = NSMenuItem(title: "Open At Login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "l")
    private lazy var requestAccessItem = NSMenuItem(title: "Request Screen Recording Access", action: #selector(requestScreenRecordingAccess), keyEquivalent: "")
    private lazy var requestMicrophoneAccessItem = NSMenuItem(title: "Request Microphone Access", action: #selector(requestMicrophoneAccess), keyEquivalent: "")
    private lazy var testScreenshotItem = NSMenuItem(title: "Take Test Screenshot", action: #selector(takeTestScreenshot), keyEquivalent: "t")
    private lazy var settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
    private lazy var revealConfigItem = NSMenuItem(title: "Reveal Saved Config", action: #selector(revealSavedConfig), keyEquivalent: "")
    private lazy var quitItem = NSMenuItem(title: "Quit \(AppIdentity.appDisplayName)", action: #selector(quit), keyEquivalent: "q")
    private var latestStatus = ReceiverStatus(state: .starting, detail: "Starting receiver")
    private var latestPushStatus = PushToTalkStatus(detail: "Starting push-to-talk", isRecording: false, isSending: false)
    private var statusTask: Task<Void, Never>?
    private var settingsWindowController: SettingsWindowController?
    private var pushToTalkController: PushToTalkController?

    init(config: Config?) {
        self.currentConfig = config
        var continuation: AsyncStream<ReceiverStatus>.Continuation?
        self.statusStream = AsyncStream { streamContinuation in
            continuation = streamContinuation
        }
        self.statusContinuation = continuation!
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildMenu()
        do {
            pushToTalkController = try PushToTalkController(
                receiverProvider: { [weak self] in self?.receiver },
                onStatusChanged: { [weak self] status in
                    guard let self else {
                        return
                    }

                    self.latestPushStatus = status
                    self.apply(status: self.latestStatus)
                },
                onError: { [weak self] error in
                    guard let self else {
                        return
                    }

                    let normalizedError = normalizeReceiverError(error)
                    if normalizedError.message == ReceiverError.microphoneDenied.message {
                        self.presentMicrophoneDeniedAlert(message: normalizedError.message)
                    } else if normalizedError.message == ReceiverError.screenRecordingDenied.message {
                        self.presentScreenRecordingDeniedAlert(message: normalizedError.message)
                    } else {
                        self.presentAlert(
                            title: "Push-to-Talk Failed",
                            message: normalizedError.message
                        )
                    }
                }
            )
        } catch {
            presentAlert(
                title: "Push-to-Talk Failed",
                message: String(describing: error)
            )
        }
        statusTask = Task {
            for await status in statusStream {
                latestStatus = status
                apply(status: status)
            }
        }

        if let currentConfig {
            Task {
                await replaceReceiver(with: currentConfig)
            }
        } else {
            latestStatus = ReceiverStatus(state: .disabled, detail: "Receiver is not configured")
            apply(status: latestStatus)
            openSettings(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        statusTask?.cancel()
        statusContinuation.finish()
        pushToTalkController?.cancel()
        Task {
            await receiver?.shutdown()
        }
    }

    private func buildMenu() {
        titleItem.isEnabled = false
        statusMenuItem.isEnabled = false
        deviceMenuItem.isEnabled = false
        permissionMenuItem.isEnabled = false
        microphoneMenuItem.isEnabled = false
        pushStatusItem.isEnabled = false
        shortcutMenuItem.isEnabled = false
        launchAtLoginStatusItem.isEnabled = false

        enableCaptureItem.target = self
        launchAtLoginToggleItem.target = self
        requestAccessItem.target = self
        requestMicrophoneAccessItem.target = self
        testScreenshotItem.target = self
        settingsItem.target = self
        revealConfigItem.target = self
        quitItem.target = self

        menu.addItem(titleItem)
        menu.addItem(statusMenuItem)
        menu.addItem(deviceMenuItem)
        menu.addItem(permissionMenuItem)
        menu.addItem(microphoneMenuItem)
        menu.addItem(pushStatusItem)
        menu.addItem(shortcutMenuItem)
        menu.addItem(launchAtLoginStatusItem)
        menu.addItem(.separator())
        menu.addItem(enableCaptureItem)
        menu.addItem(launchAtLoginToggleItem)
        menu.addItem(requestAccessItem)
        menu.addItem(requestMicrophoneAccessItem)
        menu.addItem(testScreenshotItem)
        menu.addItem(settingsItem)
        menu.addItem(revealConfigItem)
        menu.addItem(.separator())
        menu.addItem(quitItem)

        statusItem.menu = menu
        guard let button = statusItem.button else {
            return
        }

        button.imagePosition = .imageOnly
        button.toolTip = AppIdentity.appDisplayName
    }

    private func apply(status: ReceiverStatus) {
        statusMenuItem.title = "Status: \(menuLabel(for: status))"
        if let currentConfig {
            deviceMenuItem.title = "Device: \(currentConfig.displayName) (\(currentConfig.deviceId))"
        } else {
            deviceMenuItem.title = "Device: Not configured"
        }
        permissionMenuItem.title = screenRecordingLabel()
        microphoneMenuItem.title = microphoneLabel()
        pushStatusItem.title = "Push-to-Talk: \(latestPushStatus.detail)"
        shortcutMenuItem.title = "Shortcuts: \(pushToTalkController?.shortcutsDescription() ?? "Unavailable")"
        enableCaptureItem.state = status.state == .disabled ? .off : .on
        enableCaptureItem.isEnabled = currentConfig != nil
        testScreenshotItem.isEnabled = currentConfig != nil && status.state != .disabled
        revealConfigItem.isEnabled = currentConfig != nil
        refreshLaunchAtLoginState()
        updateButton(for: status)
    }

    private func updateButton(for status: ReceiverStatus) {
        guard let button = statusItem.button else {
            return
        }

        let symbolName: String
        if latestPushStatus.isRecording {
            symbolName = "mic.fill"
        } else if latestPushStatus.isSending {
            symbolName = "waveform.circle"
        } else {
            switch status.state {
            case .starting:
                symbolName = "sparkle"
            case .connecting:
                symbolName = "arrow.triangle.2.circlepath"
            case .waitingForPanda:
                symbolName = "hourglass.circle"
            case .reconnecting:
                symbolName = "arrow.clockwise.circle"
            case .connected:
                symbolName = "dot.radiowaves.left.and.right"
            case .screenRecordingDenied:
                symbolName = "eye.slash"
            case .disabled:
                symbolName = "pause.circle"
            case .error:
                symbolName = "exclamationmark.triangle"
            }
        }

        let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: AppIdentity.appDisplayName)
        image?.isTemplate = true
        button.image = image
        button.toolTip = "\(AppIdentity.appDisplayName)\n\(status.detail)\n\(latestPushStatus.detail)"
    }

    private func menuLabel(for status: ReceiverStatus) -> String {
        if currentConfig == nil {
            return "Needs setup"
        }

        switch status.state {
        case .starting:
            return "Starting"
        case .connecting:
            return status.detail
        case .waitingForPanda:
            return status.detail
        case .reconnecting:
            return status.detail
        case .connected:
            return status.detail
        case .screenRecordingDenied:
            return "Screen Recording Denied"
        case .disabled:
            return "Disabled"
        case .error:
            return "Error: \(status.detail)"
        }
    }

    private func screenRecordingLabel() -> String {
        let granted = CGPreflightScreenCaptureAccess()
        if granted {
            return "Screen Recording: Granted"
        }

        if latestStatus.detail == ReceiverError.screenRecordingDenied.message {
            return "Screen Recording: Denied"
        }

        return "Screen Recording: Missing"
    }

    private func microphoneLabel() -> String {
        switch MicrophoneAccess.status() {
        case .authorized:
            return "Microphone: Granted"
        case .denied, .restricted:
            return "Microphone: Denied"
        case .notDetermined:
            return "Microphone: Missing"
        @unknown default:
            return "Microphone: Unknown"
        }
    }

    private func refreshLaunchAtLoginState() {
        let info = LaunchAtLoginManager.statusInfo()
        launchAtLoginStatusItem.title = "Open at login: \(info.detail)"
        launchAtLoginToggleItem.state = info.enabled ? .on : .off
        launchAtLoginToggleItem.isEnabled = info.available
    }

    @objc
    private func toggleCaptureEnabled() {
        guard receiver != nil else {
            openSettings(nil)
            return
        }

        let shouldEnable = enableCaptureItem.state == .off
        enableCaptureItem.isEnabled = false

        Task {
            await receiver?.setEnabled(shouldEnable)
            await MainActor.run {
                self.enableCaptureItem.isEnabled = true
            }
        }
    }

    @objc
    private func toggleLaunchAtLogin() {
        let shouldEnable = launchAtLoginToggleItem.state == .off
        launchAtLoginToggleItem.isEnabled = false

        do {
            let info = try LaunchAtLoginManager.setEnabled(shouldEnable)
            refreshLaunchAtLoginState()
            if info.requiresApproval {
                presentAlert(
                    title: "Approval Needed",
                    message: "macOS wants you to approve \(AppIdentity.appDisplayName) in Login Items."
                )
            }
        } catch {
            refreshLaunchAtLoginState()
            presentAlert(
                title: "Open At Login Failed",
                message: String(describing: error)
            )
        }
    }

    @objc
    private func requestScreenRecordingAccess() {
        let granted = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
        permissionMenuItem.title = screenRecordingLabel()

        if !granted, let settingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(settingsURL)
        }
    }

    @objc
    private func requestMicrophoneAccess() {
        Task { @MainActor in
            let granted = await MicrophoneAccess.requestIfNeeded()
            self.microphoneMenuItem.title = self.microphoneLabel()
            if !granted,
               let settingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                NSWorkspace.shared.open(settingsURL)
            }
        }
    }

    @objc
    private func takeTestScreenshot() {
        guard receiver != nil else {
            openSettings(nil)
            return
        }

        testScreenshotItem.isEnabled = false

        Task {
            do {
                let screenshotURL = try await receiver?.captureTestScreenshot()
                await MainActor.run {
                    self.testScreenshotItem.isEnabled = true
                    self.permissionMenuItem.title = self.screenRecordingLabel()
                    if let screenshotURL {
                        NSWorkspace.shared.open(screenshotURL)
                    }
                }
            } catch {
                await MainActor.run {
                    self.testScreenshotItem.isEnabled = self.currentConfig != nil && self.latestStatus.state != .disabled
                    self.permissionMenuItem.title = self.screenRecordingLabel()
                    let normalizedError = normalizeReceiverError(error)
                    if normalizedError.message == ReceiverError.screenRecordingDenied.message {
                        self.presentScreenRecordingDeniedAlert(message: normalizedError.message)
                    } else {
                        self.presentAlert(
                            title: "Test Screenshot Failed",
                            message: normalizedError.message
                        )
                    }
                }
            }
        }
    }

    @objc
    private func openSettings(_ sender: Any?) {
        if settingsWindowController == nil {
            settingsWindowController = SettingsWindowController(initialConfig: currentConfig) { [weak self] config in
                Task { @MainActor in
                    guard let self else {
                        return
                    }

                    await self.applySavedConfig(config)
                }
            }
        }

        settingsWindowController?.showWindow(sender)
    }

    @objc
    private func revealSavedConfig() {
        do {
            let configURL = try ConfigStore.defaultURL()
            let directoryURL = configURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)

            if FileManager.default.fileExists(atPath: configURL.path()) {
                NSWorkspace.shared.activateFileViewerSelecting([configURL])
            } else {
                NSWorkspace.shared.open(directoryURL)
            }
        } catch {
            presentAlert(
                title: "Could Not Reveal Config",
                message: String(describing: error)
            )
        }
    }

    @objc
    private func quit() {
        NSApp.terminate(nil)
    }

    private func applySavedConfig(_ config: Config) async {
        currentConfig = config
        settingsWindowController = nil
        await replaceReceiver(with: config)
    }

    private func replaceReceiver(with config: Config) async {
        if let receiver {
            await receiver.shutdown()
        }

        latestStatus = ReceiverStatus(state: .starting, detail: "Starting receiver")
        apply(status: latestStatus)

        let newReceiver = ReceiverService(config: config, statusContinuation: statusContinuation)
        receiver = newReceiver
        await newReceiver.start()
    }

    private func presentAlert(title: String, message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func presentScreenRecordingDeniedAlert(message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Screen Recording Needed"
        alert.informativeText = message
        alert.addButton(withTitle: "Open Settings")
        alert.addButton(withTitle: "Cancel")
        let response = alert.runModal()
        if response == .alertFirstButtonReturn,
           let settingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(settingsURL)
        }
    }

    private func presentMicrophoneDeniedAlert(message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Microphone Needed"
        alert.informativeText = message
        alert.addButton(withTitle: "Open Settings")
        alert.addButton(withTitle: "Cancel")
        let response = alert.runModal()
        if response == .alertFirstButtonReturn,
           let settingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
            NSWorkspace.shared.open(settingsURL)
        }
    }
}
