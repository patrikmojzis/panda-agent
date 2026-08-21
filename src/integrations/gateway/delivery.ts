import type {GatewayEventAttachmentRecord, GatewayEventRecord, GatewaySourceRecord} from "../../domain/gateway/types.js";
import {gatewayAttachmentToMediaDescriptor} from "../../domain/gateway/types.js";
import {
  enqueueCurrentSessionInput,
} from "../../domain/sessions/current-thread.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {describeMediaDescriptor, serializeMediaDescriptor} from "../channels/media-shared.js";
import {renderGatewayInboundText} from "../../prompts/channels/gateway.js";

export interface GatewayDeliveryStore {
  listEventAttachments?(eventId: string): Promise<readonly GatewayEventAttachmentRecord[]>;
  markEventDelivered(input: {
    attachmentRetentionMs?: number;
    claimId?: string;
    eventId: string;
    metadata: JsonObject;
    riskScore?: number;
    threadId: string;
  }): Promise<unknown>;
  markEventQuarantined(input: {
    attachmentQuarantineTtlMs?: number;
    claimId?: string;
    eventId: string;
    metadata: JsonObject;
    reason: string;
    riskScore?: number;
  }): Promise<unknown>;
  reserveEventDelivery(input: {
    claimId: string;
    eventId: string;
    metadata: JsonObject;
    riskScore?: number;
  }): Promise<GatewayEventRecord | null>;
}

export type GatewayDeliverySessionStore = Pick<SessionStore, "getSession" | "getMainSession">;

export type GatewayDeliveryAssessment =
  | {guardStatus: "bypassed"; trusted: true}
  | {guardStatus: "scored"; riskScore: number; trusted: false};

function serializeGatewayAttachment(
  attachment: GatewayEventAttachmentRecord,
  assessment: GatewayDeliveryAssessment,
): JsonObject {
  const metadataTrust = assessment.trusted ? "trusted" : "external_untrusted";
  const descriptor = serializeMediaDescriptor(gatewayAttachmentToMediaDescriptor(attachment));
  const descriptorMetadata = descriptor.metadata ?? null;
  const metadata = isJsonObject(descriptorMetadata)
    ? {
        ...descriptorMetadata,
        gateway: {
          ...(isJsonObject(descriptorMetadata.gateway) ? descriptorMetadata.gateway : {}),
          trust: metadataTrust,
          guardStatus: assessment.guardStatus,
        },
      }
    : descriptorMetadata;
  return {
    ...descriptor,
    metadata,
    eventId: attachment.eventId,
    position: attachment.position,
    sha256: attachment.sha256,
    status: attachment.status,
    scanStatus: attachment.scanStatus,
    metadataTrust,
    guardStatus: assessment.guardStatus,
  };
}

function describeGatewayAttachment(
  attachment: GatewayEventAttachmentRecord,
  assessment: GatewayDeliveryAssessment,
): string {
  const metadataTrust = assessment.trusted ? "trusted" : "external_untrusted";
  return describeMediaDescriptor(gatewayAttachmentToMediaDescriptor(attachment), [
    `sha256: ${attachment.sha256}`,
    `status: ${attachment.status}`,
    `scan_status: ${attachment.scanStatus}`,
    `metadata_trust: ${metadataTrust}`,
    `guard_status: ${assessment.guardStatus}`,
  ]);
}

function buildGatewayMetadata(input: {
  attachments: readonly GatewayEventAttachmentRecord[];
  assessment: GatewayDeliveryAssessment;
  event: GatewayEventRecord;
}): JsonObject {
  const metadataTrust = input.assessment.trusted ? "trusted" : "external_untrusted";
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
      trusted: input.assessment.trusted,
      guardStatus: input.assessment.guardStatus,
      ...(!input.assessment.trusted ? {riskScore: input.assessment.riskScore} : {}),
      textBytes: input.event.textBytes,
      textSha256: input.event.textSha256,
      metadataTrust,
      attachments: input.attachments.map((attachment) => serializeGatewayAttachment(attachment, input.assessment)),
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
  assessment: GatewayDeliveryAssessment;
  event: GatewayEventRecord;
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
    assessment: input.assessment,
    event: input.event,
  });
  const riskScore = input.assessment.trusted ? undefined : input.assessment.riskScore;
  const quarantineRiskScore = input.assessment.trusted ? undefined : 1;

  if (!input.event.claimId) {
    await input.store.markEventQuarantined({
      eventId: input.event.id,
      ...(quarantineRiskScore !== undefined ? {riskScore: quarantineRiskScore} : {}),
      reason: "gateway event is missing a processing claim",
      metadata: {gateway: {missingClaim: true}},
      attachmentQuarantineTtlMs: input.attachmentQuarantineTtlMs,
    });
    return;
  }

  const reserved = await input.store.reserveEventDelivery({
    eventId: input.event.id,
    claimId: input.event.claimId,
    ...(riskScore !== undefined ? {riskScore} : {}),
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
      ...(quarantineRiskScore !== undefined ? {riskScore: quarantineRiskScore} : {}),
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
          trusted: input.assessment.trusted,
          ...(!input.assessment.trusted ? {riskScore: input.assessment.riskScore} : {}),
          text: input.event.text,
          attachments: attachments.map((attachment) => describeGatewayAttachment(attachment, input.assessment)),
        })),
        metadata,
      },
    });
  } catch (error) {
    await input.store.markEventQuarantined({
      eventId: input.event.id,
      claimId: input.event.claimId,
      ...(quarantineRiskScore !== undefined ? {riskScore: quarantineRiskScore} : {}),
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
    ...(riskScore !== undefined ? {riskScore} : {}),
    metadata,
    attachmentRetentionMs: input.attachmentRetentionMs,
  });
}
