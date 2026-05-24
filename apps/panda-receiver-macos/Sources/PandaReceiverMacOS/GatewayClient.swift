import CryptoKit
import Foundation

struct GatewayHTTPResponse {
    let statusCode: Int
    let data: Data
}

protocol GatewayHTTPTransport {
    func data(for request: URLRequest, body: Data?) async throws -> GatewayHTTPResponse
}

final class URLSessionGatewayHTTPTransport: GatewayHTTPTransport {
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func data(for request: URLRequest, body: Data?) async throws -> GatewayHTTPResponse {
        var preparedRequest = request
        preparedRequest.httpBody = body
        let (data, response) = try await session.data(for: preparedRequest)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw GatewayClientError.invalidHTTPResponse
        }

        return GatewayHTTPResponse(statusCode: httpResponse.statusCode, data: data)
    }
}

enum GatewayDelivery: String, Codable {
    case queue
    case wake
}

struct GatewayAttachmentUpload {
    let data: Data
    let mimeType: String
    let filename: String?
    let idempotencyKey: String
}

struct GatewayAttachmentUploadResponse: Decodable {
    let attachmentId: String
    let sha256: String
    let sizeBytes: Int
    let mimeType: String
    let filename: String?
    let status: String
    let expiresAt: String
}

struct GatewayAttachmentRef: Codable, Equatable {
    let id: String
    let sha256: String?
}

struct GatewayEventResponse: Decodable {
    let eventId: String
    let accepted: Bool
    let delivery: GatewayDelivery
}

struct GatewayDeviceHeartbeatResponse: Decodable {
    let ok: Bool
    let sourceId: String?
    let deviceId: String?
    let seenAt: String?
}

private struct GatewayEventBody: Encodable {
    let type: String
    let delivery: GatewayDelivery
    let occurredAt: String
    let text: String
    let attachments: [GatewayAttachmentRef]?
}

private struct GatewayErrorBody: Decodable {
    let error: String?
    let message: String?
}

enum GatewayClientError: LocalizedError, Equatable {
    case invalidHTTPResponse
    case invalidResponse(message: String)
    case httpStatus(statusCode: Int, message: String)
    case transport(message: String)

    var errorDescription: String? {
        switch self {
        case .invalidHTTPResponse:
            return "Gateway returned a non-HTTP response"
        case .invalidResponse(let message):
            return "Gateway returned an invalid response: \(message)"
        case .httpStatus(let statusCode, let message):
            return "Gateway request failed with HTTP \(statusCode): \(message)"
        case .transport(let message):
            return "Gateway request failed: \(message)"
        }
    }
}

final class GatewayClient: @unchecked Sendable {
    private let baseURL: URL
    private let token: String
    private let transport: GatewayHTTPTransport
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(
        baseURL: URL,
        token: String,
        transport: GatewayHTTPTransport = URLSessionGatewayHTTPTransport()
    ) {
        self.baseURL = baseURL
        self.token = token
        self.transport = transport
        encoder.outputFormatting = [.sortedKeys]
    }

    func checkHealth() async throws {
        var request = URLRequest(url: endpoint("health"))
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        _ = try await send(request, body: nil, acceptedStatusCodes: 200..<300)
    }

    func deviceHeartbeat() async throws -> GatewayDeviceHeartbeatResponse {
        var request = authorizedRequest(url: endpoint("v1/device/heartbeat"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let response = try await send(request, body: Data("{}".utf8), acceptedStatusCodes: 200..<300)
        let heartbeat = try decoder.decode(GatewayDeviceHeartbeatResponse.self, from: response)
        guard heartbeat.ok else {
            throw GatewayClientError.invalidResponse(message: "Gateway heartbeat did not report success")
        }
        return heartbeat
    }

    func uploadAttachment(_ upload: GatewayAttachmentUpload) async throws -> GatewayAttachmentUploadResponse {
        let sha256 = computeSHA256Hex(upload.data)
        var request = authorizedRequest(url: endpoint("v2/attachments"), idempotencyKey: upload.idempotencyKey)
        request.httpMethod = "POST"
        request.setValue(upload.mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(sha256, forHTTPHeaderField: "X-Content-Sha256")
        if let filename = upload.filename {
            request.setValue(filename, forHTTPHeaderField: "X-Filename")
        }

        let response = try await send(request, body: upload.data, acceptedStatusCodes: 200..<300)
        return try decoder.decode(GatewayAttachmentUploadResponse.self, from: response)
    }

    func postEvent(
        type: String,
        delivery: GatewayDelivery,
        text: String,
        attachments: [GatewayAttachmentRef] = [],
        occurredAt: Date = Date(),
        idempotencyKey: String
    ) async throws -> GatewayEventResponse {
        var request = authorizedRequest(url: endpoint("v2/events"), idempotencyKey: idempotencyKey)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = try encoder.encode(GatewayEventBody(
            type: type,
            delivery: delivery,
            occurredAt: Self.iso8601String(from: occurredAt),
            text: text,
            attachments: attachments.isEmpty ? nil : attachments
        ))
        let response = try await send(request, body: body, acceptedStatusCodes: 200..<300)
        return try decoder.decode(GatewayEventResponse.self, from: response)
    }

    static func makeIdempotencyKey(prefix: String) -> String {
        "\(prefix):\(UUID().uuidString.lowercased())"
    }

    static func sha256Hex(_ data: Data) -> String {
        computeSHA256Hex(data)
    }

    private func authorizedRequest(url: URL, idempotencyKey: String? = nil) -> URLRequest {
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let idempotencyKey {
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        return request
    }

    private func endpoint(_ path: String) -> URL {
        var url = baseURL
        for component in path.split(separator: "/") {
            url.appendPathComponent(String(component))
        }
        return url
    }

    private func send(
        _ request: URLRequest,
        body: Data?,
        acceptedStatusCodes: Range<Int>
    ) async throws -> Data {
        let response: GatewayHTTPResponse
        do {
            response = try await transport.data(for: request, body: body)
        } catch let error as GatewayClientError {
            throw error
        } catch {
            throw GatewayClientError.transport(message: redactToken(String(describing: error)))
        }

        guard acceptedStatusCodes.contains(response.statusCode) else {
            throw GatewayClientError.httpStatus(
                statusCode: response.statusCode,
                message: redactToken(errorMessage(from: response.data) ?? "Gateway returned an error")
            )
        }

        return response.data
    }

    private func errorMessage(from data: Data) -> String? {
        if let body = try? decoder.decode(GatewayErrorBody.self, from: data) {
            return body.error ?? body.message
        }

        return nil
    }

    private func redactToken(_ value: String) -> String {
        guard !token.isEmpty else {
            return value
        }

        return value.replacingOccurrences(of: token, with: "<redacted>")
    }

    private static func iso8601String(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

private func computeSHA256Hex(_ data: Data) -> String {
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
}
