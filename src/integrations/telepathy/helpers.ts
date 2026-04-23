import type {JsonObject} from "../../kernel/agent/types.js";
import type {MediaDescriptor} from "../../domain/channels/types.js";
import {describeMediaDescriptor, serializeMediaDescriptor} from "../channels/media-shared.js";
import {renderTelepathyInboundText} from "../../prompts/channels/telepathy.js";
import {TELEPATHY_SOURCE} from "./config.js";

export interface TelepathyInboundTextOptions {
  agentKey: string;
  connectorKey: string;
  sentAt?: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  deviceId: string;
  deviceLabel?: string;
  mode: string;
  frontmostApp?: string;
  windowTitle?: string;
  trigger?: string;
  textParts: readonly string[];
  media: readonly MediaDescriptor[];
}

export interface TelepathyInboundMetadataOptions {
  agentKey: string;
  connectorKey: string;
  sentAt?: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  deviceId: string;
  deviceLabel?: string;
  mode: string;
  frontmostApp?: string;
  windowTitle?: string;
  trigger?: string;
  media: readonly MediaDescriptor[];
}

export function buildTelepathyInboundText(options: TelepathyInboundTextOptions): string {
  const body = [
    options.textParts.join("\n\n").trim(),
    "This context came from Panda Telepathy.",
    "Use whisper on audio attachment paths if you need the spoken words.",
    "Use view_media on image attachment paths if you need to inspect the screen.",
  ]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");

  return renderTelepathyInboundText({
    connectorKey: options.connectorKey,
    sentAt: options.sentAt,
    conversationId: options.externalConversationId,
    actorId: options.externalActorId,
    externalMessageId: options.externalMessageId,
    agentKey: options.agentKey,
    deviceId: options.deviceId,
    deviceLabel: options.deviceLabel,
    mode: options.mode,
    frontmostApp: options.frontmostApp,
    windowTitle: options.windowTitle,
    trigger: options.trigger,
    attachments: options.media.map((descriptor) => describeMediaDescriptor(descriptor)),
    body,
  });
}

export function buildTelepathyInboundMetadata(
  options: TelepathyInboundMetadataOptions,
): JsonObject {
  return {
    telepathy: {
      source: TELEPATHY_SOURCE,
      sentAt: options.sentAt ?? null,
      agentKey: options.agentKey,
      connectorKey: options.connectorKey,
      externalConversationId: options.externalConversationId,
      externalActorId: options.externalActorId,
      externalMessageId: options.externalMessageId,
      deviceId: options.deviceId,
      label: options.deviceLabel ?? null,
      mode: options.mode,
      frontmostApp: options.frontmostApp ?? null,
      windowTitle: options.windowTitle ?? null,
      trigger: options.trigger ?? null,
      media: options.media.map((descriptor) => serializeMediaDescriptor(descriptor)),
    },
  };
}
