import {describe, expect, it, vi} from "vitest";

import type {ConnectorAccountRecord} from "../src/domain/connectors/types.js";
import type {ConversationBinding, ConversationLookup} from "../src/domain/sessions/conversations/types.js";
import {createDiscordHistoryCommand} from "../src/integrations/channels/discord/commands.js";
import {createTelegramHistoryCommand} from "../src/integrations/channels/telegram/commands.js";
import {createWhatsAppHistoryCommand} from "../src/integrations/channels/whatsapp/commands.js";

function services(source: string, externalConversationId: string, sessionId = "session-1", connectorKeys = ["connector-1"]) {
  const bindings: ConversationBinding[] = connectorKeys.map((connectorKey) => ({
    source, connectorKey, externalConversationId, sessionId, createdAt: 1, updatedAt: 2,
  }));
  const accounts: ConnectorAccountRecord[] = connectorKeys.map((connectorKey) => ({
    id: connectorKey, source, connectorKey, accountKey: connectorKey, ownerKind: "agent", ownerAgentKey: "panda",
    ownerIdentityId: null, status: "enabled", config: {}, createdAt: 1, updatedAt: 2,
  }));
  return {
    connectorAccounts: {listAccounts: async () => accounts},
    conversations: {
      getConversationBinding: async (lookup: ConversationLookup) => bindings.find((binding) =>
        binding.source === lookup.source
        && binding.connectorKey === lookup.connectorKey
        && binding.externalConversationId === lookup.externalConversationId,
      ) ?? null,
    },
    messages: {listChannelMessages: vi.fn(async () => [])},
    deliveries: {listDeliveriesForTarget: vi.fn(async () => [])},
  };
}

const scope = {agentKey: "panda", sessionId: "session-1"};
const cases = [
  {source: "telegram", id: "1615376408", targetKey: "conversationId", outputKey: "chat", create: createTelegramHistoryCommand},
  {source: "discord", id: "123456789012345678", targetKey: "channelId", outputKey: "channel", create: createDiscordHistoryCommand},
  {source: "whatsapp", id: "421123456789@s.whatsapp.net", targetKey: "chatId", outputKey: "chat", create: createWhatsAppHistoryCommand},
];

describe.each(cases)("$source history conversation authority", ({source, id, targetKey, outputKey, create}) => {
  it("reads an exact bound conversation and preserves the command output", async () => {
    const command = create(services(source, id));
    const result = await command.execute({command: `${source}.history`, input: {connectorKey: "connector-1", [targetKey]: id}, scope});
    expect(result.output).toEqual({
      ok: true, source: "durable_panda_records", direction: "all", limit: 20, count: 0, items: [],
      [outputKey]: {connectorKey: "connector-1", [targetKey]: id, sessionId: "session-1"},
    });
  });

  it("denies a foreign session before reading its history", async () => {
    const deps = services(source, id, "private-session");
    await expect(create(deps).execute({command: `${source}.history`, input: {connectorKey: "connector-1", [targetKey]: id}, scope}))
      .rejects.toMatchObject({pandaCommandErrorCode: "forbidden", pandaCommandErrorDetails: {failureCode: "resource_scope_denied"}});
    expect(deps.messages.listChannelMessages).not.toHaveBeenCalled();
    expect(deps.deliveries.listDeliveriesForTarget).not.toHaveBeenCalled();
  });
});

describe.each(cases.filter(({source}) => source !== "whatsapp"))("$source connector inference", ({source, id, targetKey, create}) => {
  it("retains the ambiguity failure for the same chat bound on two enabled connectors", async () => {
    const command = create(services(source, id, "session-1", ["connector-1", "connector-2"]));
    await expect(command.execute({command: `${source}.history`, input: {[targetKey]: id}, scope})).rejects.toThrow("multiple matching");
  });
});
