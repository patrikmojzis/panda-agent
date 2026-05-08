import type {JsonObject} from "../../../kernel/agent/types.js";
import type {
    A2AEnvironmentPathHints,
    A2AMessageItem,
    A2AMessageRequestPayload,
    A2ASenderEnvironmentSnapshot
} from "../../../domain/threads/requests/index.js";
import {
    renderA2AAttachmentCaption,
    renderA2AInboundFallbackBody,
    renderA2AInboundText
} from "../../../prompts/channels/a2a.js";
import {A2A_SOURCE} from "./config.js";
import {describeMediaDescriptor, serializeMediaDescriptor} from "../media-shared.js";

function serializeItem(item: A2AMessageItem): JsonObject {
  switch (item.type) {
    case "text":
      return {
        type: "text",
        text: item.text,
      };
    case "image":
      return {
        type: "image",
        media: serializeMediaDescriptor(item.media),
        caption: item.caption ?? null,
      };
    case "file":
      return {
        type: "file",
        media: serializeMediaDescriptor(item.media),
        filename: item.filename ?? null,
        caption: item.caption ?? null,
        mimeType: item.mimeType ?? null,
      };
  }
}

function serializePathHints(hints: A2AEnvironmentPathHints | undefined): JsonObject | null {
  if (!hints) {
    return null;
  }

  const serialized: JsonObject = {};
  for (const key of ["root", "workspace", "inbox", "artifacts"] as const) {
    const value = hints[key];
    if (value) {
      serialized[key] = value;
    }
  }

  return Object.keys(serialized).length === 0 ? null : serialized;
}

function serializeSenderEnvironment(environment: A2ASenderEnvironmentSnapshot): JsonObject {
  return {
    id: environment.id,
    kind: environment.kind,
    envDir: environment.envDir ?? null,
    parentRunnerPaths: serializePathHints(environment.parentRunnerPaths),
    workerPaths: serializePathHints(environment.workerPaths),
  };
}

function textBlocks(items: readonly A2AMessageItem[]): string[] {
  return items.flatMap((item) => {
    if (item.type !== "text") {
      return [];
    }

    const trimmed = item.text.trim();
    return trimmed ? [trimmed] : [];
  });
}

function attachmentDescriptions(items: readonly A2AMessageItem[]): string[] {
  return items.flatMap((item) => {
    switch (item.type) {
      case "text":
        return [];
      case "image":
        return [describeMediaDescriptor(item.media, [renderA2AAttachmentCaption(item.caption)])];
      case "file":
        return [describeMediaDescriptor(item.media, [renderA2AAttachmentCaption(item.caption)])];
    }
  });
}

export function buildA2AInboundPersistence(
  payload: A2AMessageRequestPayload,
): {metadata: JsonObject} {
  const a2aMetadata: JsonObject = {
    source: A2A_SOURCE,
    connectorKey: payload.connectorKey,
    messageId: payload.externalMessageId,
    fromAgentKey: payload.fromAgentKey,
    fromSessionId: payload.fromSessionId,
    fromThreadId: payload.fromThreadId,
    fromRunId: payload.fromRunId ?? null,
    toAgentKey: payload.toAgentKey,
    toSessionId: payload.toSessionId,
    sentAt: payload.sentAt,
    items: payload.items.map((item) => serializeItem(item)),
  };
  if (payload.senderEnvironment) {
    a2aMetadata.senderEnvironment = serializeSenderEnvironment(payload.senderEnvironment);
  }

  return {
    metadata: {
      a2a: a2aMetadata,
    },
  };
}

export function buildA2AInboundText(payload: A2AMessageRequestPayload): string {
  return renderA2AInboundText({
    connectorKey: payload.connectorKey,
    conversationId: payload.fromSessionId,
    actorId: payload.fromAgentKey,
    messageId: payload.externalMessageId,
    sentAt: new Date(payload.sentAt).toISOString(),
    fromAgentKey: payload.fromAgentKey,
    fromSessionId: payload.fromSessionId,
    senderEnvironment: payload.senderEnvironment,
    attachments: attachmentDescriptions(payload.items),
    body: renderA2AInboundFallbackBody({
      textBlocks: textBlocks(payload.items),
    }),
  });
}
