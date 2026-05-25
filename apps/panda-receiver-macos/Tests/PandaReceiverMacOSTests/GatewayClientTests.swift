import Foundation
import Testing

@testable import PandaReceiverMacOS

private actor FakeGatewayHTTPTransport: GatewayHTTPTransport {
    private var responses: [GatewayHTTPResponse]
    private var requests: [(request: URLRequest, body: Data?)] = []

    init(responses: [GatewayHTTPResponse]) {
        self.responses = responses
    }

    func data(for request: URLRequest, body: Data?) async throws -> GatewayHTTPResponse {
        requests.append((request: request, body: body))
        return responses.removeFirst()
    }

    func firstRequest() -> (request: URLRequest, body: Data?)? {
        requests.first
    }
}

private func jsonResponse(_ text: String, statusCode: Int = 200) -> GatewayHTTPResponse {
    GatewayHTTPResponse(statusCode: statusCode, data: Data(text.utf8))
}

@Test
func deviceHeartbeatBuildsAuthenticatedRequestAndRequiresOkResponse() async throws {
    let transport = FakeGatewayHTTPTransport(responses: [jsonResponse("""
    {
      "ok": true,
      "sourceId": "source-1",
      "deviceId": "home-mac",
      "seenAt": "2026-04-28T10:00:00.000Z"
    }
    """)])
    let client = GatewayClient(
        baseURL: URL(string: "https://gateway.example.com")!,
        token: "device-token",
        transport: transport
    )

    let response = try await client.deviceHeartbeat()

    let recordedRequest = try #require(await transport.firstRequest())
    let request = recordedRequest.request
    #expect(request.httpMethod == "POST")
    #expect(request.url?.absoluteString == "https://gateway.example.com/v1/device/heartbeat")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer device-token")
    #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == nil)
    #expect(recordedRequest.body == Data("{}".utf8))
    #expect(response.ok)
    #expect(response.deviceId == "home-mac")
}

@Test
func deviceHeartbeatRejectsOkFalseResponse() async throws {
    let transport = FakeGatewayHTTPTransport(responses: [jsonResponse("""
    {"ok": false}
    """)])
    let client = GatewayClient(
        baseURL: URL(string: "https://gateway.example.com")!,
        token: "device-token",
        transport: transport
    )

    do {
        _ = try await client.deviceHeartbeat()
        Issue.record("Expected heartbeat to fail")
    } catch let error as GatewayClientError {
        #expect(error == .invalidResponse(message: "Gateway heartbeat did not report success"))
    }
}

@Test
func uploadAttachmentBuildsGatewayRequestWithAuthDigestAndIdempotency() async throws {
    let bytes = Data("hello".utf8)
    let sha256 = GatewayClient.sha256Hex(bytes)
    let transport = FakeGatewayHTTPTransport(responses: [jsonResponse("""
    {
      "ok": true,
      "attachmentId": "00000000-0000-0000-0000-000000000001",
      "sha256": "\(sha256)",
      "sizeBytes": 5,
      "mimeType": "text/plain",
      "filename": "note.txt",
      "status": "uploaded",
      "expiresAt": "2026-04-28T10:00:00.000Z"
    }
    """, statusCode: 201)])
    let client = GatewayClient(
        baseURL: URL(string: "https://gateway.example.com")!,
        token: "device-token",
        transport: transport
    )

    let response = try await client.uploadAttachment(GatewayAttachmentUpload(
        data: bytes,
        mimeType: "text/plain",
        filename: "note.txt",
        idempotencyKey: "mac.context.push:test:attachment:0"
    ))

    let recordedRequest = try #require(await transport.firstRequest())
    let request = recordedRequest.request
    #expect(request.httpMethod == "POST")
    #expect(request.url?.absoluteString == "https://gateway.example.com/v2/attachments")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer device-token")
    #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "mac.context.push:test:attachment:0")
    #expect(request.value(forHTTPHeaderField: "Content-Type") == "text/plain")
    #expect(request.value(forHTTPHeaderField: "X-Filename") == "note.txt")
    #expect(request.value(forHTTPHeaderField: "X-Content-Sha256") == sha256)
    #expect(recordedRequest.body == bytes)
    #expect(response.attachmentId == "00000000-0000-0000-0000-000000000001")
    #expect(response.sha256 == sha256)
}

@Test
func postEventBuildsAttachmentAwareGatewayEventWithoutTokenInBody() async throws {
    let transport = FakeGatewayHTTPTransport(responses: [jsonResponse("""
    {
      "ok": true,
      "eventId": "00000000-0000-0000-0000-000000000002",
      "accepted": true,
      "delivery": "wake"
    }
    """, statusCode: 202)])
    let client = GatewayClient(
        baseURL: URL(string: "http://127.0.0.1:8094")!,
        token: "device-token",
        transport: transport
    )

    let response = try await client.postEvent(
        type: "mac.context.push",
        delivery: .wake,
        text: "Mac push-to-talk context.",
        attachments: [GatewayAttachmentRef(id: "00000000-0000-0000-0000-000000000001", sha256: String(repeating: "a", count: 64))],
        occurredAt: Date(timeIntervalSince1970: 1_800_000_000),
        idempotencyKey: "mac.context.push:test:event"
    )

    let recordedRequest = try #require(await transport.firstRequest())
    let request = recordedRequest.request
    let bodyData = try #require(recordedRequest.body)
    let body = try #require(JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
    let attachments = try #require(body["attachments"] as? [[String: Any]])
    #expect(request.httpMethod == "POST")
    #expect(request.url?.absoluteString == "http://127.0.0.1:8094/v2/events")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer device-token")
    #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "mac.context.push:test:event")
    #expect(body["type"] as? String == "mac.context.push")
    #expect(body["delivery"] as? String == "wake")
    #expect(body["text"] as? String == "Mac push-to-talk context.")
    #expect(attachments.first?["id"] as? String == "00000000-0000-0000-0000-000000000001")
    #expect(!String(decoding: bodyData, as: UTF8.self).contains("device-token"))
    #expect(response.eventId == "00000000-0000-0000-0000-000000000002")
    #expect(response.delivery == .wake)
}

@Test
func gatewayClientErrorsRedactBearerToken() async throws {
    let transport = FakeGatewayHTTPTransport(responses: [jsonResponse("""
    {"error":"bad token secret-device-token"}
    """, statusCode: 401)])
    let client = GatewayClient(
        baseURL: URL(string: "https://gateway.example.com")!,
        token: "secret-device-token",
        transport: transport
    )

    do {
        _ = try await client.uploadAttachment(GatewayAttachmentUpload(
            data: Data("hello".utf8),
            mimeType: "text/plain",
            filename: nil,
            idempotencyKey: "mac.context.push:test:attachment:0"
        ))
        Issue.record("Expected upload to fail")
    } catch {
        #expect(!error.localizedDescription.contains("secret-device-token"))
        #expect(error.localizedDescription.contains("<redacted>"))
    }
}
