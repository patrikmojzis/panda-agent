import type {JsonObject} from "../../../kernel/agent/types.js";
import type {RememberedRoute} from "../../../domain/channels/types.js";
import {renderTuiInboundText} from "../../../prompts/channels/tui.js";

export const TUI_SOURCE = "tui";
export const TUI_CONNECTOR_KEY = "local-tui";
export const TUI_CONVERSATION_ID = "terminal";

/**
 * Keeps TUI input route metadata aligned with the prompt wrapper so channel
 * handling can treat terminal chat like any other human-facing lane.
 */
export function buildTuiInboundPersistence(options: {
  sentAt?: string;
  externalMessageId: string;
  actorId: string;
}): {
  metadata: JsonObject;
  rememberedRoute: RememberedRoute;
} {
  return {
    metadata: {
      route: {
        source: TUI_SOURCE,
        connectorKey: TUI_CONNECTOR_KEY,
        externalConversationId: TUI_CONVERSATION_ID,
        externalActorId: options.actorId,
        externalMessageId: options.externalMessageId,
      },
      tui: {
        sentAt: options.sentAt ?? null,
        conversationId: TUI_CONVERSATION_ID,
        actorId: options.actorId,
        externalMessageId: options.externalMessageId,
      },
    },
    rememberedRoute: {
      source: TUI_SOURCE,
      connectorKey: TUI_CONNECTOR_KEY,
      externalConversationId: TUI_CONVERSATION_ID,
      externalActorId: options.actorId,
      externalMessageId: options.externalMessageId,
      capturedAt: Date.now(),
    },
  };
}

export function buildTuiInboundText(options: {
  actorId: string;
  externalMessageId: string;
  identityId?: string;
  identityHandle?: string;
  sentAt?: string;
  body: string;
}): string {
  return renderTuiInboundText({
    channel: TUI_SOURCE,
    connectorKey: TUI_CONNECTOR_KEY,
    conversationId: TUI_CONVERSATION_ID,
    actorId: options.actorId,
    externalMessageId: options.externalMessageId,
    identityId: options.identityId,
    identityHandle: options.identityHandle,
    sentAt: options.sentAt,
    body: options.body,
  });
}
