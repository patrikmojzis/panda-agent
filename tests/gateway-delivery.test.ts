import {describe, expect, it, vi} from "vitest";

import type {GatewayEventAttachmentRecord, GatewayEventRecord, GatewaySourceRecord} from "../src/domain/gateway/types.js";
import {deliverGatewayEventToThread, readGatewayDeliveryAssessment, type GatewayDeliveryStore} from "../src/integrations/gateway/delivery.js";

import {GatewayDeliveryTargetUnavailableError} from "../src/domain/gateway/postgres.js";

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
    trusted: false,
    status: "processing",
    claimId: "claim-1",
    createdAt: 1,
    ...overrides,
  };
}

function deliveryStore() {
  return {
    listEventAttachments: vi.fn(async () => []),
    recordEventAssessment: vi.fn<GatewayDeliveryStore["recordEventAssessment"]>(async () => gatewayEvent({inputId: "receipt-1"})),
    commitEventDelivery: vi.fn<GatewayDeliveryStore["commitEventDelivery"]>(async () => gatewayEvent({status: "delivered", threadId: "thread-1"})),
    markEventQuarantined: vi.fn<GatewayDeliveryStore["markEventQuarantined"]>(async () => gatewayEvent({status: "quarantined"})),
    getEvent: vi.fn(async () => gatewayEvent()),
  } satisfies GatewayDeliveryStore;
}

function deliveryInput(store = deliveryStore()) {
  return {store, event: gatewayEvent(), source: gatewaySource(), assessment: {guardStatus: "scored" as const, riskScore: 0.1, trusted: false as const}};
}

describe("gateway delivery", () => {
  it("passes durable source authority into the complete admission operation", async () => {
    const input = deliveryInput();
    await deliverGatewayEventToThread(input);
    expect(input.store.commitEventDelivery).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "event-1", claimId: "claim-1", source: input.source,
      payload: expect.objectContaining({source: "gateway", externalMessageId: "event-1"}),
    }));
  });

  it("does not admit work after losing the processing claim", async () => {
    const input = deliveryInput();
    input.store.recordEventAssessment.mockResolvedValue(null);
    await deliverGatewayEventToThread(input);
    expect(input.store.commitEventDelivery).not.toHaveBeenCalled();
  });

  it("quarantines an explicit unavailable target without treating other failures as rejection", async () => {
    const input = deliveryInput();
    input.store.commitEventDelivery.mockRejectedValue(new GatewayDeliveryTargetUnavailableError("Session archived"));
    await deliverGatewayEventToThread(input);
    expect(input.store.markEventQuarantined).toHaveBeenCalledWith(expect.objectContaining({reason: "Session archived", claimId: "claim-1"}));
  });

  it("recovers a lost commit acknowledgement from its delivered receipt", async () => {
    const input = deliveryInput();
    input.store.commitEventDelivery.mockRejectedValue(new Error("commit acknowledgement lost"));
    input.store.getEvent.mockResolvedValue(gatewayEvent({status: "delivered"}));
    await deliverGatewayEventToThread(input);
    expect(input.store.markEventQuarantined).not.toHaveBeenCalled();
  });

  it("keeps unknown database failures retryable without scrubbing payloads", async () => {
    const input = deliveryInput();
    input.store.commitEventDelivery.mockRejectedValue(new Error("database unavailable"));
    input.store.getEvent.mockRejectedValue(new Error("database unavailable"));
    await expect(deliverGatewayEventToThread(input)).rejects.toThrow("database unavailable");
    expect(input.store.markEventQuarantined).not.toHaveBeenCalled();
  });

  it("reuses the durable guard assessment and rejects a malformed receipt", () => {
    expect(readGatewayDeliveryAssessment(gatewayEvent())).toBeUndefined();
    expect(readGatewayDeliveryAssessment(gatewayEvent({inputId: "receipt", riskScore: 0.2, metadata: {gateway: {guardStatus: "scored"}}})))
      .toEqual({guardStatus: "scored", trusted: false, riskScore: 0.2});
    expect(() => readGatewayDeliveryAssessment(gatewayEvent({inputId: "receipt"}))).toThrow("persisted guard assessment");
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
    const store = deliveryStore();

    await deliverGatewayEventToThread({
      event: gatewayEvent(),
      assessment: {guardStatus: "scored", riskScore: 0.1, trusted: false},
      source: gatewaySource(),
      attachments: [attachment],
      attachmentRetentionMs: 1000,
      store,
    });

    const payload = store.commitEventDelivery.mock.calls[0]?.[0].payload;
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
    expect(store.commitEventDelivery).toHaveBeenCalledWith(expect.objectContaining({
      attachmentRetentionMs: 1000,
    }));
  });

  it("delivers trusted text and attachments with an explicit guard bypass", async () => {
    const attachment: GatewayEventAttachmentRecord = {
      id: "attachment-1",
      eventId: "event-1",
      position: 0,
      sourceId: "work-prod",
      idempotencyKey: "upload-1",
      status: "bound",
      scanStatus: "not_scanned",
      mimeType: "text/plain",
      filename: "instructions.txt",
      sizeBytes: 123,
      sha256: "a".repeat(64),
      localPath: "/root/.panda/agents/panda/media/gateway/work-prod/instructions.txt",
      mediaSource: "gateway",
      connectorKey: "work-prod",
      mediaMetadata: {
        schemaVersion: 1,
        gateway: {
          scanStatus: "not_scanned",
          trust: "external_untrusted",
        },
      },
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    const store = deliveryStore();

    await deliverGatewayEventToThread({
      event: gatewayEvent({trusted: true}),
      assessment: {guardStatus: "bypassed", trusted: true},
      source: gatewaySource(),
      attachments: [attachment],
      store,
    });

    const payload = store.commitEventDelivery.mock.calls[0]?.[0].payload;
    const rendered = JSON.stringify(payload?.message);
    expect(rendered).toContain("Trusted gateway event");
    expect(rendered).toContain("guard_status: bypassed");
    expect(rendered).toContain("metadata_trust: trusted");
    expect(rendered).toContain("scan_status: not_scanned");
    expect(rendered).not.toContain("risk_score:");
    expect(payload?.metadata).toMatchObject({
      gateway: {
        guardStatus: "bypassed",
        metadataTrust: "trusted",
        trusted: true,
        attachments: [expect.objectContaining({
          guardStatus: "bypassed",
          metadataTrust: "trusted",
          metadata: {
            schemaVersion: 1,
            gateway: {
              guardStatus: "bypassed",
              scanStatus: "not_scanned",
              trust: "trusted",
            },
          },
          scanStatus: "not_scanned",
        })],
      },
    });
    expect(store.recordEventAssessment.mock.calls[0]?.[0]).not.toHaveProperty("riskScore");
    expect(store.commitEventDelivery.mock.calls[0]?.[0]).not.toHaveProperty("riskScore");
  });

});
