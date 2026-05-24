import {describe, expect, it, vi} from "vitest";

import type {GatewayEventAttachmentRecord, GatewayEventRecord, GatewaySourceRecord} from "../src/domain/gateway/types.js";
import type {SessionRecord} from "../src/domain/sessions/index.js";
import {deliverGatewayEventToThread} from "../src/integrations/gateway/delivery.js";

function gatewaySource(overrides: Partial<GatewaySourceRecord> = {}): GatewaySourceRecord {
  return {
    sourceId: "work-prod",
    name: "Work Prod",
    clientId: "client-1",
    agentKey: "panda",
    identityId: "identity-1",
    sessionId: "session-1",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function gatewayEvent(overrides: Partial<GatewayEventRecord> = {}): GatewayEventRecord {
  return {
    id: "event-1",
    sourceId: "work-prod",
    type: "meeting.transcript",
    deliveryRequested: "wake",
    deliveryEffective: "wake",
    idempotencyKey: "event-key",
    text: "External event text.",
    textBytes: Buffer.byteLength("External event text.", "utf8"),
    textSha256: "sha256",
    status: "processing",
    claimId: "claim-1",
    createdAt: 1,
    ...overrides,
  };
}

describe("gateway delivery", () => {
  it("resolves the session current thread after reserving delivery", async () => {
    const session: SessionRecord = {
      id: "session-1",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "old-thread",
      createdAt: 1,
      updatedAt: 1,
    };
    const enqueueInput = vi.fn(async (threadId, payload, deliveryMode) => ({
      inserted: true,
      input: {
        id: "input-1",
        threadId,
        order: 1,
        deliveryMode: deliveryMode ?? "wake",
        source: payload.source,
        message: payload.message,
        metadata: payload.metadata,
        createdAt: 1,
      },
    }));
    const markEventDelivered = vi.fn(async () => undefined);

    await deliverGatewayEventToThread({
      event: gatewayEvent(),
      riskScore: 0.1,
      source: gatewaySource(),
      sessionStore: {
        getSession: vi.fn(async () => session),
        getMainSession: vi.fn(async () => null),
      },
      store: {
        markEventDelivered,
        markEventQuarantined: vi.fn(async () => undefined),
        reserveEventDelivery: vi.fn(async (input) => {
          session.currentThreadId = "new-thread";
          return gatewayEvent({
            claimId: input.claimId,
            riskScore: input.riskScore,
          });
        }),
      },
      threadStore: {
        enqueueInput,
      },
    });

    expect(enqueueInput).toHaveBeenCalledWith("new-thread", expect.objectContaining({
      source: "gateway",
      externalMessageId: "event-1",
    }), "wake");
    expect(markEventDelivered).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "new-thread",
    }));
  });

  it("uses the agent main session when the source is not pinned to a session", async () => {
    const mainSession: SessionRecord = {
      id: "main-session",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "main-thread",
      createdAt: 1,
      updatedAt: 1,
    };
    const enqueueInput = vi.fn(async (threadId, payload, deliveryMode) => ({
      inserted: true,
      input: {
        id: "input-1",
        threadId,
        order: 1,
        deliveryMode: deliveryMode ?? "wake",
        source: payload.source,
        message: payload.message,
        metadata: payload.metadata,
        createdAt: 1,
      },
    }));
    const markEventDelivered = vi.fn(async () => undefined);

    await deliverGatewayEventToThread({
      event: gatewayEvent(),
      riskScore: 0.1,
      source: gatewaySource({sessionId: undefined}),
      sessionStore: {
        getSession: vi.fn(async () => mainSession),
        getMainSession: vi.fn(async () => mainSession),
      },
      store: {
        markEventDelivered,
        markEventQuarantined: vi.fn(async () => undefined),
        reserveEventDelivery: vi.fn(async () => gatewayEvent({status: "delivering"})),
      },
      threadStore: {
        enqueueInput,
      },
    });

    expect(enqueueInput).toHaveBeenCalledWith("main-thread", expect.objectContaining({
      source: "gateway",
      externalMessageId: "event-1",
    }), "wake");
    expect(markEventDelivered).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "main-thread",
    }));
  });

  it("quarantines reserved delivery when no current thread exists before enqueue", async () => {
    const enqueueInput = vi.fn(async () => ({
      inserted: true,
      input: {
        id: "input-1",
        threadId: "missing",
        order: 1,
        deliveryMode: "wake",
        source: "gateway",
        message: {role: "user" as const, content: ""},
        createdAt: 1,
      },
    }));
    const markEventDelivered = vi.fn(async () => undefined);
    const markEventQuarantined = vi.fn(async () => undefined);

    await deliverGatewayEventToThread({
      event: gatewayEvent(),
      riskScore: 0.1,
      source: gatewaySource(),
      sessionStore: {
        getSession: vi.fn(async () => ({
          id: "session-1",
          agentKey: "panda",
          kind: "main" as const,
          currentThreadId: " ",
          createdAt: 1,
          updatedAt: 1,
        })),
        getMainSession: vi.fn(async () => null),
      },
      store: {
        markEventDelivered,
        markEventQuarantined,
        reserveEventDelivery: vi.fn(async () => gatewayEvent({status: "delivering"})),
      },
      threadStore: {
        enqueueInput,
      },
    });

    expect(enqueueInput).not.toHaveBeenCalled();
    expect(markEventDelivered).not.toHaveBeenCalled();
    expect(markEventQuarantined).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "event-1",
      claimId: "claim-1",
      reason: "Session session-1 has no current thread.",
    }));
  });

  it("delivers untrusted attachment descriptors in prompt and metadata", async () => {
    const attachment: GatewayEventAttachmentRecord = {
      id: "attachment-1",
      eventId: "event-1",
      position: 0,
      sourceId: "work-prod",
      idempotencyKey: "upload-1",
      status: "bound",
      scanStatus: "not_scanned",
      mimeType: "image/png",
      filename: "screenshot.png",
      sizeBytes: 123,
      sha256: "a".repeat(64),
      localPath: "/root/.panda/agents/panda/media/gateway/work-prod/2026-05/attachment-1.png",
      mediaSource: "gateway",
      connectorKey: "work-prod",
      mediaMetadata: {schemaVersion: 1},
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    const enqueueInput = vi.fn(async (threadId, payload, deliveryMode) => ({
      inserted: true,
      input: {
        id: "input-1",
        threadId,
        order: 1,
        deliveryMode: deliveryMode ?? "wake",
        source: payload.source,
        message: payload.message,
        metadata: payload.metadata,
        createdAt: 1,
      },
    }));
    const markEventDelivered = vi.fn(async () => undefined);

    await deliverGatewayEventToThread({
      event: gatewayEvent(),
      riskScore: 0.1,
      source: gatewaySource(),
      attachments: [attachment],
      attachmentRetentionMs: 1000,
      sessionStore: {
        getSession: vi.fn(async () => ({
          id: "session-1",
          agentKey: "panda",
          kind: "main" as const,
          currentThreadId: "thread-1",
          createdAt: 1,
          updatedAt: 1,
        })),
        getMainSession: vi.fn(async () => null),
      },
      store: {
        markEventDelivered,
        markEventQuarantined: vi.fn(async () => undefined),
        reserveEventDelivery: vi.fn(async () => gatewayEvent({status: "delivering"})),
      },
      threadStore: {enqueueInput},
    });

    const payload = enqueueInput.mock.calls[0]?.[1];
    expect(JSON.stringify(payload?.message)).toContain("attachments:");
    expect(JSON.stringify(payload?.message)).toContain(attachment.localPath);
    expect(payload?.metadata).toMatchObject({
      gateway: {
        attachments: [expect.objectContaining({
          id: "attachment-1",
          sha256: attachment.sha256,
          localPath: attachment.localPath,
          metadataTrust: "external_untrusted",
        })],
      },
    });
    expect(markEventDelivered).toHaveBeenCalledWith(expect.objectContaining({
      attachmentRetentionMs: 1000,
      threadId: "thread-1",
    }));
  });

});
