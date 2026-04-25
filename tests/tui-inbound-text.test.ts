import {describe, expect, it} from "vitest";

import {
    buildTuiInboundPersistence,
    TUI_CONNECTOR_KEY,
    TUI_CONVERSATION_ID,
    TUI_SOURCE,
} from "../src/integrations/channels/tui/helpers.js";
import {renderTuiInboundText} from "../src/prompts/channels/tui.js";

describe("tui inbound text", () => {
  it("renders channel-style metadata in the message header", () => {
    const text = renderTuiInboundText({
      channel: TUI_SOURCE,
      connectorKey: TUI_CONNECTOR_KEY,
      conversationId: TUI_CONVERSATION_ID,
      actorId: "local-user",
      externalMessageId: "msg-1",
      identityHandle: "patrik",
      sentAt: "2026-04-21T18:22:00.000Z",
      body: "hello from terminal",
    });

    expect(text).toContain("<runtime-channel-context>");
    expect(text).toContain("channel: tui");
    expect(text).toContain("connector_key: local-tui");
    expect(text).toContain("conversation_id: terminal");
    expect(text).toContain("actor_id: local-user");
    expect(text).toContain("external_message_id: msg-1");
    expect(text).not.toContain("identity_id:");
    expect(text).toContain("identity_handle: patrik");
    expect(text).toContain("attachments:");
    expect(text).toContain("- none");
    expect(text).toContain("hello from terminal");
  });

  it("builds route metadata so TUI input behaves like a real channel lane", () => {
    const persistence = buildTuiInboundPersistence({
      sentAt: "2026-04-21T18:22:00.000Z",
      actorId: "local-user",
      externalMessageId: "msg-1",
    });

    expect(persistence.metadata).toEqual({
      route: {
        source: "tui",
        connectorKey: "local-tui",
        externalConversationId: "terminal",
        externalActorId: "local-user",
        externalMessageId: "msg-1",
      },
      tui: {
        sentAt: "2026-04-21T18:22:00.000Z",
        conversationId: "terminal",
        actorId: "local-user",
        externalMessageId: "msg-1",
      },
    });
    expect(persistence.rememberedRoute).toEqual({
      source: "tui",
      connectorKey: "local-tui",
      externalConversationId: "terminal",
      externalActorId: "local-user",
      externalMessageId: "msg-1",
      capturedAt: expect.any(Number),
    });
  });
});
