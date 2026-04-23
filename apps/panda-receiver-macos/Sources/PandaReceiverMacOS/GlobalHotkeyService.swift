import Carbon
import Foundation

final class GlobalHotkeyService {
    struct Shortcut {
        let id: UInt32
        let keyCode: UInt32
        let modifiers: UInt32
    }

    typealias Handler = (_ shortcutId: UInt32, _ isPressed: Bool) -> Void

    private let handler: Handler
    private var eventHandler: EventHandlerRef?
    private var hotKeyRefs: [EventHotKeyRef] = []

    init(shortcuts: [Shortcut], handler: @escaping Handler) throws {
        self.handler = handler

        var eventTypes = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]

        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, eventRef, userData in
                guard let eventRef, let userData else {
                    return noErr
                }

                let service = Unmanaged<GlobalHotkeyService>.fromOpaque(userData).takeUnretainedValue()
                return service.handle(event: eventRef)
            },
            eventTypes.count,
            &eventTypes,
            Unmanaged.passUnretained(self).toOpaque(),
            &eventHandler
        )
        guard installStatus == noErr else {
            throw ReceiverError("Could not install Panda Telepathy hotkeys (status \(installStatus))")
        }

        do {
            try register(shortcuts: shortcuts)
        } catch {
            teardown()
            throw error
        }
    }

    deinit {
        teardown()
    }

    func invalidate() {
        teardown()
    }

    private func register(shortcuts: [Shortcut]) throws {
        for shortcut in shortcuts {
            var hotKeyRef: EventHotKeyRef?
            let hotKeyID = EventHotKeyID(signature: fourCharCode(from: "PTLK"), id: shortcut.id)
            let status = RegisterEventHotKey(
                shortcut.keyCode,
                shortcut.modifiers,
                hotKeyID,
                GetApplicationEventTarget(),
                0,
                &hotKeyRef
            )
            guard status == noErr, let hotKeyRef else {
                if status == eventHotKeyExistsErr {
                    throw ReceiverError("That push-to-talk shortcut is already in use. Pick a different combo in Settings.")
                }

                throw ReceiverError("Could not register Panda Telepathy hotkey \(shortcut.id) (status \(status))")
            }

            hotKeyRefs.append(hotKeyRef)
        }
    }

    private func teardown() {
        for hotKeyRef in hotKeyRefs {
            UnregisterEventHotKey(hotKeyRef)
        }
        hotKeyRefs.removeAll()

        if let eventHandler {
            RemoveEventHandler(eventHandler)
            self.eventHandler = nil
        }
    }

    private func handle(event: EventRef) -> OSStatus {
        var hotKeyID = EventHotKeyID()
        let status = GetEventParameter(
            event,
            EventParamName(kEventParamDirectObject),
            EventParamType(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &hotKeyID
        )
        guard status == noErr else {
            return status
        }

        let kind = GetEventKind(event)
        switch kind {
        case UInt32(kEventHotKeyPressed):
            handler(hotKeyID.id, true)
        case UInt32(kEventHotKeyReleased):
            handler(hotKeyID.id, false)
        default:
            break
        }

        return noErr
    }
}

private func fourCharCode(from value: String) -> OSType {
    value.utf8.reduce(0) { partialResult, byte in
        (partialResult << 8) + OSType(byte)
    }
}
