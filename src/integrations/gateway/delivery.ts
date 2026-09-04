import type {GatewayEventAttachmentRecord, GatewayEventRecord, GatewaySourceRecord} from "../../domain/gateway/types.js";
import {gatewayAttachmentToMediaDescriptor} from "../../domain/gateway/types.js";
import {GatewayDeliveryTargetUnavailableError, type PostgresGatewayStore} from "../../domain/gateway/postgres.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {describeMediaDescriptor, serializeMediaDescriptor} from "../channels/media-shared.js";
import {renderGatewayInboundText} from "../../prompts/channels/gateway.js";

export type GatewayDeliveryStore = Pick<PostgresGatewayStore,
  "listEventAttachments" | "recordEventAssessment" | "commitEventDelivery" | "markEventQuarantined" | "getEvent">;

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

export function readGatewayDeliveryAssessment(event: GatewayEventRecord): GatewayDeliveryAssessment | undefined {
  if (!event.inputId) return undefined;
  const gateway = isJsonObject(event.metadata) ? event.metadata.gateway : undefined;
  if (isJsonObject(gateway)) {
    if (event.trusted && gateway.guardStatus === "bypassed") return {guardStatus: "bypassed", trusted: true};
    if (!event.trusted && gateway.guardStatus === "scored" && event.riskScore !== undefined) {
      return {guardStatus: "scored", trusted: false, riskScore: event.riskScore};
    }
  }
  throw new Error("Gateway input receipt has no valid persisted guard assessment.");
}

export async function deliverGatewayEventToThread(input: {
  attachmentQuarantineTtlMs?: number;
  attachmentRetentionMs?: number;
  attachments?: readonly GatewayEventAttachmentRecord[];
  assessment: GatewayDeliveryAssessment;
  event: GatewayEventRecord;
  source: GatewaySourceRecord;
  store: GatewayDeliveryStore;
}): Promise<void> {
  const attachments = input.attachments ?? await input.store.listEventAttachments(input.event.id);
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

  const assessed = await input.store.recordEventAssessment({
    eventId: input.event.id,
    claimId: input.event.claimId,
    ...(riskScore !== undefined ? {riskScore} : {}),
    metadata,
  });
  if (!assessed) return;

  try {
    await input.store.commitEventDelivery({
      eventId: input.event.id,
      claimId: input.event.claimId,
      source: input.source,
      attachmentRetentionMs: input.attachmentRetentionMs,
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
    // A lost COMMIT acknowledgement is receipt recovery, never evidence that
    // input admission failed. A database outage leaves the claim retryable.
    const receipt = await input.store.getEvent(input.event.id).catch(() => undefined);
    if (receipt?.status === "delivered") return;
    if (!(error instanceof GatewayDeliveryTargetUnavailableError)) throw error;
    await input.store.markEventQuarantined({
      eventId: input.event.id,
      claimId: input.event.claimId,
      ...(quarantineRiskScore !== undefined ? {riskScore: quarantineRiskScore} : {}),
      reason: error.message,
      metadata,
      attachmentQuarantineTtlMs: input.attachmentQuarantineTtlMs,
    });
  }
}
