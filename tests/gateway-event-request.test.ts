import {createHash} from "node:crypto";
import type {IncomingMessage} from "node:http";
import {Readable} from "node:stream";

import {describe, expect, it} from "vitest";

import {
  readGatewayBearerToken,
  readGatewayEventRequest,
  readGatewayEventWithAttachmentsRequest,
  resolveGatewayEffectiveDelivery,
} from "../src/integrations/gateway/event-request.js";

function createRequest(body: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  return Object.assign(Readable.from([body]), {
    headers,
  }) as IncomingMessage;
}

describe("gateway event requests", () => {
  it("reads bearer tokens and normalized event payloads", async () => {
    const text = "hello";
    const request = createRequest(JSON.stringify({
      type: " deploy.done ",
      delivery: "wake",
      occurredAt: "2026-05-13T12:00:00.000Z",
      text,
    }), {
      authorization: "Bearer access-token",
      "content-type": "application/json",
      "idempotency-key": "deploy-1",
    });

    expect(readGatewayBearerToken(request)).toBe("access-token");
    await expect(readGatewayEventRequest(request, 1024)).resolves.toEqual({
      idempotencyKey: "deploy-1",
      type: "deploy.done",
      delivery: "wake",
      occurredAt: Date.parse("2026-05-13T12:00:00.000Z"),
      text,
      textBytes: Buffer.byteLength(text, "utf8"),
      textSha256: createHash("sha256").update(text, "utf8").digest("hex"),
    });
  });

  it("rejects missing auth, missing idempotency, and malformed body shapes", async () => {
    expect(() => readGatewayBearerToken(createRequest(""))).toThrow("Missing bearer token.");

    await expect(readGatewayEventRequest(createRequest(JSON.stringify({
      type: "deploy.done",
      delivery: "wake",
      text: "hello",
    })), 1024)).rejects.toMatchObject({
      statusCode: 400,
      message: "Missing Idempotency-Key header.",
    });

    await expect(readGatewayEventRequest(createRequest(JSON.stringify({
      type: "deploy.done",
      delivery: "sideways",
      text: "hello",
    }), {
      "content-type": "application/json",
      "idempotency-key": "deploy-1",
    }), 1024)).rejects.toMatchObject({
      statusCode: 400,
      message: "Invalid event body.",
    });
  });

  it("rejects event bodies without the JSON content type", async () => {
    await expect(readGatewayEventRequest(createRequest(JSON.stringify({
      type: "deploy.done",
      delivery: "wake",
      text: "hello",
    }), {"idempotency-key": "deploy-1"}), 1024)).rejects.toMatchObject({
      statusCode: 415,
      message: "Unsupported Content-Type. Expected application/json.",
    });

    await expect(readGatewayEventRequest(createRequest(JSON.stringify({
      type: "deploy.done",
      delivery: "wake",
      text: "hello",
    }), {
      "content-type": "text/plain",
      "idempotency-key": "deploy-1",
    }), 1024)).rejects.toMatchObject({
      statusCode: 415,
      message: "Unsupported Content-Type. Expected application/json.",
    });
  });


  it("rejects v1 attachment keys and parses v2 ordered attachment refs", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const sha256 = "a".repeat(64);
    await expect(readGatewayEventRequest(createRequest(JSON.stringify({
      type: "meeting.transcript",
      delivery: "queue",
      text: "hello",
      attachments: [{id: attachmentId}],
    }), {
      "content-type": "application/json",
      "idempotency-key": "event-1",
    }), 1024)).rejects.toMatchObject({
      statusCode: 400,
      message: "Attachments require /v2/events.",
    });

    await expect(readGatewayEventWithAttachmentsRequest(createRequest(JSON.stringify({
      type: "meeting.transcript",
      delivery: "queue",
      text: "hello",
      attachments: [{id: attachmentId, sha256}],
    }), {
      "content-type": "application/json",
      "idempotency-key": "event-1",
    }), 1024, 5)).resolves.toMatchObject({
      idempotencyKey: "event-1",
      type: "meeting.transcript",
      delivery: "queue",
      attachments: [{id: attachmentId, sha256}],
    });

    await expect(readGatewayEventWithAttachmentsRequest(createRequest(JSON.stringify({
      type: "meeting.transcript",
      delivery: "queue",
      text: "hello",
      attachments: [],
    }), {
      "content-type": "application/json",
      "idempotency-key": "event-1",
    }), 1024, 5)).rejects.toMatchObject({
      statusCode: 400,
      message: "attachments must contain at least one ref when present.",
    });
  });

  it("never escalates queue-only event types to wake", () => {
    expect(resolveGatewayEffectiveDelivery({
      allowedDelivery: "queue",
      requestedDelivery: "wake",
    })).toBe("queue");
    expect(resolveGatewayEffectiveDelivery({
      allowedDelivery: "wake",
      requestedDelivery: "queue",
    })).toBe("queue");
  });
});
