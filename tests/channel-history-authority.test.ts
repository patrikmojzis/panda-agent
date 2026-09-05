import {describe, expect, it, vi} from "vitest";

import type {ConnectorAccountRecord} from "../src/domain/connectors/types.js";
import type {OutboundDeliveryRecord} from "../src/domain/channels/deliveries/types.js";
import type {ConversationBinding, ConversationLookup} from "../src/domain/sessions/conversations/types.js";
import type {ThreadMessageRecord} from "../src/kernel/transcript/types.js";
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
    messages: {listChannelMessages: vi.fn(async (): Promise<ThreadMessageRecord[]> => [])},
    deliveries: {listDeliveriesForTarget: vi.fn(async (): Promise<OutboundDeliveryRecord[]> => [])},
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

  it("preserves tolerant inbound text extraction and distinct inbound/outbound preview limits", async () => {
    const deps = services(source, id);
    const contentCases = [
      {content: undefined, preview: {}},
      {content: null, preview: {}},
      {content: 42, preview: {}},
      {content: {}, preview: {}},
      {content: [], preview: {}},
      {content: " \t\n", preview: {}},
      {content: "\u00a0trimmed\u00a0", preview: {text: "trimmed"}},
      {
        content: [null, false, "not a block", {}, {type: "image", text: "hidden"}, {type: "text", text: 42},
          {type: "text", text: " first "}, {type: "text", text: " \n"}, {type: "text", text: "second\nline "}],
        preview: {text: "first\n\nsecond\nline"},
      },
      {content: "x".repeat(1200), preview: {text: "x".repeat(1200)}},
      {content: ` ${"x".repeat(1201)} `, preview: {text: `${"x".repeat(1200)}...`, truncated: true}},
    ];
    deps.messages.listChannelMessages.mockResolvedValue(contentCases.map(({content}, index) => ({
      id: `message-${index}`, threadId: "thread-1", source, sequence: index, origin: "input", createdAt: index + 1,
      message: {role: "user", content, timestamp: index + 1} as ThreadMessageRecord["message"],
    })));
    deps.deliveries.listDeliveriesForTarget.mockResolvedValue([{
      id: "delivery-1", threadId: "thread-1", sessionId: scope.sessionId, channel: source,
      target: {source, connectorKey: "connector-1", externalConversationId: id},
      status: "sent", attemptCount: 1, createdAt: 100, updatedAt: 100,
      items: [{type: "text", text: " \n"}, {type: "text", text: "x".repeat(500)}, {type: "text", text: ` ${"x".repeat(501)} `}],
    }]);

    const result = await create(deps).execute({
      command: `${source}.history`, input: {connectorKey: "connector-1", [targetKey]: id}, scope,
    });
    expect((result.output as {items: unknown[]}).items).toEqual([
      ...contentCases.map(({preview}, index) => ({
        id: `message-${index}`, direction: "inbound", threadId: "thread-1", ...preview, createdAt: index + 1,
      })),
      {
        id: "delivery-1", deliveryId: "delivery-1", direction: "outbound", status: "sent", threadId: "thread-1", createdAt: 100,
        items: [{type: "text"}, {type: "text", text: "x".repeat(500)}, {type: "text", text: `${"x".repeat(500)}...`, truncated: true}],
      },
    ]);
  });
});

describe.each(cases.filter(({source}) => source !== "whatsapp"))("$source connector inference", ({source, id, targetKey, create}) => {
  it("retains the ambiguity failure for the same chat bound on two enabled connectors", async () => {
    const command = create(services(source, id, "session-1", ["connector-1", "connector-2"]));
    await expect(command.execute({command: `${source}.history`, input: {[targetKey]: id}, scope})).rejects.toThrow("multiple matching");
  });
});
