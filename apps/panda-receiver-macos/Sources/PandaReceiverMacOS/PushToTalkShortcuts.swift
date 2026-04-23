import AppKit
import Carbon
import Foundation

private let supportedShortcutModifierMask = UInt32(cmdKey | optionKey | controlKey | shiftKey)

struct PushToTalkShortcutConfig: Codable, Equatable, Sendable {
    let keyCode: UInt32
    let modifiers: UInt32

    init(keyCode: UInt32, modifiers: UInt32) {
        self.keyCode = keyCode
        self.modifiers = modifiers & supportedShortcutModifierMask
    }

    static let defaultVoiceOnly = PushToTalkShortcutConfig(
        keyCode: UInt32(kVK_ANSI_V),
        modifiers: UInt32(controlKey | optionKey | cmdKey)
    )

    static let defaultVoiceWithScreenshot = PushToTalkShortcutConfig(
        keyCode: UInt32(kVK_ANSI_S),
        modifiers: UInt32(controlKey | optionKey | cmdKey)
    )

    var displayLabel: String {
        var parts: [String] = []
        if modifiers & UInt32(controlKey) != 0 {
            parts.append("Ctrl")
        }
        if modifiers & UInt32(optionKey) != 0 {
            parts.append("Opt")
        }
        if modifiers & UInt32(shiftKey) != 0 {
            parts.append("Shift")
        }
        if modifiers & UInt32(cmdKey) != 0 {
            parts.append("Cmd")
        }
        parts.append(keyLabel)
        return parts.joined(separator: "+")
    }

    var keyLabel: String {
        if let special = specialKeyLabels[keyCode] {
            return special
        }

        if let scalar = scalarCharacterForKeyCode[keyCode] {
            return String(scalar).uppercased()
        }

        return "Key \(keyCode)"
    }

    var hasRequiredModifiers: Bool {
        modifiers != 0
    }

    func toHotkey(id: UInt32) -> GlobalHotkeyService.Shortcut {
        GlobalHotkeyService.Shortcut(id: id, keyCode: keyCode, modifiers: modifiers)
    }

    init?(capturing event: NSEvent) {
        let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
        let rawModifiers = carbonModifiers(from: modifiers)
        guard rawModifiers != 0 else {
            return nil
        }

        self.init(keyCode: UInt32(event.keyCode), modifiers: rawModifiers)
    }
}

struct PushToTalkShortcutBindings: Codable, Equatable, Sendable {
    let voiceOnly: PushToTalkShortcutConfig
    let voiceWithScreenshot: PushToTalkShortcutConfig

    static let defaults = PushToTalkShortcutBindings(
        voiceOnly: .defaultVoiceOnly,
        voiceWithScreenshot: .defaultVoiceWithScreenshot
    )

    func shortcut(for mode: PushToTalkShortcutMode) -> PushToTalkShortcutConfig {
        switch mode {
        case .voiceOnly:
            return voiceOnly
        case .voiceWithScreenshot:
            return voiceWithScreenshot
        }
    }
}

private func carbonModifiers(from flags: NSEvent.ModifierFlags) -> UInt32 {
    var modifiers: UInt32 = 0
    if flags.contains(.control) {
        modifiers |= UInt32(controlKey)
    }
    if flags.contains(.option) {
        modifiers |= UInt32(optionKey)
    }
    if flags.contains(.shift) {
        modifiers |= UInt32(shiftKey)
    }
    if flags.contains(.command) {
        modifiers |= UInt32(cmdKey)
    }
    return modifiers
}

private let scalarCharacterForKeyCode: [UInt32: Character] = [
    UInt32(kVK_ANSI_A): "A",
    UInt32(kVK_ANSI_B): "B",
    UInt32(kVK_ANSI_C): "C",
    UInt32(kVK_ANSI_D): "D",
    UInt32(kVK_ANSI_E): "E",
    UInt32(kVK_ANSI_F): "F",
    UInt32(kVK_ANSI_G): "G",
    UInt32(kVK_ANSI_H): "H",
    UInt32(kVK_ANSI_I): "I",
    UInt32(kVK_ANSI_J): "J",
    UInt32(kVK_ANSI_K): "K",
    UInt32(kVK_ANSI_L): "L",
    UInt32(kVK_ANSI_M): "M",
    UInt32(kVK_ANSI_N): "N",
    UInt32(kVK_ANSI_O): "O",
    UInt32(kVK_ANSI_P): "P",
    UInt32(kVK_ANSI_Q): "Q",
    UInt32(kVK_ANSI_R): "R",
    UInt32(kVK_ANSI_S): "S",
    UInt32(kVK_ANSI_T): "T",
    UInt32(kVK_ANSI_U): "U",
    UInt32(kVK_ANSI_V): "V",
    UInt32(kVK_ANSI_W): "W",
    UInt32(kVK_ANSI_X): "X",
    UInt32(kVK_ANSI_Y): "Y",
    UInt32(kVK_ANSI_Z): "Z",
    UInt32(kVK_ANSI_0): "0",
    UInt32(kVK_ANSI_1): "1",
    UInt32(kVK_ANSI_2): "2",
    UInt32(kVK_ANSI_3): "3",
    UInt32(kVK_ANSI_4): "4",
    UInt32(kVK_ANSI_5): "5",
    UInt32(kVK_ANSI_6): "6",
    UInt32(kVK_ANSI_7): "7",
    UInt32(kVK_ANSI_8): "8",
    UInt32(kVK_ANSI_9): "9",
]

private let specialKeyLabels: [UInt32: String] = [
    UInt32(kVK_Space): "Space",
    UInt32(kVK_Return): "Return",
    UInt32(kVK_Tab): "Tab",
    UInt32(kVK_Delete): "Delete",
    UInt32(kVK_ForwardDelete): "Forward Delete",
    UInt32(kVK_Escape): "Esc",
    UInt32(kVK_LeftArrow): "Left",
    UInt32(kVK_RightArrow): "Right",
    UInt32(kVK_UpArrow): "Up",
    UInt32(kVK_DownArrow): "Down",
    UInt32(kVK_Home): "Home",
    UInt32(kVK_End): "End",
    UInt32(kVK_PageUp): "Page Up",
    UInt32(kVK_PageDown): "Page Down",
    UInt32(kVK_F1): "F1",
    UInt32(kVK_F2): "F2",
    UInt32(kVK_F3): "F3",
    UInt32(kVK_F4): "F4",
    UInt32(kVK_F5): "F5",
    UInt32(kVK_F6): "F6",
    UInt32(kVK_F7): "F7",
    UInt32(kVK_F8): "F8",
    UInt32(kVK_F9): "F9",
    UInt32(kVK_F10): "F10",
    UInt32(kVK_F11): "F11",
    UInt32(kVK_F12): "F12",
]
