import AppKit
import Carbon
import Foundation

@MainActor
final class ShortcutRecorderField: NSButton {
    var shortcut: PushToTalkShortcutConfig {
        didSet {
            updateAppearance()
        }
    }

    private let onChange: (PushToTalkShortcutConfig) -> Void
    private var isCapturing = false {
        didSet {
            updateAppearance()
        }
    }

    init(shortcut: PushToTalkShortcutConfig, onChange: @escaping (PushToTalkShortcutConfig) -> Void) {
        self.shortcut = shortcut
        self.onChange = onChange
        super.init(frame: .zero)
        bezelStyle = .rounded
        setButtonType(.momentaryPushIn)
        target = self
        action = #selector(beginCapture)
        font = .systemFont(ofSize: 12, weight: .medium)
        contentTintColor = .labelColor
        focusRingType = .default
        translatesAutoresizingMaskIntoConstraints = false
        updateAppearance()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var acceptsFirstResponder: Bool {
        true
    }

    override func keyDown(with event: NSEvent) {
        guard isCapturing else {
            super.keyDown(with: event)
            return
        }

        if event.keyCode == UInt16(kVK_Escape) {
            cancelCapture()
            return
        }

        guard let shortcut = PushToTalkShortcutConfig(capturing: event) else {
            NSSound.beep()
            return
        }

        self.shortcut = shortcut
        isCapturing = false
        onChange(shortcut)
        window?.makeFirstResponder(nil)
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned && isCapturing {
            isCapturing = false
        }
        return resigned
    }

    @objc
    private func beginCapture() {
        isCapturing = true
        window?.makeFirstResponder(self)
    }

    func reset(to shortcut: PushToTalkShortcutConfig) {
        self.shortcut = shortcut
        isCapturing = false
        onChange(shortcut)
    }

    private func cancelCapture() {
        isCapturing = false
        window?.makeFirstResponder(nil)
    }

    private func updateAppearance() {
        title = isCapturing ? "Press shortcut" : shortcut.displayLabel
    }
}
