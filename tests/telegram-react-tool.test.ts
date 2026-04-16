import {describe, expect, it, vi} from "vitest";

import {Agent, RunContext} from "../src/kernel/agent/index.js";
import type {DefaultAgentSessionContext} from "../src/app/runtime/panda-session-context.js";
import {TelegramReactTool} from "../src/integrations/channels/telegram/telegram-react-tool.js";

function createRunContext(context: DefaultAgentSessionContext): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent(),
    turn: 0,
    maxTurns: 10,
    messages: [],
    context,
  });
}

function createQueue() {
  return {
    enqueueAction: vi.fn(async () => ({
      id: "action-1",
      channel: "telegram",
      connectorKey: "8669743878",
      kind: "telegram_reaction",
      payload: {},
      createdAt: 1,
      updatedAt: 1,
    })),
  };
}

describe("TelegramReactTool", () => {
  it("defaults messageId to the current Telegram message", async () => {
    const channelActionQueue = createQueue();
    const tool = new TelegramReactTool();

    const result = await tool.run({
      emoji: "🔥",
    }, createRunContext({
      channelActionQueue,
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

    expect(channelActionQueue.enqueueAction).toHaveBeenCalledWith({
      channel: "telegram",
      connectorKey: "8669743878",
      kind: "telegram_reaction",
      payload: {
        conversationId: "1615376408",
        messageId: "555",
        emoji: "🔥",
        remove: false,
      },
    });
    expect(result).toEqual({
      ok: true,
      connectorKey: "8669743878",
      conversationId: "1615376408",
      messageId: "555",
      added: "🔥",
      queued: true,
    });
  });

  it("defaults messageId to the reaction target message when the current input is a reaction", async () => {
    const channelActionQueue = createQueue();
    const tool = new TelegramReactTool();

    await tool.run({
      emoji: "👍",
    }, createRunContext({
      channelActionQueue,
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

    expect(channelActionQueue.enqueueAction).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        messageId: "777",
        emoji: "👍",
      }),
    }));
  });

  it("supports an explicit target override", async () => {
    const channelActionQueue = createQueue();
    const tool = new TelegramReactTool();

    const result = await tool.run({
      emoji: "👀",
      messageId: "888",
      target: {
        connectorKey: "8669743878",
        conversationId: "999999",
      },
    }, createRunContext({
      channelActionQueue,
    }));

    expect(channelActionQueue.enqueueAction).toHaveBeenCalledWith({
      channel: "telegram",
      connectorKey: "8669743878",
      kind: "telegram_reaction",
      payload: {
        conversationId: "999999",
        messageId: "888",
        emoji: "👀",
        remove: false,
      },
    });
    expect(result).toEqual({
      ok: true,
      connectorKey: "8669743878",
      conversationId: "999999",
      messageId: "888",
      added: "👀",
      queued: true,
    });
  });

  it("requires messageId when the current input is not Telegram", async () => {
    const channelActionQueue = createQueue();
    const tool = new TelegramReactTool();

    await expect(tool.run({
      emoji: "👀",
      target: {
        connectorKey: "8669743878",
        conversationId: "999999",
      },
    }, createRunContext({
      channelActionQueue,
      currentInput: {
        source: "tui",
        externalMessageId: "555",
      },
    }))).rejects.toThrow("telegram_react requires a target message id.");
    expect(channelActionQueue.enqueueAction).not.toHaveBeenCalled();
  });

  it("clears reactions when remove=true", async () => {
    const channelActionQueue = createQueue();
    const tool = new TelegramReactTool();

    const result = await tool.run({
      remove: true,
    }, createRunContext({
      channelActionQueue,
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

    expect(channelActionQueue.enqueueAction).toHaveBeenCalledWith({
      channel: "telegram",
      connectorKey: "8669743878",
      kind: "telegram_reaction",
      payload: {
        conversationId: "1615376408",
        messageId: "555",
        emoji: undefined,
        remove: true,
      },
    });
    expect(result).toEqual({
      ok: true,
      connectorKey: "8669743878",
      conversationId: "1615376408",
      messageId: "555",
      removed: true,
      queued: true,
    });
  });

  it("fails when the runtime does not expose a channel action queue", async () => {
    const tool = new TelegramReactTool();

    await expect(tool.run({
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
    }))).rejects.toThrow("telegram_react is unavailable in this runtime.");
  });
});
