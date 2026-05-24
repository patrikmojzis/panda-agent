import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

protocol ScreenshotCapturing: Sendable {
    func captureJPEG() async throws -> Data
}

struct DefaultScreenshotCaptureService: ScreenshotCapturing, Sendable {
    func captureJPEG() async throws -> Data {
        // ScreenCaptureKit fixes fullscreen Spaces on modern macOS, but keep
        // an older screencapture fallback so the prototype still runs on 13.x.
        if #available(macOS 14.0, *) {
            return try await capturePrimaryDisplayJPEG()
        }

        return try capturePrimaryDisplayJPEGFallback()
    }

    @available(macOS 14.0, *)
    private func capturePrimaryDisplayJPEG() async throws -> Data {
        let shareableContent = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let displayID = CGMainDisplayID()

        guard let display = shareableContent.displays.first(where: { $0.displayID == displayID }) else {
            throw ReceiverError("Primary display \(displayID) is not available to ScreenCaptureKit")
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = false
        configuration.width = max(1, Int(display.width))
        configuration.height = max(1, Int(display.height))

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )

        return try encodeJPEG(image)
    }

    private func capturePrimaryDisplayJPEGFallback() throws -> Data {
        let screenshotURL = try saveTemporaryJPEGURL(prefix: "panda-gateway-fallback")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = [
            "-x",
            "-D",
            String(CGMainDisplayID()),
            "-t",
            "jpg",
            screenshotURL.path(),
        ]

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            throw ReceiverError("screencapture exited with status \(process.terminationStatus)")
        }

        let screenshotData = try Data(contentsOf: screenshotURL)
        try? FileManager.default.removeItem(at: screenshotURL)
        return screenshotData
    }

    private func encodeJPEG(_ image: CGImage) throws -> Data {
        let destinationData = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            destinationData,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw ReceiverError("Failed to create a JPEG image destination")
        }

        let properties: CFDictionary = [
            kCGImageDestinationLossyCompressionQuality: 0.9,
        ] as CFDictionary
        CGImageDestinationAddImage(destination, image, properties)

        guard CGImageDestinationFinalize(destination) else {
            throw ReceiverError("Failed to encode the screenshot as JPEG")
        }

        return destinationData as Data
    }
}

func saveJPEGData(_ data: Data, prefix: String) throws -> URL {
    let screenshotURL = try saveTemporaryJPEGURL(prefix: prefix)
    try data.write(to: screenshotURL, options: .atomic)
    return screenshotURL
}

private func saveTemporaryJPEGURL(prefix: String) throws -> URL {
    let fileManager = FileManager.default
    let screenshotURL = fileManager.temporaryDirectory
        .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
        .appendingPathExtension("jpg")

    if fileManager.fileExists(atPath: screenshotURL.path()) {
        try? fileManager.removeItem(at: screenshotURL)
    }

    return screenshotURL
}
