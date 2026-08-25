import {optionalTimestampMillis, requireTimestampMillis, toJson} from "../../../lib/postgres-values.js";
import {randomUUID} from "node:crypto";

import {isJsonObject, isJsonValue, type JsonObject, type JsonValue} from "../../../lib/json.js";
import {optionalTrimmedString, requireNonEmptyString} from "../../../lib/strings.js";
import {listenPostgresChannel, type PostgresListenSnapshot} from "../../../lib/postgres-listen.js";
import type {PgListenClient, PgPoolLike} from "../../../lib/postgres-query.js";
import {
    buildRuntimeRequestTableNames,
    buildRuntimeRequestNotificationChannel,
    type RuntimeRequestTableNames,
} from "./postgres-shared.js";
import {
    RUNTIME_REQUEST_KINDS,
    RUNTIME_REQUEST_STATUSES,
    type CreateRuntimeRequestInput,
    type RuntimeRequestKind,
    type RuntimeRequestPayloadByKind,
    type RuntimeRequestRecord,
    type RuntimeRequestStatus,
} from "./types.js";
import {deriveRuntimeRequestOrderingKey} from "./ordering-key.js";

export interface RuntimeRequestRepoOptions {
  pool: PgPoolLike<PgListenClient>;
  notificationPool?: PgPoolLike<PgListenClient>;
  claimLeaseMs?: number;
}

export const DEFAULT_RUNTIME_REQUEST_CLAIM_LEASE_MS = 300_000;

function parseKind(value: unknown): RuntimeRequestKind {
  if (typeof value !== "string" || !RUNTIME_REQUEST_KINDS.includes(value as RuntimeRequestKind)) {
    throw new Error(`Unsupported runtime request kind ${String(value)}`);
  }

  return value as RuntimeRequestKind;
}

function parseStatus(value: unknown): RuntimeRequestStatus {
  if (typeof value !== "string" || !RUNTIME_REQUEST_STATUSES.includes(value as RuntimeRequestStatus)) {
    throw new Error(`Unsupported runtime request status ${String(value)}`);
  }

  return value as RuntimeRequestStatus;
}

function parseOrderingKey(value: unknown): string {
  const orderingKey = parseRequiredString(value, "ordering key");
  if (!/^v1:[0-9a-f]{64}$/.test(orderingKey)) {
    throw new Error(`Runtime request ordering key ${orderingKey} is invalid.`);
  }
  return orderingKey;
}

function parseJsonValue(value: unknown, label: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new Error(`Runtime request ${label} must be JSON-serializable.`);
  }

  return value;
}

function parseJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`Runtime request ${label} must be a JSON object.`);
  }

  return value;
}

function parseOptionalString(value: unknown): string | undefined {
  return optionalTrimmedString(value, "Runtime request optional string field must be a string.");
}

function parseOptionalNullableString(value: unknown, label: string): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    return undefined;
  }

  return requireNonEmptyString(value, `Runtime request ${label} must not be empty.`);
}

function parseRequiredString(value: unknown, label: string): string {
  return requireNonEmptyString(value, `Runtime request ${label} must not be empty.`);
}

function parseOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return parseRequiredNumber(value, label);
}

function parseOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Runtime request ${label} must be a boolean.`);
  }

  return value;
}

function parseOptionalJsonObject(value: unknown, label: string): JsonObject | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return parseJsonObject(value, label);
}

function parseRequiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Runtime request ${label} must be a finite number.`);
  }

  return value;
}

function parseOptionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Runtime request ${label} must be an array.`);
  }

  return value.map((entry) => parseRequiredString(entry, `${label} entry`));
}

function parseMediaDescriptor(value: unknown, label: string): RuntimeRequestPayloadByKind["telegram_message"]["media"][number] {
  const record = parseJsonObject(value, label);
  const descriptor = {
    id: parseRequiredString(record.id, `${label} id`),
    source: parseRequiredString(record.source, `${label} source`),
    connectorKey: parseRequiredString(record.connectorKey, `${label} connector key`),
    mimeType: parseRequiredString(record.mimeType, `${label} MIME type`),
    sizeBytes: parseRequiredNumber(record.sizeBytes, `${label} size`),
    localPath: parseRequiredString(record.localPath, `${label} local path`),
    originalFilename: parseOptionalString(record.originalFilename),
    metadata: record.metadata === undefined ? undefined : parseJsonValue(record.metadata, `${label} metadata`),
    createdAt: parseRequiredNumber(record.createdAt, `${label} created timestamp`),
  };
  if (descriptor.sizeBytes < 0) {
    throw new Error(`Runtime request ${label} size must not be negative.`);
  }

  return descriptor;
}

function parseMediaArray(value: unknown, label: string): readonly RuntimeRequestPayloadByKind["telegram_message"]["media"][number][] {
  if (!Array.isArray(value)) {
    throw new Error(`Runtime request ${label} must be an array.`);
  }

  return value.map((entry, index) => parseMediaDescriptor(entry, `${label} ${index + 1}`));
}

function parseOptionalMediaArray(
  value: unknown,
  label: string,
): readonly RuntimeRequestPayloadByKind["telegram_message"]["media"][number][] {
  if (value === undefined || value === null) {
    return [];
  }

  return parseMediaArray(value, label);
}

function mediaHasDiscordAttachmentId(
  media: readonly RuntimeRequestPayloadByKind["discord_message"]["media"][number][],
  attachmentId: string,
): boolean {
  return media.some((descriptor) => {
    const metadata = descriptor.metadata;
    return typeof metadata === "object"
      && metadata !== null
      && !Array.isArray(metadata)
      && (metadata as Record<string, unknown>).discordAttachmentId === attachmentId;
  });
}

function parseDiscordAttachmentSummary(
  value: unknown,
  label: string,
  media: readonly RuntimeRequestPayloadByKind["discord_message"]["media"][number][],
): RuntimeRequestPayloadByKind["discord_message"]["attachmentSummaries"][number] {
  const record = parseJsonObject(value, label);
  const sizeBytes = Object.hasOwn(record, "sizeBytes")
    ? parseRequiredNumber(record.sizeBytes, `${label} size`)
    : undefined;
  if (sizeBytes !== undefined && sizeBytes < 0) {
    throw new Error(`Runtime request ${label} size must not be negative.`);
  }

  const id = parseRequiredString(record.id, `${label} id`);
  const reason = parseDiscordMediaReason(record.reason, `${label} reason`);
  const httpStatus = Object.hasOwn(record, "httpStatus") && record.httpStatus !== null
    ? parseRequiredNumber(record.httpStatus, `${label} HTTP status`)
    : undefined;
  if (httpStatus !== undefined && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) {
    throw new Error(`Runtime request ${label} HTTP status is invalid.`);
  }
  const summary = {
    id,
    filename: parseOptionalString(record.filename),
    contentType: parseOptionalString(record.contentType),
    sizeBytes,
    status: record.status === undefined || record.status === null
      ? mediaHasDiscordAttachmentId(media, id) ? "downloaded" as const : "metadata_only" as const
      : parseDiscordMediaStatus(record.status, `${label} status`),
    reason,
    httpStatus,
  };

  return {
    id: summary.id,
    ...(summary.filename !== undefined ? {filename: summary.filename} : {}),
    ...(summary.contentType !== undefined ? {contentType: summary.contentType} : {}),
    ...(summary.sizeBytes !== undefined ? {sizeBytes: summary.sizeBytes} : {}),
    status: summary.status,
    ...(summary.reason !== undefined ? {reason: summary.reason} : {}),
    ...(summary.httpStatus !== undefined ? {httpStatus: summary.httpStatus} : {}),
  };
}

function parseDiscordAttachmentSummaries(
  value: unknown,
  label: string,
  media: readonly RuntimeRequestPayloadByKind["discord_message"]["media"][number][],
): RuntimeRequestPayloadByKind["discord_message"]["attachmentSummaries"] {
  if (!Array.isArray(value)) {
    throw new Error(`Runtime request ${label} must be an array.`);
  }

  return value.map((entry, index) => parseDiscordAttachmentSummary(entry, `${label} ${index + 1}`, media));
}

function parseDiscordMediaStatus(
  value: unknown,
  label: string,
): RuntimeRequestPayloadByKind["discord_message"]["embedSummaries"][number]["media"][number]["status"] {
  if (value === "downloaded" || value === "metadata_only" || value === "unsupported" || value === "failed") {
    return value;
  }
  throw new Error(`Runtime request ${label} is invalid.`);
}

function parseDiscordMediaReason(
  value: unknown,
  label: string,
): RuntimeRequestPayloadByKind["discord_message"]["embedSummaries"][number]["media"][number]["reason"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    value === "no_trusted_media"
    || value === "untrusted_url"
    || value === "unsupported_format"
    || value === "invalid_content_type"
    || value === "invalid_signature"
    || value === "too_large"
    || value === "timeout"
    || value === "http_error"
    || value === "download_failed"
    || value === "storage_failed"
  ) {
    return value;
  }
  throw new Error(`Runtime request ${label} is invalid.`);
}

function parseDiscordEmbedMediaSummary(
  value: unknown,
  label: string,
): RuntimeRequestPayloadByKind["discord_message"]["embedSummaries"][number]["media"][number] {
  const record = parseJsonObject(value, label);
  const kind = parseRequiredString(record.kind, `${label} kind`);
  if (kind !== "image" && kind !== "thumbnail" && kind !== "video") {
    throw new Error(`Runtime request ${label} kind is invalid.`);
  }
  const width = parseOptionalNumber(record.width, `${label} width`);
  const height = parseOptionalNumber(record.height, `${label} height`);
  if ((width !== undefined && width < 0) || (height !== undefined && height < 0)) {
    throw new Error(`Runtime request ${label} dimensions must not be negative.`);
  }
  const reason = parseDiscordMediaReason(record.reason, `${label} reason`);
  return {
    kind,
    ...(parseOptionalString(record.contentType) !== undefined
      ? {contentType: parseOptionalString(record.contentType)}
      : {}),
    ...(width !== undefined ? {width} : {}),
    ...(height !== undefined ? {height} : {}),
    status: parseDiscordMediaStatus(record.status, `${label} status`),
    ...(reason !== undefined ? {reason} : {}),
  };
}

function parseDiscordEmbedSummaries(
  value: unknown,
  label: string,
): RuntimeRequestPayloadByKind["discord_message"]["embedSummaries"] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Runtime request ${label} must be an array.`);
  }
  return value.slice(0, 10).map((entry, index) => {
    const entryLabel = `${label} ${index + 1}`;
    const record = parseJsonObject(entry, entryLabel);
    if (!Array.isArray(record.media)) {
      throw new Error(`Runtime request ${entryLabel} media must be an array.`);
    }
    return {
      type: parseRequiredString(record.type, `${entryLabel} type`),
      title: parseOptionalString(record.title),
      description: parseOptionalString(record.description),
      providerName: parseOptionalString(record.providerName),
      media: record.media.slice(0, 1).map((media, mediaIndex) => parseDiscordEmbedMediaSummary(
        media,
        `${entryLabel} media ${mediaIndex + 1}`,
      )),
    };
  });
}

function parseDiscordStickerSummaries(
  value: unknown,
  label: string,
): RuntimeRequestPayloadByKind["discord_message"]["stickerSummaries"] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Runtime request ${label} must be an array.`);
  }
  return value.slice(0, 3).map((entry, index) => {
    const entryLabel = `${label} ${index + 1}`;
    const record = parseJsonObject(entry, entryLabel);
    const format = parseRequiredString(record.format, `${entryLabel} format`);
    if (format !== "png" && format !== "apng" && format !== "lottie" && format !== "gif" && format !== "unknown") {
      throw new Error(`Runtime request ${entryLabel} format is invalid.`);
    }
    const reason = parseDiscordMediaReason(record.reason, `${entryLabel} reason`);
    return {
      id: parseRequiredString(record.id, `${entryLabel} id`),
      name: parseRequiredString(record.name, `${entryLabel} name`),
      format,
      status: parseDiscordMediaStatus(record.status, `${entryLabel} status`),
      ...(reason !== undefined ? {reason} : {}),
    };
  });
}

function parsePathHints(value: unknown, label: string) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const record = parseJsonObject(value, label);
  return {
    root: parseOptionalString(record.root),
    workspace: parseOptionalString(record.workspace),
    inbox: parseOptionalString(record.inbox),
    artifacts: parseOptionalString(record.artifacts),
  };
}

function parseSenderEnvironment(value: unknown): RuntimeRequestPayloadByKind["a2a_message"]["senderEnvironment"] {
  if (value === undefined || value === null) {
    return undefined;
  }

  const record = parseJsonObject(value, "sender environment");
  const kind = parseRequiredString(record.kind, "sender environment kind");
  if (kind !== "persistent_agent_runner" && kind !== "disposable_container" && kind !== "local") {
    throw new Error(`Unsupported runtime request sender environment kind ${kind}`);
  }

  return {
    id: parseRequiredString(record.id, "sender environment id"),
    kind,
    envDir: parseOptionalString(record.envDir),
    parentRunnerPaths: parsePathHints(record.parentRunnerPaths, "sender parent runner paths"),
    workerPaths: parsePathHints(record.workerPaths, "sender worker paths"),
  };
}

function parseA2AItem(value: unknown, label: string): RuntimeRequestPayloadByKind["a2a_message"]["items"][number] {
  const record = parseJsonObject(value, label);
  const type = parseRequiredString(record.type, `${label} type`);
  if (type === "text") {
    return {
      type,
      text: parseRequiredString(record.text, `${label} text`),
    };
  }

  if (type === "image") {
    return {
      type,
      media: parseMediaDescriptor(record.media, `${label} media`),
      caption: parseOptionalString(record.caption),
    };
  }

  if (type === "file") {
    return {
      type,
      media: parseMediaDescriptor(record.media, `${label} media`),
      filename: parseOptionalString(record.filename),
      caption: parseOptionalString(record.caption),
      mimeType: parseOptionalString(record.mimeType),
    };
  }

  throw new Error(`Unsupported runtime request ${label} type ${type}`);
}

function parseA2AItems(value: unknown): RuntimeRequestPayloadByKind["a2a_message"]["items"] {
  if (!Array.isArray(value)) {
    throw new Error("Runtime request A2A items must be an array.");
  }

  return value.map((entry, index) => parseA2AItem(entry, `A2A item ${index + 1}`));
}

function parseInferenceProjection(value: unknown, label: string): RuntimeRequestPayloadByKind["create_branch_session"]["inferenceProjection"] {
  if (value === undefined || value === null) {
    return undefined;
  }

  return parseJsonObject(value, label) as RuntimeRequestPayloadByKind["create_branch_session"]["inferenceProjection"];
}

function parseThinking(value: unknown): RuntimeRequestPayloadByKind["create_branch_session"]["thinking"] {
  return value === undefined || value === null
    ? undefined
    : parseRequiredString(value, "thinking level") as RuntimeRequestPayloadByKind["create_branch_session"]["thinking"];
}

function parseSubagentExecution(value: unknown): RuntimeRequestPayloadByKind["create_subagent_session"]["execution"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "agent_workspace" || value === "isolated_environment") {
    return value;
  }
  throw new Error(`Unsupported subagent execution ${String(value)}.`);
}

function parseThreadUpdate(value: unknown): RuntimeRequestPayloadByKind["update_thread"]["update"] {
  return parseJsonObject(value, "thread update") as RuntimeRequestPayloadByKind["update_thread"]["update"];
}

function parseWhatsAppAuthorizationSnapshot(
  value: unknown,
): NonNullable<RuntimeRequestPayloadByKind["whatsapp_message"]["authorization"]> {
  const snapshot = parseJsonObject(value, "WhatsApp authorization snapshot");
  return {
    identityId: parseRequiredString(snapshot.identityId, "WhatsApp authorization identity id"),
    agentKey: parseRequiredString(snapshot.agentKey, "WhatsApp authorization agent key"),
    actorBindingId: parseRequiredString(snapshot.actorBindingId, "WhatsApp authorization actor binding id"),
    authorizationVersion: parseRequiredString(
      snapshot.authorizationVersion,
      "WhatsApp authorization version",
    ),
  };
}

function parsePayload<K extends RuntimeRequestKind>(
  kind: K,
  value: unknown,
): RuntimeRequestPayloadByKind[K] {
  const payload = parseJsonObject(value, `${kind} payload`);
  const identityId = parseOptionalString(payload.identityId);

  switch (kind) {
    case "a2a_message":
      return {
        identityId,
        connectorKey: parseRequiredString(payload.connectorKey, "A2A connector key"),
        externalMessageId: parseRequiredString(payload.externalMessageId, "A2A external message id"),
        fromAgentKey: parseRequiredString(payload.fromAgentKey, "A2A source agent key"),
        fromSessionId: parseRequiredString(payload.fromSessionId, "A2A source session id"),
        fromThreadId: parseRequiredString(payload.fromThreadId, "A2A source thread id"),
        fromRunId: parseOptionalString(payload.fromRunId),
        toAgentKey: parseRequiredString(payload.toAgentKey, "A2A target agent key"),
        toSessionId: parseRequiredString(payload.toSessionId, "A2A target session id"),
        sentAt: parseRequiredNumber(payload.sentAt, "A2A sent timestamp"),
        senderEnvironment: parseSenderEnvironment(payload.senderEnvironment),
        items: parseA2AItems(payload.items),
      } as RuntimeRequestPayloadByKind[K];

    case "telegram_message":
      return {
        identityId,
        connectorKey: parseRequiredString(payload.connectorKey, "Telegram connector key"),
        botUsername: parseOptionalNullableString(payload.botUsername, "Telegram bot username"),
        sentAt: parseOptionalNumber(payload.sentAt, "Telegram sent timestamp"),
        externalConversationId: parseRequiredString(payload.externalConversationId, "Telegram conversation id"),
        chatId: parseRequiredString(payload.chatId, "Telegram chat id"),
        chatType: parseRequiredString(payload.chatType, "Telegram chat type"),
        externalActorId: parseRequiredString(payload.externalActorId, "Telegram actor id"),
        externalMessageId: parseRequiredString(payload.externalMessageId, "Telegram message id"),
        text: parseOptionalString(payload.text),
        username: parseOptionalString(payload.username),
        firstName: parseOptionalString(payload.firstName),
        lastName: parseOptionalString(payload.lastName),
        replyToMessageId: parseOptionalString(payload.replyToMessageId),
        media: parseMediaArray(payload.media, "Telegram media"),
      } as RuntimeRequestPayloadByKind[K];

    case "telegram_reaction":
      return {
        identityId,
        connectorKey: parseRequiredString(payload.connectorKey, "Telegram reaction connector key"),
        externalConversationId: parseRequiredString(payload.externalConversationId, "Telegram reaction conversation id"),
        chatId: parseRequiredString(payload.chatId, "Telegram reaction chat id"),
        chatType: parseRequiredString(payload.chatType, "Telegram reaction chat type"),
        externalActorId: parseRequiredString(payload.externalActorId, "Telegram reaction actor id"),
        updateId: parseRequiredNumber(payload.updateId, "Telegram reaction update id"),
        targetMessageId: parseRequiredString(payload.targetMessageId, "Telegram reaction target message id"),
        addedEmojis: parseOptionalStringArray(payload.addedEmojis, "Telegram reaction emojis") ?? [],
        username: parseOptionalString(payload.username),
        firstName: parseOptionalString(payload.firstName),
        lastName: parseOptionalString(payload.lastName),
      } as RuntimeRequestPayloadByKind[K];

    case "whatsapp_message":
      return {
        identityId,
        authorization: payload.authorization === undefined || payload.authorization === null
          ? undefined
          : parseWhatsAppAuthorizationSnapshot(payload.authorization),
        connectorKey: parseRequiredString(payload.connectorKey, "WhatsApp connector key"),
        sentAt: parseOptionalNumber(payload.sentAt, "WhatsApp sent timestamp"),
        externalConversationId: parseRequiredString(payload.externalConversationId, "WhatsApp conversation id"),
        externalActorId: parseRequiredString(payload.externalActorId, "WhatsApp actor id"),
        externalMessageId: parseRequiredString(payload.externalMessageId, "WhatsApp message id"),
        remoteJid: parseRequiredString(payload.remoteJid, "WhatsApp remote JID"),
        chatType: parseRequiredString(payload.chatType, "WhatsApp chat type"),
        text: parseOptionalString(payload.text),
        pushName: parseOptionalString(payload.pushName),
        quotedMessageId: parseOptionalString(payload.quotedMessageId),
        media: parseMediaArray(payload.media, "WhatsApp media"),
      } as RuntimeRequestPayloadByKind[K];

    case "whatsapp_reaction":
      return {
        identityId,
        authorization: payload.authorization === undefined || payload.authorization === null
          ? undefined
          : parseWhatsAppAuthorizationSnapshot(payload.authorization),
        connectorKey: parseRequiredString(payload.connectorKey, "WhatsApp reaction connector key"),
        sentAt: parseOptionalNumber(payload.sentAt, "WhatsApp reaction sent timestamp"),
        externalConversationId: parseRequiredString(payload.externalConversationId, "WhatsApp reaction conversation id"),
        externalActorId: parseRequiredString(payload.externalActorId, "WhatsApp reaction actor id"),
        externalMessageId: parseRequiredString(payload.externalMessageId, "WhatsApp reaction message id"),
        remoteJid: parseRequiredString(payload.remoteJid, "WhatsApp reaction remote JID"),
        chatType: parseRequiredString(payload.chatType, "WhatsApp reaction chat type"),
        targetMessageId: parseRequiredString(payload.targetMessageId, "WhatsApp reaction target message id"),
        emoji: parseRequiredString(payload.emoji, "WhatsApp reaction emoji"),
        pushName: parseOptionalString(payload.pushName),
      } as RuntimeRequestPayloadByKind[K];

    case "discord_message": {
      const media = parseOptionalMediaArray(payload.media, "Discord media");
      return {
        identityId,
        connectorKey: parseRequiredString(payload.connectorKey, "Discord connector key"),
        sentAt: parseOptionalNumber(payload.sentAt, "Discord sent timestamp"),
        externalConversationId: parseRequiredString(payload.externalConversationId, "Discord conversation id"),
        externalActorId: parseRequiredString(payload.externalActorId, "Discord actor id"),
        externalMessageId: parseRequiredString(payload.externalMessageId, "Discord message id"),
        actualChannelId: parseRequiredString(payload.actualChannelId, "Discord actual channel id"),
        attachmentSummaries: parseDiscordAttachmentSummaries(payload.attachmentSummaries, "Discord attachment summaries", media),
        embedSummaries: parseDiscordEmbedSummaries(payload.embedSummaries, "Discord embed summaries"),
        stickerSummaries: parseDiscordStickerSummaries(payload.stickerSummaries, "Discord sticker summaries"),
        media,
        guildId: parseOptionalString(payload.guildId),
        threadId: parseOptionalString(payload.threadId),
        parentChannelId: parseOptionalString(payload.parentChannelId),
        text: parseOptionalString(payload.text),
        authorUsername: parseOptionalString(payload.authorUsername),
        authorGlobalName: parseOptionalString(payload.authorGlobalName),
        authorDisplayName: parseOptionalString(payload.authorDisplayName),
        authorIsBot: parseOptionalBoolean(payload.authorIsBot, "Discord author is bot"),
        replyToMessageId: parseOptionalString(payload.replyToMessageId),
        deliveryContext: parseOptionalJsonObject(payload.deliveryContext, "Discord delivery context"),
      } as RuntimeRequestPayloadByKind[K];
    }

    case "live_voice_delegation":
      return {
        identityId,
        liveVoiceTurnId: parseRequiredString(payload.liveVoiceTurnId, "Live voice turn id"),
        sessionId: parseRequiredString(payload.sessionId, "Live voice session target id"),
      } as RuntimeRequestPayloadByKind[K];

    case "tui_input":
      return {
        identityId,
        threadId: parseOptionalString(payload.threadId),
        actorId: parseRequiredString(payload.actorId, "TUI actor id"),
        externalMessageId: parseRequiredString(payload.externalMessageId, "TUI external message id"),
        identityHandle: parseOptionalString(payload.identityHandle),
        sentAt: parseOptionalNumber(payload.sentAt, "TUI sent timestamp"),
        text: parseRequiredString(payload.text, "TUI text"),
      } as RuntimeRequestPayloadByKind[K];

    case "create_branch_session":
      return {
        identityId,
        sessionId: parseRequiredString(payload.sessionId, "branch session id"),
        threadId: parseRequiredString(payload.threadId, "branch thread id"),
        agentKey: parseOptionalString(payload.agentKey),
        model: parseOptionalString(payload.model),
        thinking: parseThinking(payload.thinking),
        inferenceProjection: parseInferenceProjection(payload.inferenceProjection, "branch session inference projection"),
      } as RuntimeRequestPayloadByKind[K];

    case "create_subagent_session":
      return {
        identityId,
        sessionId: parseRequiredString(payload.sessionId, "subagent session id"),
        threadId: parseRequiredString(payload.threadId, "subagent thread id"),
        agentKey: parseOptionalString(payload.agentKey),
        parentSessionId: parseRequiredString(payload.parentSessionId, "subagent parent session id"),
        prompt: parseRequiredString(payload.prompt, "subagent prompt"),
        context: parseOptionalString(payload.context),
        profile: parseOptionalString(payload.profile),
        execution: parseSubagentExecution(payload.execution),
        environmentId: parseOptionalString(payload.environmentId),
        credentialAllowlist: parseOptionalStringArray(payload.credentialAllowlist, "credential allowlist"),
        credentialRefAllowlist: parseOptionalStringArray(payload.credentialRefAllowlist, "credential ref allowlist"),
        toolGroups: parseOptionalStringArray(payload.toolGroups, "subagent tool groups"),
        model: parseOptionalString(payload.model),
        thinking: parseThinking(payload.thinking),
        inferenceProjection: parseInferenceProjection(payload.inferenceProjection, "subagent session inference projection"),
      } as RuntimeRequestPayloadByKind[K];

    case "resolve_main_session_thread":
      return {
        identityId,
        agentKey: parseOptionalString(payload.agentKey),
        model: parseOptionalString(payload.model),
        thinking: parseThinking(payload.thinking),
        inferenceProjection: parseInferenceProjection(payload.inferenceProjection, "main session inference projection"),
      } as RuntimeRequestPayloadByKind[K];

    case "resolve_thread_run_config":
      return {
        identityId,
        threadId: parseRequiredString(payload.threadId, "thread id"),
      } as RuntimeRequestPayloadByKind[K];

    case "reset_session":
      return {
        identityId,
        source: parseRequiredString(payload.source, "reset source"),
        sessionId: parseOptionalString(payload.sessionId),
        threadId: parseOptionalString(payload.threadId),
        connectorKey: parseOptionalString(payload.connectorKey),
        externalConversationId: parseOptionalString(payload.externalConversationId),
        externalActorId: parseOptionalString(payload.externalActorId),
        externalMessageId: parseOptionalString(payload.externalMessageId),
        agentKey: parseOptionalString(payload.agentKey),
        model: parseOptionalString(payload.model),
        thinking: parseThinking(payload.thinking),
        inferenceProjection: parseInferenceProjection(payload.inferenceProjection, "reset inference projection"),
      } as RuntimeRequestPayloadByKind[K];

    case "abort_thread":
      return {
        identityId,
        threadId: parseRequiredString(payload.threadId, "thread id"),
        reason: parseOptionalString(payload.reason),
      } as RuntimeRequestPayloadByKind[K];

    case "compact_thread":
      return {
        identityId,
        threadId: parseRequiredString(payload.threadId, "thread id"),
        customInstructions: parseOptionalString(payload.customInstructions) ?? "",
      } as RuntimeRequestPayloadByKind[K];

    case "compact_session":
      return {
        identityId,
        sessionId: parseRequiredString(payload.sessionId, "session id"),
        customInstructions: parseOptionalString(payload.customInstructions) ?? "",
      } as RuntimeRequestPayloadByKind[K];

    case "archive_session":
    case "restore_session":
      return {
        identityId,
        sessionId: parseRequiredString(payload.sessionId, "session id"),
      } as RuntimeRequestPayloadByKind[K];

    case "update_thread":
      return {
        identityId,
        threadId: parseRequiredString(payload.threadId, "thread id"),
        update: parseThreadUpdate(payload.update),
      } as RuntimeRequestPayloadByKind[K];
  }
}

function serializePayload<K extends RuntimeRequestKind>(
  input: CreateRuntimeRequestInput<K>,
): {kind: K; payload: RuntimeRequestPayloadByKind[K]; serialized: string} {
  if (input.kind === "discord_message") {
    const deliveryContext = (input.payload as Record<string, unknown>).deliveryContext;
    parseOptionalJsonObject(deliveryContext, "Discord delivery context");
  }

  const serialized = JSON.stringify(input.payload);
  const parsed = JSON.parse(serialized) as unknown;
  const payload = parsePayload(input.kind, parsed);

  return {
    kind: input.kind,
    payload,
    serialized: JSON.stringify(payload),
  };
}

function buildClaimNextPendingRequestQuery(tableName: string): string {
  return `
    WITH candidate AS MATERIALIZED (
      SELECT request.id
      FROM ${tableName} AS request
      WHERE (
        request.status = 'pending'
        OR (
          request.status = 'running'
          AND request.claim_expires_at <= NOW()
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${tableName} AS predecessor
        WHERE predecessor.ordering_key = request.ordering_key
          AND predecessor.status IN ('pending', 'running')
          AND (predecessor.created_at, predecessor.id) < (request.created_at, request.id)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${tableName} AS owner
        WHERE owner.ordering_key = request.ordering_key
          AND owner.status = 'running'
          AND owner.id <> request.id
      )
      ORDER BY request.created_at, request.id
      LIMIT 1
      FOR UPDATE OF request SKIP LOCKED
    )
    UPDATE ${tableName} AS request
    SET status = 'running',
        execution_attempts = request.execution_attempts + 1,
        claimed_at = NOW(),
        claim_token = $1,
        claim_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
        error = NULL,
        updated_at = NOW()
    FROM candidate
    WHERE request.id = candidate.id
    RETURNING request.*
  `;
}

function parseRecord<K extends RuntimeRequestKind = RuntimeRequestKind>(
  row: Record<string, unknown>,
): RuntimeRequestRecord<K> {
  const kind = parseKind(row.kind) as K;
  return {
    id: parseRequiredString(row.id, "id"),
    kind,
    status: parseStatus(row.status),
    executionAttempts: (() => {
      const value = Number(row.execution_attempts);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Runtime request execution_attempts must be a non-negative safe integer.");
      }
      return value;
    })(),
    payload: parsePayload(kind, row.payload),
    orderingKey: parseOrderingKey(row.ordering_key),
    result: row.result === null ? undefined : parseJsonValue(row.result, "result"),
    error: typeof row.error === "string" ? row.error : undefined,
    claimedAt: optionalTimestampMillis(row.claimed_at, "Runtime request claimed_at must be a valid timestamp."),
    claimToken: parseOptionalString(row.claim_token),
    claimExpiresAt: optionalTimestampMillis(
      row.claim_expires_at,
      "Runtime request claim_expires_at must be a valid timestamp.",
    ),
    createdAt: requireTimestampMillis(row.created_at, "Runtime request created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Runtime request updated_at must be a valid timestamp."),
    finishedAt: optionalTimestampMillis(row.finished_at, "Runtime request finished_at must be a valid timestamp."),
  };
}

function requireTrimmedRequestId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("Runtime request id must not be empty.");
  }

  return trimmed;
}

export class RuntimeRequestRepo {
  private readonly pool: PgPoolLike<PgListenClient>;
  private readonly notificationPool: PgPoolLike<PgListenClient>;
  private readonly claimLeaseMs: number;
  private readonly tables: RuntimeRequestTableNames;
  private readonly notificationChannel: string;

  constructor(options: RuntimeRequestRepoOptions) {
    this.pool = options.pool;
    this.notificationPool = options.notificationPool ?? options.pool;
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_RUNTIME_REQUEST_CLAIM_LEASE_MS;
    if (!Number.isSafeInteger(this.claimLeaseMs) || this.claimLeaseMs <= 0) {
      throw new Error("Runtime request claim lease must be a positive integer.");
    }
    this.tables = buildRuntimeRequestTableNames();
    this.notificationChannel = buildRuntimeRequestNotificationChannel();
  }

  async getRequestByIdempotencyKey<K extends RuntimeRequestKind>(
    idempotencyKey: string,
    kind: K,
  ): Promise<RuntimeRequestRecord<K> | null> {
    const key = requireNonEmptyString(idempotencyKey, "Runtime request idempotency key must not be empty.");
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.runtimeRequests}
      WHERE idempotency_key = $1
        AND kind = $2
    `, [key, kind]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseRecord<K>(row) : null;
  }

  async getRequestStatusesByIdempotencyEntries(entries: readonly {
    idempotencyKey: string;
    kind: RuntimeRequestKind;
  }[]): Promise<readonly (RuntimeRequestStatus | undefined)[]> {
    if (entries.length === 0) return [];
    const normalized = entries.map((entry) => ({
      idempotencyKey: requireNonEmptyString(
        entry.idempotencyKey,
        "Runtime request idempotency key must not be empty.",
      ),
      kind: parseKind(entry.kind),
    }));
    const result = await this.pool.query(`
      SELECT request.idempotency_key, request.kind, request.status
      FROM ${this.tables.runtimeRequests} AS request
      INNER JOIN UNNEST($1::text[], $2::text[]) AS owner(idempotency_key, kind)
        ON owner.idempotency_key = request.idempotency_key
       AND owner.kind = request.kind
    `, [
      normalized.map((entry) => entry.idempotencyKey),
      normalized.map((entry) => entry.kind),
    ]);
    const statuses = new Map<string, RuntimeRequestStatus>();
    for (const row of result.rows) {
      const record = row as {idempotency_key?: unknown; kind?: unknown; status?: unknown};
      if (
        typeof record.idempotency_key === "string"
        && typeof record.kind === "string"
        && RUNTIME_REQUEST_STATUSES.includes(record.status as RuntimeRequestStatus)
      ) {
        statuses.set(`${record.kind}\u0000${record.idempotency_key}`, record.status as RuntimeRequestStatus);
      }
    }
    return normalized.map((entry) => statuses.get(`${entry.kind}\u0000${entry.idempotencyKey}`));
  }

  async enqueueRequest<K extends RuntimeRequestKind>(
    input: CreateRuntimeRequestInput<K>,
    options: {idempotencyKey?: string} = {},
  ): Promise<RuntimeRequestRecord<K>> {
    const {kind, payload, serialized} = serializePayload(input);
    const orderingKey = deriveRuntimeRequestOrderingKey({kind, payload});
    const idempotencyKey = options.idempotencyKey?.trim() || null;
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.runtimeRequests} (
        id,
        kind,
        status,
        payload,
        ordering_key,
        idempotency_key
      ) VALUES (
        $1,
        $2,
        'pending',
        $3::jsonb,
        $4,
        $5
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *, pg_notify($6, 'pending') AS notification
    `, [
      randomUUID(),
      kind,
      serialized,
      orderingKey,
      idempotencyKey,
      this.notificationChannel,
    ]);

    const inserted = result.rows[0] as Record<string, unknown> | undefined;
    if (inserted) {
      return parseRecord<K>(inserted);
    }

    if (!idempotencyKey) {
      throw new Error("Runtime request insert returned no row without an idempotency conflict.");
    }

    const existing = await this.pool.query(`
      SELECT *
      FROM ${this.tables.runtimeRequests}
      WHERE idempotency_key = $1
        AND kind = $2
        AND payload = $3::jsonb
    `, [idempotencyKey, kind, serialized]);
    const existingRow = existing.rows[0] as Record<string, unknown> | undefined;
    if (!existingRow) {
      throw new Error(
        `Runtime request idempotency key ${idempotencyKey} is already bound to a different request.`,
      );
    }
    return parseRecord<K>(existingRow);
  }

  async claimNextPendingRequest(): Promise<RuntimeRequestRecord | null> {
    const claimToken = randomUUID();
    const claimed = await this.pool.query(
      buildClaimNextPendingRequestQuery(this.tables.runtimeRequests),
      [claimToken, this.claimLeaseMs],
    );

    const row = claimed.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    try {
      return parseRecord(row);
    } catch (error) {
      const requestId = typeof row.id === "string" ? row.id : null;
      if (requestId) {
        await this.pool.query(`
          UPDATE ${this.tables.runtimeRequests}
          SET status = 'failed',
              error = $2,
              finished_at = NOW(),
              claim_token = NULL,
              claim_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1 AND claim_token = $3
          RETURNING pg_notify($4, 'settled') AS notification
        `, [
          requestId,
          `Persisted runtime request is invalid: ${error instanceof Error ? error.message : String(error)}`,
          claimToken,
          this.notificationChannel,
        ]);
      }
      throw error;
    }
  }

  async renewRequestClaim(id: string, claimToken: string): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.runtimeRequests}
      SET claim_expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
          updated_at = NOW()
      WHERE id = $1
        AND claim_token = $2
        AND status = 'running'
        AND claim_expires_at > NOW()
      RETURNING id
    `, [
      requireTrimmedRequestId(id),
      requireNonEmptyString(claimToken, "Runtime request claim token must not be empty."),
      this.claimLeaseMs,
    ]);
    return result.rows.length > 0;
  }

  /** Keeps ambiguous idempotent work replayable behind a short durable lease. */
  async deferRequestClaim(
    id: string,
    claimToken: string,
    error: string,
    retryAfterMs: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0) {
      throw new Error("Runtime request retry delay must be a positive integer.");
    }
    const result = await this.pool.query(`
      UPDATE ${this.tables.runtimeRequests}
      SET error = $3,
          claim_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
          updated_at = NOW()
      WHERE id = $1
        AND claim_token = $2
        AND status = 'running'
        AND claim_expires_at > NOW()
      RETURNING id
    `, [
      requireTrimmedRequestId(id),
      requireNonEmptyString(claimToken, "Runtime request claim token must not be empty."),
      error,
      retryAfterMs,
    ]);
    return result.rows.length > 0;
  }

  /** Returns unfinished work to the durable queue during cooperative shutdown. */
  async releaseRequestClaim(id: string, claimToken: string): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.runtimeRequests}
      SET status = 'pending',
          claimed_at = NULL,
          claim_token = NULL,
          claim_expires_at = NULL,
          updated_at = NOW()
      WHERE id = $1
        AND claim_token = $2
        AND status = 'running'
      RETURNING id, pg_notify($3, 'pending') AS notification
    `, [
      requireTrimmedRequestId(id),
      requireNonEmptyString(claimToken, "Runtime request claim token must not be empty."),
      this.notificationChannel,
    ]);
    return result.rows.length > 0;
  }

  async pruneSettledRequests(input: {
    completedBefore: Date;
    failedBefore: Date;
    limit?: number;
  }): Promise<number> {
    const requestedLimit = input.limit ?? 500;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
      throw new Error("Runtime request prune limit must be a positive integer.");
    }
    const limit = Math.min(requestedLimit, 5_000);
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.runtimeRequests}
      WHERE id IN (
        SELECT id
        FROM ${this.tables.runtimeRequests}
        WHERE (status = 'completed' AND finished_at < $1)
           OR (status = 'failed' AND finished_at < $2)
        ORDER BY finished_at ASC, id ASC
        LIMIT $3
      )
      RETURNING id
    `, [input.completedBefore, input.failedBefore, limit]);
    return result.rowCount ?? result.rows.length;
  }

  async completeRequest(id: string, claimToken: string, resultValue?: unknown): Promise<RuntimeRequestRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.runtimeRequests}
      SET status = 'completed',
          result = $2::jsonb,
          error = NULL,
          finished_at = NOW(),
          claim_token = NULL,
          claim_expires_at = NULL,
          updated_at = NOW()
      WHERE id = $1
        AND claim_token = $3
        AND status = 'running'
      RETURNING *, pg_notify($4, 'settled') AS notification
    `, [
      requireTrimmedRequestId(id),
      toJson(resultValue),
      requireNonEmptyString(claimToken, "Runtime request claim token must not be empty."),
      this.notificationChannel,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Runtime request ${id} claim was lost before completion.`);
    }
    return parseRecord(row);
  }

  async failRequest(id: string, claimToken: string, error: string): Promise<RuntimeRequestRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.runtimeRequests}
      SET status = 'failed',
          error = $2,
          finished_at = NOW(),
          claim_token = NULL,
          claim_expires_at = NULL,
          updated_at = NOW()
      WHERE id = $1
        AND claim_token = $3
        AND status = 'running'
      RETURNING *, pg_notify($4, 'settled') AS notification
    `, [
      requireTrimmedRequestId(id),
      error,
      requireNonEmptyString(claimToken, "Runtime request claim token must not be empty."),
      this.notificationChannel,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Runtime request ${id} claim was lost before failure settlement.`);
    }
    return parseRecord(row);
  }

  async getRequest(id: string): Promise<RuntimeRequestRecord> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.runtimeRequests}
      WHERE id = $1
    `, [requireTrimmedRequestId(id)]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown runtime request ${id}`);
    }

    return parseRecord(row as Record<string, unknown>);
  }

  async listenPendingRequests(
    listener: () => Promise<void> | void,
    options: {
      onError?: (error: unknown) => Promise<void> | void;
      onStateChange?: (snapshot: PostgresListenSnapshot) => Promise<void> | void;
    } = {},
  ): Promise<() => Promise<void>> {
    return listenPostgresChannel({
      pool: this.notificationPool,
      channel: this.notificationChannel,
      label: "Runtime request notification listener",
      parse: () => true,
      listener: async () => {
        await listener();
      },
      onError: options.onError,
      onStateChange: options.onStateChange,
    });
  }
}
