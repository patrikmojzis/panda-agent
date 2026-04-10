import {describe, expect, it, vi} from "vitest";

import {Agent, RunContext} from "../src/features/agent-core/index.js";
import type {PandaSessionContext} from "../src/features/panda/types.js";
import {TelegramReactTool} from "../src/features/telegram/telegram-react-tool.js";

function createRunContext(context: PandaSessionContext): RunContext<PandaSessionContext> {
  return new RunContext({
    agent: new Agent(),
    turn: 0,
    maxTurns: 10,
    messages: [],
    context,
  });
}

describe("TelegramReactTool", () => {
  it("defaults messageId to the current Telegram message", async () => {
    const api = {
      setMessageReaction: vi.fn(async () => {}),
    };
    const tool = new TelegramReactTool({
      api,
      connectorKey: "8669743878",
    });

    const result = await tool.run({
      emoji: "🔥",
    }, createRunContext({
      currentInput: {
        source: "telegram",
        externalMessageId: "555",
        metadata: {
          route: {
            connectorKey: "8669743878",
            externalConversationId: "1615376408",
          },
        },
      },
    }));

    expect(api.setMessageReaction).toHaveBeenCalledWith("1615376408", 555, [
      { type: "emoji", emoji: "🔥" },
    ]);
    expect(result).toEqual({
      ok: true,
      connectorKey: "8669743878",
      conversationId: "1615376408",
      messageId: "555",
      added: "🔥",
    });
  });

  it("defaults messageId to the reaction target message when the current input is a reaction", async () => {
    const api = {
      setMessageReaction: vi.fn(async () => {}),
    };
    const tool = new TelegramReactTool({
      api,
      connectorKey: "8669743878",
    });

    await tool.run({
      emoji: "👍",
    }, createRunContext({
      currentInput: {
        source: "telegram",
        externalMessageId: "telegram-reaction:777001",
        metadata: {
          route: {
            connectorKey: "8669743878",
            externalConversationId: "1615376408",
          },
          telegram: {
            reaction: {
              targetMessageId: "777",
            },
          },
        },
      },
    }));

    expect(api.setMessageReaction).toHaveBeenCalledWith("1615376408", 777, [
      { type: "emoji", emoji: "👍" },
    ]);
  });

  it("supports an explicit target override", async () => {
    const api = {
      setMessageReaction: vi.fn(async () => {}),
    };
    const tool = new TelegramReactTool({
      api,
      connectorKey: "8669743878",
    });

    const result = await tool.run({
      emoji: "👀",
      messageId: "888",
      target: {
        connectorKey: "8669743878",
        conversationId: "999999",
      },
    }, createRunContext({}));

    expect(api.setMessageReaction).toHaveBeenCalledWith("999999", 888, [
      { type: "emoji", emoji: "👀" },
    ]);
    expect(result).toEqual({
      ok: true,
      connectorKey: "8669743878",
      conversationId: "999999",
      messageId: "888",
      added: "👀",
    });
  });

  it("requires messageId when the current input is not Telegram", async () => {
    const api = {
      setMessageReaction: vi.fn(async () => {}),
    };
    const tool = new TelegramReactTool({
      api,
      connectorKey: "8669743878",
    });

    await expect(tool.run({
      emoji: "👀",
      target: {
        connectorKey: "8669743878",
        conversationId: "999999",
      },
    }, createRunContext({
      currentInput: {
        source: "tui",
        externalMessageId: "555",
      },
    }))).rejects.toThrow("telegram_react requires a target message id.");
    expect(api.setMessageReaction).not.toHaveBeenCalled();
  });

  it("clears reactions when remove=true", async () => {
    const api = {
      setMessageReaction: vi.fn(async () => {}),
    };
    const tool = new TelegramReactTool({
      api,
      connectorKey: "8669743878",
    });

    const result = await tool.run({
      remove: true,
    }, createRunContext({
      currentInput: {
        source: "telegram",
        externalMessageId: "555",
        metadata: {
          route: {
            connectorKey: "8669743878",
            externalConversationId: "1615376408",
          },
        },
      },
    }));

    expect(api.setMessageReaction).toHaveBeenCalledWith("1615376408", 555, []);
    expect(result).toEqual({
      ok: true,
      connectorKey: "8669743878",
      conversationId: "1615376408",
      messageId: "555",
      removed: true,
    });
  });

  it("returns structured invalid emoji failures", async () => {
    const api = {
      setMessageReaction: vi.fn(async () => {
        throw new Error("400 Bad Request: REACTION_INVALID");
      }),
    };
    const tool = new TelegramReactTool({
      api,
      connectorKey: "8669743878",
    });

    const result = await tool.run({
      emoji: "not-a-real-reaction",
    }, createRunContext({
      currentInput: {
        source: "telegram",
        externalMessageId: "555",
        metadata: {
          route: {
            connectorKey: "8669743878",
            externalConversationId: "1615376408",
          },
        },
      },
    }));

    expect(result).toEqual({
      ok: false,
      connectorKey: "8669743878",
      conversationId: "1615376408",
      messageId: "555",
      reason: "invalid_emoji",
      error: "400 Bad Request: REACTION_INVALID",
      emoji: "not-a-real-reaction",
    });
  });
});
