import {describe, expect, it, vi} from "vitest";

import type {OutboundDeliveryInput} from "../src/domain/channels/deliveries/types.js";
import type {CommandFileResolver} from "../src/domain/commands/files.js";
import type {CommandRequest} from "../src/domain/commands/types.js";
import {createDiscordSendCommand, DISCORD_SEND_COMMAND_NAME} from "../src/integrations/channels/discord/commands.js";
import {DISCORD_SOURCE} from "../src/integrations/channels/discord/config.js";
import {createTelegramSendCommand, TELEGRAM_SEND_COMMAND_NAME} from "../src/integrations/channels/telegram/commands.js";
import {TELEGRAM_SOURCE} from "../src/integrations/channels/telegram/config.js";

const fileResolver: CommandFileResolver = {
  async resolveReadablePath({file}) {
    return {
      path: file.path,
      displayPath: file.path,
    };
  },
};

function createRequest(command: CommandRequest["command"], input: CommandRequest["input"]): CommandRequest {
  return {
    command,
    input,
    scope: {
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
      allowedCommands: [command],
    },
  };
}

function createSendServices(input: {
  source: string;
  connectorKey: string;
  conversationId: string;
}) {
  const deliveries: OutboundDeliveryInput[] = [];
  return {
    deliveries,
    services: {
      enqueueDelivery: vi.fn(async (delivery: OutboundDeliveryInput) => {
        deliveries.push(delivery);
        return {
          id: "delivery-1",
          channel: delivery.channel,
        };
      }),
      listConversationBindings: vi.fn(async (filter: {source: string; connectorKey: string}) => {
        if (filter.source !== input.source || filter.connectorKey !== input.connectorKey) {
          return [];
        }

        return [
          {
            source: input.source,
            connectorKey: input.connectorKey,
            externalConversationId: input.conversationId,
            sessionId: "session-1",
            createdAt: 1,
            updatedAt: 2,
          },
        ];
      }),
    },
  };
}

describe("channel send command authority", () => {
  it("queues explicit sends only for current-session conversation bindings", async () => {
    const {deliveries, services} = createSendServices({
      source: TELEGRAM_SOURCE,
      connectorKey: "telegram-main",
      conversationId: "1615376408",
    });
    const command = createTelegramSendCommand(services, fileResolver);

    await expect(command.execute(createRequest(TELEGRAM_SEND_COMMAND_NAME, {
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      items: [{type: "text", text: "hello"}],
    }))).resolves.toMatchObject({
      ok: true,
      output: {
        status: "queued",
      },
    });

    expect(deliveries).toHaveLength(1);
  });

  it("rejects Telegram sends to conversations outside the current session", async () => {
    const {services} = createSendServices({
      source: TELEGRAM_SOURCE,
      connectorKey: "telegram-main",
      conversationId: "1615376408",
    });
    const command = createTelegramSendCommand(services, fileResolver);

    const denied = await command.execute(createRequest(TELEGRAM_SEND_COMMAND_NAME, {
      connectorKey: "telegram-main",
      conversationId: "999999999",
      items: [{type: "text", text: "hello"}],
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
    expect(services.enqueueDelivery).not.toHaveBeenCalled();
  });

  it("rejects shared explicit send commands outside the current session", async () => {
    const {services} = createSendServices({
      source: DISCORD_SOURCE,
      connectorKey: "discord-main",
      conversationId: "123456789012345678",
    });
    const command = createDiscordSendCommand(services, fileResolver);

    const denied = await command.execute(createRequest(DISCORD_SEND_COMMAND_NAME, {
      connectorKey: "discord-main",
      conversationId: "223456789012345678",
      items: [{type: "text", text: "hello"}],
    })).then(() => null, (error: unknown) => error as Error);
    expect(denied).toMatchObject({
      pandaCommandErrorCode: "forbidden",
      pandaCommandErrorDetails: {
        failureCode: "resource_scope_denied",
        retryable: false,
        exitCode: 3,
      },
    });
    expect(denied?.message).not.toContain("223456789012345678");
    expect(services.enqueueDelivery).not.toHaveBeenCalled();
  });
});
