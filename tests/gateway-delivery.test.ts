import {describe, expect, it, vi} from "vitest";

import type {GatewayEventRecord, GatewaySourceRecord} from "../src/domain/gateway/types.js";
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
});
