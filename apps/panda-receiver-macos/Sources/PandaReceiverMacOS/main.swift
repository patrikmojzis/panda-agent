import AppKit
import Darwin
import Foundation

do {
    let launchRequest = try Config.parseLaunch(arguments: CommandLine.arguments)

    if launchRequest.printConfigPath {
        print(try ConfigStore.defaultURL().path)
        Darwin.exit(0)
    }

    if launchRequest.dumpConfig {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let config = launchRequest.config {
            let data = try encoder.encode(config)
            print(String(decoding: data, as: UTF8.self))
        } else {
            print("NO_CONFIG")
        }
        Darwin.exit(0)
    }

    if let launchAtLoginCommand = launchRequest.launchAtLoginCommand {
        print(try LaunchAtLoginManager.handleCommand(launchAtLoginCommand))
        Darwin.exit(0)
    }

    let app = NSApplication.shared
    let delegate = MenuBarAppController(config: launchRequest.config)
    app.delegate = delegate
    app.run()
} catch let error as ReceiverError where error.message == "usage" {
    print(Config.usage())
    Darwin.exit(0)
} catch {
    fputs("\(String(describing: error))\n", stderr)
    NSApplication.shared.setActivationPolicy(.regular)
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "\(AppIdentity.appDisplayName) couldn't start"
    alert.informativeText = "\(String(describing: error))\n\n\(Config.usage())"
    alert.addButton(withTitle: "OK")
    alert.runModal()
    Darwin.exit(1)
}
