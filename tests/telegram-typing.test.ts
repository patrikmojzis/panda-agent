import {describe, expect, it, vi} from "vitest";

import {createTelegramTypingAdapter} from "../src/index.js";

describe("createTelegramTypingAdapter", () => {
  it("sends typing actions and preserves the message thread id", async () => {
    const sendChatAction = vi.fn(async () => true);
    const adapter = createTelegramTypingAdapter({
      api: {
        sendChatAction,
      } as never,
      connectorKey: "main",
    });

    await adapter.send({
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "main",
        externalConversationId: "777:99",
      },
      phase: "start",
    });
    await adapter.send({
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "main",
        externalConversationId: "777:99",
      },
      phase: "keepalive",
    });
    await adapter.send({
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "main",
        externalConversationId: "777:99",
      },
      phase: "stop",
    });

    expect(sendChatAction).toHaveBeenCalledTimes(2);
    expect(sendChatAction).toHaveBeenNthCalledWith(1, "777", "typing", {
      message_thread_id: 99,
    });
    expect(sendChatAction).toHaveBeenNthCalledWith(2, "777", "typing", {
      message_thread_id: 99,
    });
  });

  it("fails fast on connector mismatches", async () => {
    const adapter = createTelegramTypingAdapter({
      api: {
        sendChatAction: vi.fn(async () => true),
      } as never,
      connectorKey: "main",
    });

    await expect(adapter.send({
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "other",
        externalConversationId: "777",
      },
      phase: "start",
    })).rejects.toThrow("Telegram typing connector mismatch. Expected main, got other.");
  });
});
