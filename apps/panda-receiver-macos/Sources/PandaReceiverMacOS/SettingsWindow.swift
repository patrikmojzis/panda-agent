import AppKit
import Foundation

private let settingsWindowWidth: CGFloat = 760
private let settingsWindowHeight: CGFloat = 600
private let sectionTextWidth: CGFloat = 620
private let formLabelWidth: CGFloat = 120
private let formFieldWidth: CGFloat = 470

@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate {
    private let onSave: (Config) async -> Void
    private let onClose: () -> Void
    private let serverField = NSTextField(string: "")
    private let agentField = NSTextField(string: "")
    private let deviceField = NSTextField(string: "")
    private let tokenField = NSSecureTextField(string: "")
    private let labelField = NSTextField(string: "")
    private let reconnectField = NSTextField(string: "2")
    private let tunnelHostField = NSTextField(string: "")
    private let tunnelUserField = NSTextField(string: "")
    private let tunnelPortField = NSTextField(string: "22")
    private let tunnelLocalPortField = NSTextField(string: "43190")
    private let allowPullScreenshotsButton = NSButton(checkboxWithTitle: "Allow Panda to take screenshots on request", target: nil, action: nil)
    private let statusLabel = NSTextField(labelWithString: "")
    private let saveButton = NSButton(title: "Save", target: nil, action: nil)
    private let cancelButton = NSButton(title: "Close", target: nil, action: nil)
    private var voiceShortcut = PushToTalkShortcutConfig.defaultVoiceOnly
    private var voiceWithScreenshotShortcut = PushToTalkShortcutConfig.defaultVoiceWithScreenshot

    private lazy var voiceShortcutField = ShortcutRecorderField(shortcut: voiceShortcut) { [weak self] shortcut in
        self?.voiceShortcut = shortcut
    }
    private lazy var voiceWithScreenshotShortcutField = ShortcutRecorderField(shortcut: voiceWithScreenshotShortcut) { [weak self] shortcut in
        self?.voiceWithScreenshotShortcut = shortcut
    }
    private lazy var resetVoiceShortcutButton = makeShortcutResetButton(action: #selector(resetVoiceShortcut))
    private lazy var resetVoiceWithScreenshotShortcutButton = makeShortcutResetButton(action: #selector(resetVoiceWithScreenshotShortcut))

    init(initialConfig: Config?, onSave: @escaping (Config) async -> Void, onClose: @escaping () -> Void = {}) {
        self.onSave = onSave
        self.onClose = onClose

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: settingsWindowWidth, height: settingsWindowHeight),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "\(AppIdentity.appDisplayName) Settings"
        window.isReleasedWhenClosed = false
        super.init(window: window)

        applyInitialConfig(initialConfig)
        configureWindow()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)
        window?.makeKeyAndOrderFront(sender)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        statusLabel.stringValue = ""
        onClose()
    }

    private func configureWindow() {
        guard let window else {
            return
        }

        window.delegate = self
        window.center()
        window.contentView = buildContentView()
    }

    private func buildContentView() -> NSView {
        let contentView = NSView(frame: NSRect(x: 0, y: 0, width: settingsWindowWidth, height: settingsWindowHeight))

        let iconView = NSImageView()
        iconView.image = NSApp.applicationIconImage
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 72),
            iconView.heightAnchor.constraint(equalToConstant: 72),
        ])

        let titleLabel = NSTextField(labelWithString: "Set up \(AppIdentity.appDisplayName)")
        titleLabel.font = .systemFont(ofSize: 24, weight: .semibold)

        let subtitleLabel = wrappingLabel(
            "Connection, identity, push-to-talk, and tunnel settings live here. Shortcuts are saved locally and take effect after you hit Save.",
            width: sectionTextWidth - 80,
            font: .systemFont(ofSize: 13)
        )

        let titleStack = verticalStack([titleLabel, subtitleLabel], spacing: 8, alignment: .leading)
        let headerStack = horizontalStack([iconView, titleStack], spacing: 18, alignment: .top)

        let tabView = buildTabView()

        statusLabel.textColor = .systemRed
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 0
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        saveButton.target = self
        saveButton.action = #selector(savePressed)
        saveButton.bezelStyle = .rounded
        saveButton.keyEquivalent = "\r"
        saveButton.controlSize = .large

        cancelButton.target = self
        cancelButton.action = #selector(closePressed)
        cancelButton.bezelStyle = .rounded
        cancelButton.controlSize = .large

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let buttonStack = horizontalStack([spacer, cancelButton, saveButton], spacing: 12, alignment: .centerY)

        contentView.addSubview(headerStack)
        contentView.addSubview(tabView)
        contentView.addSubview(statusLabel)
        contentView.addSubview(buttonStack)

        NSLayoutConstraint.activate([
            headerStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 32),
            headerStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -32),
            headerStack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 24),

            tabView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 32),
            tabView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -32),
            tabView.topAnchor.constraint(equalTo: headerStack.bottomAnchor, constant: 22),

            statusLabel.leadingAnchor.constraint(equalTo: tabView.leadingAnchor),
            statusLabel.trailingAnchor.constraint(equalTo: tabView.trailingAnchor),
            statusLabel.topAnchor.constraint(equalTo: tabView.bottomAnchor, constant: 12),

            buttonStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -32),
            buttonStack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -24),
        ])

        return contentView
    }

    private func buildTabView() -> NSTabView {
        let tabView = NSTabView()
        tabView.translatesAutoresizingMaskIntoConstraints = false
        tabView.tabViewType = .topTabsBezelBorder
        tabView.addTabViewItem(
            makeTabItem(
                title: "Connection",
                subtitle: "Where Panda Telepathy connects and how aggressively it retries.",
                rows: [
                    formRow(
                        title: "Server URL",
                        control: serverField,
                        help: "Usually ws://127.0.0.1:8787/telepathy through your local tunnel."
                    ),
                    formRow(
                        title: "Reconnect",
                        control: reconnectField,
                        help: "How long the app waits before trying again after a disconnect."
                    ),
                ]
            )
        )
        tabView.addTabViewItem(
            makeTabItem(
                title: "Identity",
                subtitle: "This is how Panda knows which Mac just checked in.",
                rows: [
                    formRow(
                        title: "Agent Key",
                        control: agentField,
                        help: "Your Panda persona key, like panda or clawd."
                    ),
                    formRow(
                        title: "Device ID",
                        control: deviceField,
                        help: "Stable machine id. Keep it short and boring."
                    ),
                    formRow(
                        title: "Label",
                        control: labelField,
                        help: "Human-friendly name shown in SQL and the UI."
                    ),
                    formRow(
                        title: "Token",
                        control: tokenField,
                        help: "Paste the device token from `panda telepathy register ...`."
                    ),
                ]
            )
        )
        tabView.addTabViewItem(
            makeTabItem(
                title: "Push-To-Talk",
                subtitle: "Use one shortcut for voice only and one for voice plus screenshot.",
                rows: [
                    shortcutRow(
                        title: "Voice Only",
                        recorder: voiceShortcutField,
                        resetButton: resetVoiceShortcutButton,
                        help: "Records audio and sends it without a screenshot."
                    ),
                    shortcutRow(
                        title: "Voice + Screen",
                        recorder: voiceWithScreenshotShortcutField,
                        resetButton: resetVoiceWithScreenshotShortcutButton,
                        help: "Records audio and grabs a fresh screenshot on release."
                    ),
                    noteRow("Press `Esc` while capturing a shortcut to cancel."),
                ]
            )
        )
        tabView.addTabViewItem(
            makeTabItem(
                title: "SSH Tunnel",
                subtitle: "Leave this empty for a direct local connection. When filled, the app owns `ssh -L` and reaches Panda through the forwarded port.",
                rows: [
                    formRow(
                        title: "SSH Host",
                        control: tunnelHostField,
                        help: "Usually your VPS alias, like clankerino."
                    ),
                    formRow(
                        title: "SSH User",
                        control: tunnelUserField,
                        help: "Optional if your SSH config already knows the user."
                    ),
                    formRow(
                        title: "SSH Port",
                        control: tunnelPortField,
                        help: "Defaults to 22."
                    ),
                    formRow(
                        title: "Local Port",
                        control: tunnelLocalPortField,
                        help: "Local forwarded port used by the app to reach Panda."
                    ),
                ]
            )
        )
        tabView.addTabViewItem(
            makeTabItem(
                title: "Privacy",
                subtitle: "Use this when you want push-to-talk to stay live but do not want Panda pulling screenshots from your screen.",
                rows: [
                    toggleRow(
                        title: "Pull Screenshots",
                        control: allowPullScreenshotsButton,
                        help: "When off, `telepathy_screenshot(...)` and other agent-driven screenshot pulls are rejected. Local push-to-talk still works."
                    ),
                ]
            )
        )
        tabView.heightAnchor.constraint(equalToConstant: 350).isActive = true
        return tabView
    }

    private func applyInitialConfig(_ config: Config?) {
        serverField.placeholderString = "ws://127.0.0.1:8787/telepathy"
        agentField.placeholderString = "panda"
        deviceField.placeholderString = "local-mac"
        tokenField.placeholderString = "device token"
        labelField.placeholderString = "Patrik MacBook"
        reconnectField.placeholderString = "2"
        tunnelHostField.placeholderString = "clankerino"
        tunnelUserField.placeholderString = "patrikmojzis"
        tunnelPortField.placeholderString = "22"
        tunnelLocalPortField.placeholderString = "43190"
        allowPullScreenshotsButton.state = .on

        let resolvedConfig = config
        voiceShortcut = resolvedConfig?.pushToTalkShortcuts.voiceOnly ?? .defaultVoiceOnly
        voiceWithScreenshotShortcut = resolvedConfig?.pushToTalkShortcuts.voiceWithScreenshot ?? .defaultVoiceWithScreenshot

        guard let config else {
            return
        }

        serverField.stringValue = config.serverURL.absoluteString
        agentField.stringValue = config.agentKey
        deviceField.stringValue = config.deviceId
        tokenField.stringValue = config.token
        labelField.stringValue = config.label ?? ""
        reconnectField.stringValue = String(config.reconnectDelaySeconds)
        tunnelHostField.stringValue = config.tunnel?.host ?? ""
        tunnelUserField.stringValue = config.tunnel?.user ?? ""
        tunnelPortField.stringValue = String(config.tunnel?.sshPort ?? 22)
        tunnelLocalPortField.stringValue = String(config.tunnel?.localPort ?? 43190)
        allowPullScreenshotsButton.state = config.allowPullScreenshots ? .on : .off
    }

    @objc
    private func savePressed() {
        saveButton.isEnabled = false
        Task { @MainActor in
            do {
                let config = try Config.make(
                    serverURLRaw: serverField.stringValue,
                    agentKeyRaw: agentField.stringValue,
                    deviceIdRaw: deviceField.stringValue,
                    tokenRaw: tokenField.stringValue,
                    labelRaw: labelField.stringValue,
                    reconnectDelayRaw: reconnectField.stringValue,
                    tunnelHostRaw: tunnelHostField.stringValue,
                    tunnelUserRaw: tunnelUserField.stringValue,
                    tunnelPortRaw: tunnelPortField.stringValue,
                    tunnelLocalPortRaw: tunnelLocalPortField.stringValue,
                    allowPullScreenshots: allowPullScreenshotsButton.state == .on,
                    pushToTalkShortcuts: PushToTalkShortcutBindings(
                        voiceOnly: voiceShortcut,
                        voiceWithScreenshot: voiceWithScreenshotShortcut
                    )
                )
                try ConfigStore.save(config)
                statusLabel.stringValue = ""
                await onSave(config)
                close()
            } catch {
                saveButton.isEnabled = true
                statusLabel.stringValue = String(describing: error)
            }
        }
    }

    @objc
    private func closePressed() {
        close()
    }

    @objc
    private func resetVoiceShortcut() {
        voiceShortcutField.reset(to: .defaultVoiceOnly)
    }

    @objc
    private func resetVoiceWithScreenshotShortcut() {
        voiceWithScreenshotShortcutField.reset(to: .defaultVoiceWithScreenshot)
    }

    private func makeTabItem(title: String, subtitle: String, rows: [NSView]) -> NSTabViewItem {
        let item = NSTabViewItem(identifier: title)
        item.label = title

        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false

        let page = tabPage(subtitle: subtitle, rows: rows)
        container.addSubview(page)
        NSLayoutConstraint.activate([
            page.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 30),
            page.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -30),
            page.topAnchor.constraint(equalTo: container.topAnchor, constant: 30),
            page.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor, constant: -24),
        ])

        item.view = container
        return item
    }

    private func tabPage(subtitle: String, rows: [NSView]) -> NSView {
        let subtitleLabel = wrappingLabel(
            subtitle,
            width: sectionTextWidth,
            font: .systemFont(ofSize: 12)
        )

        let rowsStack = verticalStack(rows, spacing: 10, alignment: .width)
        return verticalStack([subtitleLabel, rowsStack], spacing: 14, alignment: .width)
    }

    private func formRow(title: String, control: NSTextField, help: String) -> NSView {
        control.controlSize = .large
        control.translatesAutoresizingMaskIntoConstraints = false
        control.widthAnchor.constraint(equalToConstant: formFieldWidth).isActive = true

        return labeledRow(
            title: title,
            content: verticalStack([control, wrappingLabel(help, width: formFieldWidth)], spacing: 6, alignment: .leading)
        )
    }

    private func shortcutRow(
        title: String,
        recorder: ShortcutRecorderField,
        resetButton: NSButton,
        help: String
    ) -> NSView {
        recorder.translatesAutoresizingMaskIntoConstraints = false
        recorder.widthAnchor.constraint(equalToConstant: 220).isActive = true

        let controls = horizontalStack([recorder, resetButton], spacing: 10, alignment: .centerY)
        let content = verticalStack([controls, wrappingLabel(help, width: formFieldWidth)], spacing: 6, alignment: .leading)
        return labeledRow(title: title, content: content)
    }

    private func toggleRow(title: String, control: NSButton, help: String) -> NSView {
        control.setButtonType(.switch)
        let content = verticalStack([control, wrappingLabel(help, width: formFieldWidth)], spacing: 6, alignment: .leading)
        return labeledRow(title: title, content: content)
    }

    private func noteRow(_ text: String) -> NSView {
        let spacer = NSTextField(labelWithString: "")
        spacer.translatesAutoresizingMaskIntoConstraints = false
        spacer.widthAnchor.constraint(equalToConstant: formLabelWidth).isActive = true
        let note = wrappingLabel(text, width: formFieldWidth)
        return horizontalStack([spacer, note], spacing: 16, alignment: .top)
    }

    private func labeledRow(title: String, content: NSView) -> NSView {
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: 12, weight: .medium)
        titleLabel.textColor = .secondaryLabelColor
        titleLabel.alignment = .right
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.widthAnchor.constraint(equalToConstant: formLabelWidth).isActive = true

        return horizontalStack([titleLabel, content], spacing: 16, alignment: .top)
    }

    private func verticalStack(
        _ views: [NSView],
        spacing: CGFloat,
        alignment: NSLayoutConstraint.Attribute
    ) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = alignment
        stack.spacing = spacing
        stack.translatesAutoresizingMaskIntoConstraints = false
        return stack
    }

    private func horizontalStack(
        _ views: [NSView],
        spacing: CGFloat,
        alignment: NSLayoutConstraint.Attribute
    ) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.alignment = alignment
        stack.spacing = spacing
        stack.translatesAutoresizingMaskIntoConstraints = false
        return stack
    }

    private func makeShortcutResetButton(action: Selector) -> NSButton {
        let button = NSButton(title: "Reset", target: self, action: action)
        button.bezelStyle = .rounded
        return button
    }

    private func wrappingLabel(
        _ text: String,
        width: CGFloat,
        textColor: NSColor = .secondaryLabelColor,
        font: NSFont? = nil
    ) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.textColor = textColor
        if let font {
            label.font = font
        }
        label.translatesAutoresizingMaskIntoConstraints = false
        label.widthAnchor.constraint(equalToConstant: width).isActive = true
        return label
    }
}
