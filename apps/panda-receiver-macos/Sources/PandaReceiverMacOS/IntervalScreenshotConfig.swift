import Foundation

struct IntervalScreenshotConfig: Codable, Sendable, Equatable {
    static let defaultIntervalSeconds: UInt64 = 300
    static let minIntervalSeconds: UInt64 = 60
    static let maxIntervalSeconds: UInt64 = 86_400

    let intervalSeconds: UInt64

    static func resolve(intervalMinutesRaw: String?) throws -> IntervalScreenshotConfig {
        let trimmed = intervalMinutesRaw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            return IntervalScreenshotConfig(intervalSeconds: defaultIntervalSeconds)
        }

        guard let minutes = UInt64(trimmed), minutes >= 1, minutes <= 1_440 else {
            throw ReceiverError("Interval must be between 1 and 1440 minutes")
        }

        let seconds = minutes * 60
        guard seconds >= minIntervalSeconds, seconds <= maxIntervalSeconds else {
            throw ReceiverError("Interval must be between 1 and 1440 minutes")
        }

        return IntervalScreenshotConfig(intervalSeconds: seconds)
    }
}
