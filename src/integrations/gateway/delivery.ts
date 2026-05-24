import type {GatewayEventAttachmentRecord, GatewayEventRecord, GatewaySourceRecord} from "../../domain/gateway/types.js";
import {gatewayAttachmentToMediaDescriptor} from "../../domain/gateway/types.js";
import {
  enqueueCurrentSessionInput,
} from "../../domain/sessions/current-thread.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import type {JsonObject} from "../../lib/json.js";
import {describeMediaDescriptor, serializeMediaDescriptor} from "../channels/media-shared.js";
import {renderGatewayInboundText} from "../../prompts/channels/gateway.js";

export interface GatewayDeliveryStore {
  listEventAttachments?(eventId: string): Promise<readonly GatewayEventAttachmentRecord[]>;
  markEventDelivered(input: {
    attachmentRetentionMs?: number;
    claimId?: string;
    eventId: string;
    metadata: JsonObject;
    riskScore: number;
    threadId: string;
  }): Promise<unknown>;
  markEventQuarantined(input: {
    attachmentQuarantineTtlMs?: number;
    claimId?: string;
    eventId: string;
    metadata: JsonObject;
    reason: string;
    riskScore: number;
  }): Promise<unknown>;
  reserveEventDelivery(input: {
    claimId: string;
    eventId: string;
    metadata: JsonObject;
    riskScore: number;
  }): Promise<GatewayEventRecord | null>;
}

export type GatewayDeliverySessionStore = Pick<SessionStore, "getSession" | "getMainSession">;

function serializeGatewayAttachment(attachment: GatewayEventAttachmentRecord): JsonObject {
  return {
    ...serializeMediaDescriptor(gatewayAttachmentToMediaDescriptor(attachment)),
    eventId: attachment.eventId,
    position: attachment.position,
    sha256: attachment.sha256,
    status: attachment.status,
    scanStatus: attachment.scanStatus,
    metadataTrust: "external_untrusted",
  };
}

function describeGatewayAttachment(attachment: GatewayEventAttachmentRecord): string {
  return describeMediaDescriptor(gatewayAttachmentToMediaDescriptor(attachment), [
    `sha256: ${attachment.sha256}`,
    `status: ${attachment.status}`,
    `scan_status: ${attachment.scanStatus}`,
    "metadata_trust: external_untrusted",
  ]);
}

function buildGatewayMetadata(input: {
  attachments: readonly GatewayEventAttachmentRecord[];
  event: GatewayEventRecord;
  riskScore: number;
}): JsonObject {
  return {
    gateway: {
      schemaVersion: 1,
      sourceId: input.event.sourceId,
      eventId: input.event.id,
      eventType: input.event.type,
      deliveryRequested: input.event.deliveryRequested,
      deliveryEffective: input.event.deliveryEffective,
      occurredAt: input.event.occurredAt ? new Date(input.event.occurredAt).toISOString() : null,
      receivedAt: new Date(input.event.createdAt).toISOString(),
      riskScore: input.riskScore,
      textBytes: input.event.textBytes,
      textSha256: input.event.textSha256,
      metadataTrust: "external_untrusted",
      attachments: input.attachments.map(serializeGatewayAttachment),
    },
  };
}

function describeGatewayDeliveryFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveTargetSessionId(input: {
  sessionStore: GatewayDeliverySessionStore;
  source: GatewaySourceRecord;
}): Promise<string> {
  if (input.source.sessionId) {
    return input.source.sessionId;
  }

  const mainSession = await input.sessionStore.getMainSession(input.source.agentKey);
  if (!mainSession) {
    throw new Error(`Agent ${input.source.agentKey} does not have a main session.`);
  }
  return mainSession.id;
}

async function resolveEventAttachments(input: {
  attachments?: readonly GatewayEventAttachmentRecord[];
  eventId: string;
  store: GatewayDeliveryStore;
}): Promise<readonly GatewayEventAttachmentRecord[]> {
  if (input.attachments) {
    return input.attachments;
  }
  return input.store.listEventAttachments ? await input.store.listEventAttachments(input.eventId) : [];
}

export async function deliverGatewayEventToThread(input: {
  attachmentQuarantineTtlMs?: number;
  attachmentRetentionMs?: number;
  attachments?: readonly GatewayEventAttachmentRecord[];
  event: GatewayEventRecord;
  riskScore: number;
  sessionStore: GatewayDeliverySessionStore;
  source: GatewaySourceRecord;
  store: GatewayDeliveryStore;
  threadStore: Pick<ThreadRuntimeStore, "enqueueInput">;
}): Promise<void> {
  const attachments = await resolveEventAttachments({
    attachments: input.attachments,
    eventId: input.event.id,
    store: input.store,
  });
  const metadata = buildGatewayMetadata({
    attachments,
    event: input.event,
    riskScore: input.riskScore,
  });

  if (!input.event.claimId) {
    await input.store.markEventQuarantined({
      eventId: input.event.id,
      riskScore: 1,
      reason: "gateway event is missing a processing claim",
      metadata: {gateway: {missingClaim: true}},
      attachmentQuarantineTtlMs: input.attachmentQuarantineTtlMs,
    });
    return;
  }

  const reserved = await input.store.reserveEventDelivery({
    eventId: input.event.id,
    claimId: input.event.claimId,
    riskScore: input.riskScore,
    metadata,
  });
  if (!reserved) {
    return;
  }

  let sessionId: string;
  try {
    sessionId = await resolveTargetSessionId({
      sessionStore: input.sessionStore,
      source: input.source,
    });
  } catch (error) {
    await input.store.markEventQuarantined({
      eventId: input.event.id,
      claimId: input.event.claimId,
      riskScore: 1,
      reason: describeGatewayDeliveryFailure(error),
      metadata,
      attachmentQuarantineTtlMs: input.attachmentQuarantineTtlMs,
    });
    return;
  }

  let target;
  try {
    target = await enqueueCurrentSessionInput({
      sessions: input.sessionStore,
      sessionId,
      threads: input.threadStore,
      mode: input.event.deliveryEffective,
      payload: {
        source: "gateway",
        channelId: input.event.sourceId,
        externalMessageId: input.event.id,
        actorId: input.event.sourceId,
        identityId: input.source.identityId,
        message: stringToUserMessage(renderGatewayInboundText({
          sourceId: input.event.sourceId,
          eventId: input.event.id,
          eventType: input.event.type,
          delivery: input.event.deliveryEffective,
          occurredAt: input.event.occurredAt ? new Date(input.event.occurredAt).toISOString() : undefined,
          receivedAt: new Date(input.event.createdAt).toISOString(),
          riskScore: input.riskScore,
          text: input.event.text,
          attachments: attachments.map(describeGatewayAttachment),
        })),
        metadata,
      },
    });
  } catch (error) {
    await input.store.markEventQuarantined({
      eventId: input.event.id,
      claimId: input.event.claimId,
      riskScore: 1,
      reason: describeGatewayDeliveryFailure(error),
      metadata,
      attachmentQuarantineTtlMs: input.attachmentQuarantineTtlMs,
    });
    return;
  }

  await input.store.markEventDelivered({
    eventId: input.event.id,
    claimId: input.event.claimId,
    threadId: target.threadId,
    riskScore: input.riskScore,
    metadata,
    attachmentRetentionMs: input.attachmentRetentionMs,
  });
}
