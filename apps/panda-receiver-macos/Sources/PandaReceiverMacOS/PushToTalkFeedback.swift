import AppKit
import Foundation

private enum PushToTalkFeedbackPhase: Equatable {
    case idle
    case preparing
    case recording
    case sending
}

private enum PushToTalkHUDStyle {
    case preparing
    case recording
    case sending
    case success
    case warning
    case error

    var symbolName: String {
        switch self {
        case .preparing:
            return "mic.circle.fill"
        case .recording:
            return "mic.fill"
        case .sending:
            return "waveform.circle.fill"
        case .success:
            return "checkmark.circle.fill"
        case .warning:
            return "exclamationmark.circle.fill"
        case .error:
            return "xmark.circle.fill"
        }
    }

    var tintColor: NSColor {
        switch self {
        case .preparing:
            return .controlAccentColor
        case .recording:
            return .systemRed
        case .sending:
            return .systemBlue
        case .success:
            return .systemGreen
        case .warning:
            return .systemOrange
        case .error:
            return .systemRed
        }
    }
}

@MainActor
final class PushToTalkFeedbackController {
    private let hud = PushToTalkHUDController()
    private let sounds = PushToTalkSoundPlayer()
    private var phase: PushToTalkFeedbackPhase = .idle

    func handle(status: PushToTalkStatus) {
        let nextPhase = phase(for: status)
        if nextPhase != phase {
            phase = nextPhase
            switch nextPhase {
            case .idle:
                hud.hide()
            case .preparing:
                hud.show(
                    style: .preparing,
                    title: "Preparing",
                    detail: status.detail
                )
                sounds.playArmed()
            case .recording:
                hud.show(
                    style: .recording,
                    title: "Listening",
                    detail: "Release to send"
                )
            case .sending:
                hud.show(
                    style: .sending,
                    title: "Sending",
                    detail: status.detail
                )
                sounds.playSent()
            }
        }

        guard nextPhase == .idle else {
            return
        }

        if status.detail.hasPrefix("Last sent") {
            hud.show(
                style: .success,
                title: "Sent",
                detail: status.detail,
                autoDismissAfter: 1.6
            )
            sounds.playSuccess()
        } else if status.detail == "Voice clip too short, not sent" {
            hud.show(
                style: .warning,
                title: "Too Short",
                detail: "Hold the shortcut a bit longer",
                autoDismissAfter: 1.8
            )
            sounds.playCanceled()
        }
    }

    func presentError(_ message: String) {
        phase = .idle
        hud.show(
            style: .error,
            title: "Push-to-Talk Failed",
            detail: message,
            autoDismissAfter: 2.4
        )
        sounds.playError()
    }

    func presentPullScreenshot() {
        hud.show(
            style: .sending,
            title: "Screen Shared",
            detail: "Panda requested a screenshot",
            autoDismissAfter: 1.4
        )
        sounds.playNotice()
    }

    private func phase(for status: PushToTalkStatus) -> PushToTalkFeedbackPhase {
        if status.isPreparing {
            return .preparing
        }
        if status.isRecording {
            return .recording
        }
        if status.isSending {
            return .sending
        }
        return .idle
    }
}

@MainActor
private final class PushToTalkSoundPlayer {
    func playArmed() {
        play(named: "Glass")
    }

    func playSent() {
        play(named: "Hero")
    }

    func playSuccess() {
        play(named: "Pop")
    }

    func playCanceled() {
        play(named: "Morse")
    }

    func playError() {
        play(named: "Basso")
    }

    func playNotice() {
        play(named: "Tink")
    }

    private func play(named name: String) {
        if let sound = NSSound(named: NSSound.Name(name)) {
            sound.stop()
            sound.play()
            return
        }

        NSSound.beep()
    }
}

@MainActor
private final class PushToTalkHUDController {
    private let panel: NSPanel
    private let iconView = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "")
    private var dismissTask: Task<Void, Never>?

    init() {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 90),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]

        let effectView = NSVisualEffectView(frame: panel.contentView?.bounds ?? .zero)
        effectView.autoresizingMask = [.width, .height]
        effectView.material = .hudWindow
        effectView.state = .active
        effectView.blendingMode = .withinWindow
        effectView.wantsLayer = true
        effectView.layer?.cornerRadius = 18
        effectView.layer?.masksToBounds = true
        panel.contentView = effectView

        let container = NSStackView()
        container.orientation = .horizontal
        container.alignment = .centerY
        container.spacing = 14
        container.translatesAutoresizingMaskIntoConstraints = false
        effectView.addSubview(container)

        NSLayoutConstraint.activate([
            container.leadingAnchor.constraint(equalTo: effectView.leadingAnchor, constant: 18),
            container.trailingAnchor.constraint(equalTo: effectView.trailingAnchor, constant: -18),
            container.topAnchor.constraint(equalTo: effectView.topAnchor, constant: 14),
            container.bottomAnchor.constraint(equalTo: effectView.bottomAnchor, constant: -14),
        ])

        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 28, weight: .medium)
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 34),
            iconView.heightAnchor.constraint(equalToConstant: 34),
        ])

        let labels = NSStackView()
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 3

        titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail

        detailLabel.font = .systemFont(ofSize: 12, weight: .regular)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.lineBreakMode = .byTruncatingTail
        detailLabel.maximumNumberOfLines = 2

        labels.addArrangedSubview(titleLabel)
        labels.addArrangedSubview(detailLabel)

        container.addArrangedSubview(iconView)
        container.addArrangedSubview(labels)
    }

    func show(
        style: PushToTalkHUDStyle,
        title: String,
        detail: String,
        autoDismissAfter: TimeInterval? = nil
    ) {
        dismissTask?.cancel()
        dismissTask = nil

        titleLabel.stringValue = title
        detailLabel.stringValue = detail
        detailLabel.isHidden = detail.isEmpty

        let image = NSImage(
            systemSymbolName: style.symbolName,
            accessibilityDescription: title
        )
        image?.isTemplate = false
        iconView.image = image
        iconView.contentTintColor = style.tintColor

        positionPanel()
        panel.orderFrontRegardless()

        if let autoDismissAfter {
            dismissTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(autoDismissAfter * 1_000_000_000))
                self?.hide()
            }
        }
    }

    func hide() {
        dismissTask?.cancel()
        dismissTask = nil
        panel.orderOut(nil)
    }

    private func positionPanel() {
        let originScreen = screenForPointer() ?? NSScreen.main
        guard let screen = originScreen else {
            return
        }

        let frame = screen.visibleFrame
        let size = panel.frame.size
        let origin = NSPoint(
            x: frame.midX - (size.width / 2),
            y: frame.maxY - size.height - 28
        )
        panel.setFrameOrigin(origin)
    }

    private func screenForPointer() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { $0.frame.contains(mouse) })
    }
}
