import {describe, expect, it, vi} from "vitest";

import {createDaemonRequestProcessor} from "../src/app/runtime/daemon-requests.js";
import type {DaemonContext} from "../src/app/runtime/daemon-bootstrap.js";
import type {DaemonThreadHelpers} from "../src/app/runtime/daemon-threads.js";
import type {RuntimeRequestRecord, WhatsAppReactionRequestPayload} from "../src/domain/threads/requests/index.js";

function whatsappReactionRequest(
  overrides: Partial<WhatsAppReactionRequestPayload> = {},
): RuntimeRequestRecord<WhatsAppReactionRequestPayload> {
  return {
    id: "request-1",
    kind: "whatsapp_reaction",
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    payload: {
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
      externalActorId: "421900000000@s.whatsapp.net",
      externalMessageId: "reaction-1",
      remoteJid: "421900000000@s.whatsapp.net",
      chatType: "private",
      targetMessageId: "target-1",
      emoji: "👍",
      pushName: "Patrik",
      ...overrides,
    },
  };
}

function createHarness(options: {
  binding?: {identityId: string} | null;
  thread?: {id: string; sessionId: string} | null;
} = {}) {
  const binding = options.binding === undefined ? {identityId: "identity-1"} : options.binding;
  const thread = options.thread === undefined ? {id: "thread-1", sessionId: "session-1"} : options.thread;
  const submitInput = vi.fn(async () => {});
  const saveLastRoute = vi.fn(async () => {});
  const resolveOrCreateConversationThread = vi.fn(async () => thread);
  const context = {
    runtime: {
      identityStore: {
        resolveIdentityBinding: vi.fn(async () => binding),
        getIdentity: vi.fn(async () => ({
          id: "identity-1",
          handle: "patrik",
          displayName: "Patrik",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        })),
      },
      coordinator: {
        submitInput,
      },
    },
    sessionRoutes: {
      saveLastRoute,
    },
  } as unknown as DaemonContext;
  const threads = {
    resolveOrCreateConversationThread,
  } as unknown as DaemonThreadHelpers;

  return {
    context,
    resolveOrCreateConversationThread,
    saveLastRoute,
    submitInput,
    threads,
  };
}

describe("daemon request processor", () => {
  it("routes paired WhatsApp reactions to the conversation thread", async () => {
    const harness = createHarness();
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(whatsappReactionRequest())).resolves.toEqual({
      status: "queued",
      threadId: "thread-1",
    });

    expect(harness.resolveOrCreateConversationThread).toHaveBeenCalledWith({
      identityId: "identity-1",
      source: "whatsapp",
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
      context: {
        source: "whatsapp",
        remoteJid: "421900000000@s.whatsapp.net",
      },
    });
    expect(harness.submitInput).toHaveBeenCalledWith("thread-1", expect.objectContaining({
      source: "whatsapp",
      externalMessageId: "reaction-1",
      actorId: "421900000000@s.whatsapp.net",
      identityId: "identity-1",
      message: expect.objectContaining({
        content: expect.stringContaining("Added reaction: 👍"),
      }),
      metadata: expect.objectContaining({
        whatsapp: expect.objectContaining({
          reaction: {
            targetMessageId: "target-1",
            emoji: "👍",
            actorId: "421900000000@s.whatsapp.net",
          },
        }),
      }),
    }));
    expect(harness.saveLastRoute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      identityId: "identity-1",
    }));
  });

  it("drops WhatsApp reactions from unpaired actors", async () => {
    const harness = createHarness({
      binding: null,
    });
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(whatsappReactionRequest())).resolves.toEqual({
      status: "dropped",
      reason: "unpaired_actor",
    });

    expect(harness.submitInput).not.toHaveBeenCalled();
  });

  it("drops WhatsApp reactions on conversation identity mismatch", async () => {
    const harness = createHarness({
      thread: null,
    });
    const processor = createDaemonRequestProcessor(harness.context, harness.threads);

    await expect(processor(whatsappReactionRequest())).resolves.toEqual({
      status: "dropped",
      reason: "conversation_identity_mismatch",
    });

    expect(harness.submitInput).not.toHaveBeenCalled();
  });
});
