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
import {ensurePostgresRuntimeRequestSchema} from "./postgres-schema.js";
import type {
    CreateRuntimeRequestInput,
    RuntimeRequestKind,
    RuntimeRequestPayloadByKind,
    RuntimeRequestRecord,
    RuntimeRequestStatus,
} from "./types.js";

export interface RuntimeRequestRepoOptions {
  pool: PgPoolLike<PgListenClient>;
  notificationPool?: PgPoolLike<PgListenClient>;
  staleRunningRequestMs?: number;
}

export const DEFAULT_RUNTIME_REQUEST_CLAIM_TIMEOUT_MS = 300_000;

const runtimeRequestKinds = [
  "a2a_message",
  "telegram_message",
  "telegram_reaction",
  "whatsapp_message",
  "whatsapp_reaction",
  "discord_message",
  "tui_input",
  "create_branch_session",
  "create_worker_session",
  "resolve_main_session_thread",
  "resolve_thread_run_config",
  "reset_session",
  "abort_thread",
  "compact_thread",
  "update_thread",
] as const satisfies readonly RuntimeRequestKind[];

const runtimeRequestStatuses = [
  "pending",
  "running",
  "completed",
  "failed",
] as const satisfies readonly RuntimeRequestStatus[];

function parseKind(value: unknown): RuntimeRequestKind {
  if (typeof value !== "string" || !runtimeRequestKinds.includes(value as RuntimeRequestKind)) {
    throw new Error(`Unsupported runtime request kind ${String(value)}`);
  }

  return value as RuntimeRequestKind;
}

function parseStatus(value: unknown): RuntimeRequestStatus {
  if (typeof value !== "string" || !runtimeRequestStatuses.includes(value as RuntimeRequestStatus)) {
    throw new Error(`Unsupported runtime request status ${String(value)}`);
  }

  return value as RuntimeRequestStatus;
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

function parseDiscordAttachmentSummary(
  value: unknown,
  label: string,
): RuntimeRequestPayloadByKind["discord_message"]["attachmentSummaries"][number] {
  const record = parseJsonObject(value, label);
  const sizeBytes = Object.hasOwn(record, "sizeBytes")
    ? parseRequiredNumber(record.sizeBytes, `${label} size`)
    : undefined;
  if (sizeBytes !== undefined && sizeBytes < 0) {
    throw new Error(`Runtime request ${label} size must not be negative.`);
  }

  const summary = {
    id: parseRequiredString(record.id, `${label} id`),
    filename: parseOptionalString(record.filename),
    contentType: parseOptionalString(record.contentType),
    sizeBytes,
  };

  return {
    id: summary.id,
    ...(summary.filename !== undefined ? {filename: summary.filename} : {}),
    ...(summary.contentType !== undefined ? {contentType: summary.contentType} : {}),
    ...(summary.sizeBytes !== undefined ? {sizeBytes: summary.sizeBytes} : {}),
  };
}

function parseDiscordAttachmentSummaries(
  value: unknown,
  label: string,
): RuntimeRequestPayloadByKind["discord_message"]["attachmentSummaries"] {
  if (!Array.isArray(value)) {
    throw new Error(`Runtime request ${label} must be an array.`);
  }

  return value.map((entry, index) => parseDiscordAttachmentSummary(entry, `${label} ${index + 1}`));
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

function parseToolPolicy(value: unknown): RuntimeRequestPayloadByKind["create_worker_session"]["toolPolicy"] {
  if (value === undefined || value === null) {
    return undefined;
  }

  return parseJsonObject(value, "tool policy") as RuntimeRequestPayloadByKind["create_worker_session"]["toolPolicy"];
}

function parseThreadUpdate(value: unknown): RuntimeRequestPayloadByKind["update_thread"]["update"] {
  return parseJsonObject(value, "thread update") as RuntimeRequestPayloadByKind["update_thread"]["update"];
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

    case "discord_message":
      return {
        identityId,
        connectorKey: parseRequiredString(payload.connectorKey, "Discord connector key"),
        sentAt: parseOptionalNumber(payload.sentAt, "Discord sent timestamp"),
        externalConversationId: parseRequiredString(payload.externalConversationId, "Discord conversation id"),
        externalActorId: parseRequiredString(payload.externalActorId, "Discord actor id"),
        externalMessageId: parseRequiredString(payload.externalMessageId, "Discord message id"),
        actualChannelId: parseRequiredString(payload.actualChannelId, "Discord actual channel id"),
        attachmentSummaries: parseDiscordAttachmentSummaries(payload.attachmentSummaries, "Discord attachment summaries"),
        media: parseOptionalMediaArray(payload.media, "Discord media"),
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
        sessionId: parseOptionalString(payload.sessionId),
        agentKey: parseOptionalString(payload.agentKey),
        model: parseOptionalString(payload.model),
        thinking: parseThinking(payload.thinking),
        inferenceProjection: parseInferenceProjection(payload.inferenceProjection, "branch session inference projection"),
      } as RuntimeRequestPayloadByKind[K];

    case "create_worker_session":
      return {
        identityId,
        sessionId: parseOptionalString(payload.sessionId),
        threadId: parseOptionalString(payload.threadId),
        agentKey: parseOptionalString(payload.agentKey),
        role: parseOptionalString(payload.role),
        task: parseRequiredString(payload.task, "worker task"),
        context: parseOptionalString(payload.context),
        model: parseOptionalString(payload.model),
        thinking: parseThinking(payload.thinking),
        inferenceProjection: parseInferenceProjection(payload.inferenceProjection, "worker session inference projection"),
        credentialAllowlist: parseOptionalStringArray(payload.credentialAllowlist, "credential allowlist"),
        environmentId: parseOptionalString(payload.environmentId),
        skillAllowlist: parseOptionalStringArray(payload.skillAllowlist, "skill allowlist"),
        toolPolicy: parseToolPolicy(payload.toolPolicy),
        ttlMs: parseOptionalNumber(payload.ttlMs, "worker TTL"),
        parentSessionId: parseOptionalString(payload.parentSessionId),
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
        externalMessageId: parseOptionalString(payload.externalMessageId)
          ?? parseOptionalString(payload.commandExternalMessageId),
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
        customInstructions: parseRequiredString(payload.customInstructions, "compact instructions"),
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

function buildClaimNextPendingRequestQuery(tableName: string, useSkipLocked: boolean): string {
  return `
    SELECT *
    FROM ${tableName}
    WHERE status = 'pending'
       OR (
         status = 'running'
         AND claimed_at IS NOT NULL
         AND claimed_at < NOW() - ($1 * INTERVAL '1 millisecond')
       )
    ORDER BY created_at ASC, id ASC
    LIMIT 1
    FOR UPDATE${useSkipLocked ? " SKIP LOCKED" : ""}
  `;
}

function isSkipLockedSyntaxUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("skip locked")
    || message.includes("kw_skip")
    || message.includes("syntax error");
}

function parseRecord<K extends RuntimeRequestKind = RuntimeRequestKind>(
  row: Record<string, unknown>,
): RuntimeRequestRecord<K> {
  const kind = parseKind(row.kind) as K;
  return {
    id: parseRequiredString(row.id, "id"),
    kind,
    status: parseStatus(row.status),
    payload: parsePayload(kind, row.payload),
    result: row.result === null ? undefined : parseJsonValue(row.result, "result"),
    error: typeof row.error === "string" ? row.error : undefined,
    claimedAt: optionalTimestampMillis(row.claimed_at, "Runtime request claimed_at must be a valid timestamp."),
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
  private readonly staleRunningRequestMs: number;
  private readonly tables: RuntimeRequestTableNames;
  private readonly notificationChannel: string;

  constructor(options: RuntimeRequestRepoOptions) {
    this.pool = options.pool;
    this.notificationPool = options.notificationPool ?? options.pool;
    this.staleRunningRequestMs = options.staleRunningRequestMs ?? DEFAULT_RUNTIME_REQUEST_CLAIM_TIMEOUT_MS;
    this.tables = buildRuntimeRequestTableNames();
    this.notificationChannel = buildRuntimeRequestNotificationChannel();
  }

  private async notifyPendingRequest(): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [this.notificationChannel, "pending"]);
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresRuntimeRequestSchema(this.pool);
  }

  async enqueueRequest<K extends RuntimeRequestKind>(
    input: CreateRuntimeRequestInput<K>,
  ): Promise<RuntimeRequestRecord<K>> {
    const {kind, serialized} = serializePayload(input);
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.runtimeRequests} (
        id,
        kind,
        status,
        payload
      ) VALUES (
        $1,
        $2,
        'pending',
        $3::jsonb
      )
      RETURNING *
    `, [
      randomUUID(),
      kind,
      serialized,
    ]);

    const record = parseRecord<K>(result.rows[0] as Record<string, unknown>);
    await this.notifyPendingRequest();
    return record;
  }

  async claimNextPendingRequest(): Promise<RuntimeRequestRecord | null> {
    const client = await this.pool.connect();

    try {
      for (const useSkipLocked of [true, false] as const) {
        let inTransaction = false;
        try {
          await client.query("BEGIN");
          inTransaction = true;

          const selected = await client.query(
            buildClaimNextPendingRequestQuery(this.tables.runtimeRequests, useSkipLocked),
            [this.staleRunningRequestMs],
          );
          const row = selected.rows[0] as Record<string, unknown> | undefined;
          if (!row) {
            await client.query("COMMIT");
            return null;
          }

          const record = parseRecord(row);
          const updated = await client.query(`
            UPDATE ${this.tables.runtimeRequests}
            SET status = 'running',
                claimed_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
          `, [
            record.id,
          ]);

          await client.query("COMMIT");
          const updatedRow = updated.rows[0] as Record<string, unknown> | undefined;
          return updatedRow ? parseRecord(updatedRow) : null;
        } catch (error) {
          if (inTransaction) {
            await client.query("ROLLBACK");
          }

          if (useSkipLocked && isSkipLockedSyntaxUnsupported(error)) {
            continue;
          }

          throw error;
        }
      }

      return null;
    } finally {
      client.release();
    }
  }

  async completeRequest(id: string, resultValue?: unknown): Promise<RuntimeRequestRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.runtimeRequests}
      SET status = 'completed',
          result = $2::jsonb,
          error = NULL,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [
      requireTrimmedRequestId(id),
      toJson(resultValue),
    ]);
    return parseRecord(result.rows[0] as Record<string, unknown>);
  }

  async failRequest(id: string, error: string): Promise<RuntimeRequestRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.runtimeRequests}
      SET status = 'failed',
          error = $2,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [
      requireTrimmedRequestId(id),
      error,
    ]);
    return parseRecord(result.rows[0] as Record<string, unknown>);
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
