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
    private let intervalStatusItem = NSMenuItem(title: "Interval: Stopped", action: nil, keyEquivalent: "")
    private let shortcutMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let launchAtLoginStatusItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private lazy var enableCaptureItem = NSMenuItem(title: "Gateway Enabled", action: #selector(toggleCaptureEnabled), keyEquivalent: "")
    private lazy var launchAtLoginToggleItem = NSMenuItem(title: "Open At Login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "l")
    private lazy var requestAccessItem = NSMenuItem(title: "Request Screen Recording Access", action: #selector(requestScreenRecordingAccess), keyEquivalent: "")
    private lazy var requestMicrophoneAccessItem = NSMenuItem(title: "Request Microphone Access", action: #selector(requestMicrophoneAccess), keyEquivalent: "")
    private lazy var testScreenshotItem = NSMenuItem(title: "Take Test Screenshot", action: #selector(takeTestScreenshot), keyEquivalent: "t")
    private lazy var sendClipboardTextItem = NSMenuItem(title: "Send Clipboard Text", action: #selector(sendClipboardText), keyEquivalent: "")
    private lazy var sendScreenshotNowItem = NSMenuItem(title: "Send Screenshot Now", action: #selector(sendScreenshotNow), keyEquivalent: "")
    private lazy var startIntervalItem = NSMenuItem(title: "Start Interval Screenshots", action: #selector(startIntervalScreenshots), keyEquivalent: "")
    private lazy var pauseIntervalItem = NSMenuItem(title: "Pause Interval Screenshots", action: #selector(pauseIntervalScreenshots), keyEquivalent: "")
    private lazy var resumeIntervalItem = NSMenuItem(title: "Resume Interval Screenshots", action: #selector(resumeIntervalScreenshots), keyEquivalent: "")
    private lazy var stopIntervalItem = NSMenuItem(title: "Stop Interval Screenshots", action: #selector(stopIntervalScreenshots), keyEquivalent: "")
    private lazy var settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
    private lazy var revealConfigItem = NSMenuItem(title: "Reveal Saved Config", action: #selector(revealSavedConfig), keyEquivalent: "")
    private lazy var quitItem = NSMenuItem(title: "Quit \(AppIdentity.appDisplayName)", action: #selector(quit), keyEquivalent: "q")
    private var latestStatus = ReceiverStatus(state: .starting, detail: "Starting Gateway receiver")
    private var latestPushStatus = PushToTalkStatus(detail: "Starting push-to-talk", isPreparing: false, isRecording: false, isSending: false)
    private var statusTask: Task<Void, Never>?
    private var settingsWindowController: SettingsWindowController?
    private var pushToTalkController: PushToTalkController?
    private var intervalController: IntervalScreenshotController?
    private let pushFeedback = PushToTalkFeedbackController()

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
        rebuildPushToTalkController()
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
        intervalStatusItem.isEnabled = false
        shortcutMenuItem.isEnabled = false
        launchAtLoginStatusItem.isEnabled = false

        enableCaptureItem.target = self
        launchAtLoginToggleItem.target = self
        requestAccessItem.target = self
        requestMicrophoneAccessItem.target = self
        testScreenshotItem.target = self
        sendClipboardTextItem.target = self
        sendScreenshotNowItem.target = self
        startIntervalItem.target = self
        pauseIntervalItem.target = self
        resumeIntervalItem.target = self
        stopIntervalItem.target = self
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
        menu.addItem(sendClipboardTextItem)
        menu.addItem(sendScreenshotNowItem)
        menu.addItem(intervalStatusItem)
        menu.addItem(startIntervalItem)
        menu.addItem(pauseIntervalItem)
        menu.addItem(resumeIntervalItem)
        menu.addItem(stopIntervalItem)
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
        testScreenshotItem.isEnabled = receiver != nil && currentConfig != nil && status.state != .disabled
        sendClipboardTextItem.isEnabled = receiver != nil && currentConfig != nil && status.state != .disabled
        sendScreenshotNowItem.isEnabled = receiver != nil && currentConfig != nil && status.state != .disabled
        revealConfigItem.isEnabled = currentConfig != nil
        applyIntervalMenu(for: status)
        refreshLaunchAtLoginState()
        updateButton(for: status)
    }

    private func updateButton(for status: ReceiverStatus) {
        guard let button = statusItem.button else {
            return
        }

        let symbolName: String
        if latestPushStatus.isPreparing {
            symbolName = "mic.circle.fill"
        } else if latestPushStatus.isRecording {
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

        if !shouldEnable {
            intervalController?.stop()
        }

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
    private func sendClipboardText() {
        guard let receiver else {
            openSettings(nil)
            return
        }

        let text = NSPasteboard.general.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else {
            presentAlert(
                title: "Clipboard Is Empty",
                message: "Copy text first, then choose Send Clipboard Text."
            )
            return
        }

        let frontmostApp = NSWorkspace.shared.frontmostApplication?.localizedName
        sendClipboardTextItem.isEnabled = false
        latestPushStatus = PushToTalkStatus(detail: "Sending clipboard text…", isPreparing: false, isRecording: false, isSending: true)
        apply(status: latestStatus)
        sendClipboardTextItem.isEnabled = false

        Task {
            do {
                try await receiver.sendClipboardText(text, frontmostApp: frontmostApp)
                let time = DateFormatter.localizedString(
                    from: Date(),
                    dateStyle: .none,
                    timeStyle: .medium
                )
                await MainActor.run {
                    self.latestPushStatus = PushToTalkStatus(
                        detail: "Last sent clipboard text at \(time)",
                        isPreparing: false,
                        isRecording: false,
                        isSending: false
                    )
                    self.apply(status: self.latestStatus)
                }
            } catch {
                await MainActor.run {
                    self.latestPushStatus = PushToTalkStatus(
                        detail: "Ready: \(self.currentConfig?.pushToTalkShortcuts.voiceOnly.displayLabel ?? "Push")",
                        isPreparing: false,
                        isRecording: false,
                        isSending: false
                    )
                    self.apply(status: self.latestStatus)
                    self.presentAlert(
                        title: "Clipboard Send Failed",
                        message: normalizeReceiverError(error).message
                    )
                }
            }
        }
    }

    @objc
    private func sendScreenshotNow() {
        guard let receiver else {
            openSettings(nil)
            return
        }

        let frontmostApp = NSWorkspace.shared.frontmostApplication?.localizedName
        sendScreenshotNowItem.isEnabled = false
        latestPushStatus = PushToTalkStatus(detail: "Sending screenshot…", isPreparing: false, isRecording: false, isSending: true)
        apply(status: latestStatus)
        sendScreenshotNowItem.isEnabled = false

        Task {
            do {
                try await receiver.sendScreenshotNow(frontmostApp: frontmostApp)
                let time = DateFormatter.localizedString(
                    from: Date(),
                    dateStyle: .none,
                    timeStyle: .medium
                )
                await MainActor.run {
                    self.permissionMenuItem.title = self.screenRecordingLabel()
                    self.latestPushStatus = PushToTalkStatus(
                        detail: "Last sent screenshot at \(time)",
                        isPreparing: false,
                        isRecording: false,
                        isSending: false
                    )
                    self.apply(status: self.latestStatus)
                }
            } catch {
                await MainActor.run {
                    self.permissionMenuItem.title = self.screenRecordingLabel()
                    self.latestPushStatus = PushToTalkStatus(
                        detail: "Ready: \(self.currentConfig?.pushToTalkShortcuts.voiceOnly.displayLabel ?? "Push")",
                        isPreparing: false,
                        isRecording: false,
                        isSending: false
                    )
                    self.apply(status: self.latestStatus)
                    let normalizedError = normalizeReceiverError(error)
                    if normalizedError.message == ReceiverError.screenRecordingDenied.message {
                        self.presentScreenRecordingDeniedAlert(message: normalizedError.message)
                    } else {
                        self.presentAlert(
                            title: "Screenshot Send Failed",
                            message: normalizedError.message
                        )
                    }
                }
            }
        }
    }

    @objc
    private func openSettings(_ sender: Any?) {
        if let settingsWindowController,
           settingsWindowController.window?.isVisible == true {
            settingsWindowController.showWindow(sender)
            return
        }

        pausePushToTalkForSettings()
        let controller = SettingsWindowController(
            initialConfig: currentConfig,
            onSave: { [weak self] config in
                guard let self else {
                    return
                }

                await self.applySavedConfig(config)
            },
            onClose: { [weak self] in
                Task { @MainActor in
                    self?.resumePushToTalkAfterSettings()
                }
            }
        )
        settingsWindowController = controller
        controller.showWindow(sender)
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
        rebuildPushToTalkController()
        await replaceReceiver(with: config)
    }

    private func replaceReceiver(with config: Config) async {
        intervalController?.stop()
        intervalController = nil

        if let receiver {
            await receiver.shutdown()
        }
        receiver = nil

        latestStatus = ReceiverStatus(state: .starting, detail: "Starting Gateway receiver")
        apply(status: latestStatus)

        let newReceiver = ReceiverService(
            config: config,
            statusContinuation: statusContinuation
        )
        receiver = newReceiver
        await newReceiver.start()

        intervalController = makeIntervalScreenshotController(for: config, receiver: newReceiver)
        applyIntervalMenu(for: latestStatus)
    }

    private func rebuildPushToTalkController() {
        let oldController = pushToTalkController
        pushToTalkController = nil
        oldController?.cancel()
        do {
            pushToTalkController = try PushToTalkController(
                shortcutBindings: currentConfig?.pushToTalkShortcuts ?? .defaults,
                receiverProvider: { [weak self] in self?.receiver },
                onStatusChanged: { [weak self] status in
                    guard let self else {
                        return
                    }

                    self.latestPushStatus = status
                    self.pushFeedback.handle(status: status)
                    self.apply(status: self.latestStatus)
                },
                onError: { [weak self] error in
                    guard let self else {
                        return
                    }

                    let normalizedError = normalizeReceiverError(error)
                    self.pushFeedback.presentError(normalizedError.message)
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
            pushToTalkController = nil
            presentAlert(
                title: "Push-to-Talk Failed",
                message: String(describing: error)
            )
        }
    }

    private func pausePushToTalkForSettings() {
        let oldController = pushToTalkController
        pushToTalkController = nil
        oldController?.cancel()
        latestPushStatus = PushToTalkStatus(
            detail: "Paused while Settings is open",
            isPreparing: false,
            isRecording: false,
            isSending: false
        )
        apply(status: latestStatus)
    }

    private func resumePushToTalkAfterSettings() {
        settingsWindowController = nil
        guard currentConfig != nil, pushToTalkController == nil else {
            return
        }

        rebuildPushToTalkController()
        apply(status: latestStatus)
    }



    private func applyIntervalMenu(for status: ReceiverStatus) {
        guard let currentConfig else {
            intervalStatusItem.title = "Interval: Not configured"
            startIntervalItem.isEnabled = false
            pauseIntervalItem.isEnabled = false
            resumeIntervalItem.isEnabled = false
            stopIntervalItem.isEnabled = false
            return
        }

        let receiverAvailable = receiver != nil && status.state != .disabled
        let controllerState = intervalController?.state ?? .stopped
        intervalStatusItem.title = intervalMenuLabel(
            state: controllerState,
            intervalSeconds: currentConfig.intervalScreenshots.intervalSeconds,
            transientErrorMessage: intervalController?.transientErrorMessage
        )

        startIntervalItem.isEnabled = receiverAvailable && (controllerState == .stopped || isIntervalErrorState(controllerState))
        pauseIntervalItem.isEnabled = receiverAvailable && isIntervalRunningState(controllerState)
        resumeIntervalItem.isEnabled = receiverAvailable && isIntervalPausedState(controllerState)
        stopIntervalItem.isEnabled = receiverAvailable && controllerState != .stopped
    }

    private func isIntervalRunningState(_ state: IntervalScreenshotState) -> Bool {
        switch state {
        case .running, .sending:
            return true
        default:
            return false
        }
    }

    private func isIntervalPausedState(_ state: IntervalScreenshotState) -> Bool {
        switch state {
        case .paused:
            return true
        default:
            return false
        }
    }

    private func isIntervalErrorState(_ state: IntervalScreenshotState) -> Bool {
        switch state {
        case .error:
            return true
        default:
            return false
        }
    }

    private func intervalMenuLabel(
        state: IntervalScreenshotState,
        intervalSeconds: UInt64,
        transientErrorMessage: String?
    ) -> String {
        let minutes = max(UInt64(1), intervalSeconds / 60)
        let intervalLabel = "every \(minutes) min"

        func timeLabel(_ date: Date) -> String {
            DateFormatter.localizedString(from: date, dateStyle: .none, timeStyle: .short)
        }

        let transientSuffix: String
        if let transientErrorMessage, !transientErrorMessage.isEmpty {
            transientSuffix = " (last error: \(transientErrorMessage))"
        } else {
            transientSuffix = ""
        }

        switch state {
        case .stopped:
            return "Interval: Stopped"
        case .running(let nextCaptureAt, let lastSentAt):
            let lastLabel = lastSentAt.map(timeLabel) ?? "never"
            return "Interval: Running \(intervalLabel); next \(timeLabel(nextCaptureAt)); last \(lastLabel)\(transientSuffix)"
        case .sending(let nextCaptureAt, let lastSentAt):
            let lastLabel = lastSentAt.map(timeLabel) ?? "never"
            return "Interval: Sending… next \(timeLabel(nextCaptureAt)); last \(lastLabel)\(transientSuffix)"
        case .paused(let lastSentAt):
            let lastLabel = lastSentAt.map(timeLabel) ?? "never"
            return "Interval: Paused; last \(lastLabel)"
        case .error(let message, _):
            return "Interval: Error: \(message)"
        }
    }

    private func makeIntervalScreenshotController(for config: Config, receiver: ReceiverService) -> IntervalScreenshotController {
        IntervalScreenshotController(
            intervalSeconds: config.intervalScreenshots.intervalSeconds,
            frontmostAppProvider: { NSWorkspace.shared.frontmostApplication?.localizedName },
            sendScreenshot: { frontmostApp, intervalSeconds in
                try await receiver.sendIntervalScreenshot(intervalSeconds: intervalSeconds, frontmostApp: frontmostApp)
            },
            onStateChanged: { [weak self] state in
                guard let self else {
                    return
                }

                self.applyIntervalMenu(for: self.latestStatus)

                if case .error(let message, _) = state {
                    if message == ReceiverError.screenRecordingDenied.message {
                        self.presentScreenRecordingDeniedAlert(message: message)
                    } else {
                        self.presentAlert(title: "Interval Screenshot Stopped", message: message)
                    }
                }
            }
        )
    }

    @objc
    private func startIntervalScreenshots() {
        guard currentConfig != nil else {
            openSettings(nil)
            return
        }

        intervalController?.start()
    }

    @objc
    private func pauseIntervalScreenshots() {
        intervalController?.pause()
    }

    @objc
    private func resumeIntervalScreenshots() {
        intervalController?.resume()
    }

    @objc
    private func stopIntervalScreenshots() {
        intervalController?.stop()
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
