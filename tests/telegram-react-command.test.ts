import {describe, expect, it, vi} from "vitest";

import type {ChannelActionInput} from "../src/domain/channels/actions/types.js";
import type {CommandRequest} from "../src/domain/commands/types.js";
import {createTelegramReactCommand, TELEGRAM_REACT_COMMAND_NAME, type TelegramReactCommandQueue} from "../src/integrations/channels/telegram/commands.js";
import {TELEGRAM_SOURCE} from "../src/integrations/channels/telegram/config.js";

function createRequest(input: CommandRequest["input"]): CommandRequest {
  return {
    command: TELEGRAM_REACT_COMMAND_NAME,
    input,
    scope: {
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
      allowedCommands: [TELEGRAM_REACT_COMMAND_NAME],
    },
  };
}

function createReactCommand() {
  const actions: ChannelActionInput<"telegram_reaction">[] = [];
  const queue: TelegramReactCommandQueue = {
    enqueueAction: vi.fn(async (input) => {
      actions.push(input);
    }),
    listConversationBindings: vi.fn(async (filter) => {
      if (filter.source !== TELEGRAM_SOURCE || filter.connectorKey !== "telegram-main") {
        return [];
      }

      return [
        {
          source: TELEGRAM_SOURCE,
          connectorKey: "telegram-main",
          externalConversationId: "1615376408",
          sessionId: "session-1",
          createdAt: 1,
          updatedAt: 2,
        },
      ];
    }),
  };

  return {
    actions,
    command: createTelegramReactCommand(queue),
  };
}

describe("telegram.react command", () => {
  it("infers the reaction target from the current Telegram input", async () => {
    const {actions, command} = createReactCommand();

    const result = await command.execute(createRequest({
      emoji: "🔥",
      currentInput: {
        source: TELEGRAM_SOURCE,
        channelId: "fallback-chat",
        externalMessageId: "999",
        metadata: {
          route: {
            connectorKey: "telegram-main",
            externalConversationId: "1615376408",
          },
          telegram: {
            reaction: {
              targetMessageId: "555",
            },
          },
        },
      },
    }));

    expect(result.output).toMatchObject({
      ok: true,
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      messageId: "555",
      added: "🔥",
      queued: true,
    });
    expect(actions).toEqual([
      {
        channel: TELEGRAM_SOURCE,
        connectorKey: "telegram-main",
        kind: "telegram_reaction",
        payload: {
          conversationId: "1615376408",
          messageId: "555",
          emoji: "🔥",
          remove: false,
        },
      },
    ]);
  });

  it("falls back to the current Telegram message id when no reaction target is present", async () => {
    const {actions, command} = createReactCommand();

    const result = await command.execute(createRequest({
      emoji: "🔥",
      currentInput: {
        source: TELEGRAM_SOURCE,
        channelId: "1615376408",
        externalMessageId: "999",
        metadata: {
          route: {
            connectorKey: "telegram-main",
          },
        },
      },
    }));

    expect(result.output).toMatchObject({
      ok: true,
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      messageId: "999",
      added: "🔥",
      queued: true,
    });
    expect(actions[0]?.payload).toMatchObject({
      conversationId: "1615376408",
      messageId: "999",
      emoji: "🔥",
    });
  });

  it("rejects non-Telegram current input without an explicit target", async () => {
    const {command} = createReactCommand();

    await expect(command.execute(createRequest({
      emoji: "🔥",
      currentInput: {
        source: "whatsapp",
        channelId: "1615376408",
        externalMessageId: "555",
        metadata: {
          route: {
            connectorKey: "telegram-main",
            externalConversationId: "1615376408",
          },
        },
      },
    }))).rejects.toThrow("telegram.react requires a current Telegram input or an explicit target.");
  });

  it("rejects inferred targets outside the current session", async () => {
    const {command} = createReactCommand();

    const denied = await command.execute(createRequest({
      emoji: "🔥",
      currentInput: {
        source: TELEGRAM_SOURCE,
        channelId: "999999999",
        externalMessageId: "555",
        metadata: {
          route: {
            connectorKey: "telegram-main",
            externalConversationId: "999999999",
          },
        },
      },
    })).then(() => null, (error: unknown) => error as Error);
    expect(denied).toMatchObject({
      pandaCommandErrorCode: "forbidden",
      pandaCommandErrorDetails: {
        failureCode: "resource_scope_denied",
        retryable: false,
        exitCode: 3,
      },
    });
    expect(denied?.message).not.toContain("999999999");
  });
});
