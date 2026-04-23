import AppKit
import Foundation

@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate {
    private let onSave: (Config) -> Void
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
    private let statusLabel = NSTextField(labelWithString: "")
    private let saveButton = NSButton(title: "Save", target: nil, action: nil)
    private let cancelButton = NSButton(title: "Close", target: nil, action: nil)

    init(initialConfig: Config?, onSave: @escaping (Config) -> Void) {
        self.onSave = onSave

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 600),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "\(AppIdentity.appDisplayName) Settings"
        window.isReleasedWhenClosed = false
        super.init(window: window)

        populateFields(using: initialConfig)
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
        let contentView = NSView(frame: NSRect(x: 0, y: 0, width: 560, height: 600))

        let iconView = NSImageView()
        iconView.image = NSApp.applicationIconImage
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 64),
            iconView.heightAnchor.constraint(equalToConstant: 64),
        ])

        let titleLabel = NSTextField(labelWithString: "Set up \(AppIdentity.appDisplayName)")
        titleLabel.font = .systemFont(ofSize: 22, weight: .semibold)

        let subtitleLabel = NSTextField(labelWithString: "These values are saved locally and used when the app launches at login.")
        subtitleLabel.textColor = .secondaryLabelColor
        subtitleLabel.lineBreakMode = .byWordWrapping
        subtitleLabel.maximumNumberOfLines = 0

        let headerStack = NSStackView(views: [iconView, verticalStack([titleLabel, subtitleLabel], spacing: 6)])
        headerStack.alignment = .centerY
        headerStack.spacing = 16

        statusLabel.textColor = .systemRed
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 0

        saveButton.target = self
        saveButton.action = #selector(savePressed)
        saveButton.bezelStyle = .rounded
        saveButton.keyEquivalent = "\r"

        cancelButton.target = self
        cancelButton.action = #selector(closePressed)
        cancelButton.bezelStyle = .rounded

        let buttonStack = NSStackView(views: [NSView(), cancelButton, saveButton])
        buttonStack.orientation = .horizontal
        buttonStack.spacing = 12
        buttonStack.setHuggingPriority(.defaultLow, for: .horizontal)

        let formStack = verticalStack([
            labeledRow("Server URL", serverField),
            labeledRow("Agent Key", agentField),
            labeledRow("Device ID", deviceField),
            labeledRow("Token", tokenField),
            labeledRow("Label", labelField),
            labeledRow("Reconnect Delay (s)", reconnectField),
            dividerLabel("SSH Tunnel (optional)"),
            helpLabel("Leave SSH Host empty for a direct connection. When set, the app owns `ssh -L` and connects the WebSocket through the forwarded local port."),
            labeledRow("SSH Host", tunnelHostField),
            labeledRow("SSH User", tunnelUserField),
            labeledRow("SSH Port", tunnelPortField),
            labeledRow("Local Tunnel Port", tunnelLocalPortField),
        ], spacing: 12)

        let rootStack = verticalStack([
            headerStack,
            formStack,
            statusLabel,
            buttonStack,
        ], spacing: 18)
        rootStack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
        rootStack.translatesAutoresizingMaskIntoConstraints = false

        contentView.addSubview(rootStack)
        NSLayoutConstraint.activate([
            rootStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            rootStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            rootStack.topAnchor.constraint(equalTo: contentView.topAnchor),
            rootStack.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor),
        ])

        return contentView
    }

    private func populateFields(using config: Config?) {
        serverField.placeholderString = "ws://127.0.0.1:8787/telepathy"
        agentField.placeholderString = "panda"
        deviceField.placeholderString = "local-mac"
        tokenField.placeholderString = "shared secret or device token"
        labelField.placeholderString = "Patrik MacBook"
        reconnectField.placeholderString = "2"
        tunnelHostField.placeholderString = "clankerino"
        tunnelUserField.placeholderString = "patrikmojzis"
        tunnelPortField.placeholderString = "22"
        tunnelLocalPortField.placeholderString = "43190"

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
    }

    @objc
    private func savePressed() {
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
                tunnelLocalPortRaw: tunnelLocalPortField.stringValue
            )
            try ConfigStore.save(config)
            statusLabel.stringValue = ""
            onSave(config)
            close()
        } catch {
            statusLabel.stringValue = String(describing: error)
        }
    }

    @objc
    private func closePressed() {
        close()
    }

    private func verticalStack(_ views: [NSView], spacing: CGFloat) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = spacing
        return stack
    }

    private func labeledRow(_ title: String, _ field: NSTextField) -> NSView {
        field.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            field.widthAnchor.constraint(equalToConstant: 360),
        ])

        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .secondaryLabelColor

        let stack = NSStackView(views: [label, field])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        return stack
    }

    private func dividerLabel(_ title: String) -> NSView {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.textColor = .labelColor
        return label
    }

    private func helpLabel(_ text: String) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.textColor = .secondaryLabelColor
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 0
        return label
    }
}
