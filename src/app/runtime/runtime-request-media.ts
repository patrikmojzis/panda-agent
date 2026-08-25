import {
  discardStagedMediaDescriptors,
  type MediaReceiptOwner,
  type MediaReceiptOwnerState,
} from "../../domain/channels/media-store.js";
import type {MediaDescriptor} from "../../domain/channels/types.js";
import type {RuntimeRequestRepo} from "../../domain/threads/requests/repo.js";
import {
  RUNTIME_REQUEST_KINDS,
  type RuntimeRequestKind,
  type RuntimeRequestRecord,
} from "../../domain/threads/requests/types.js";

function runtimeRequestMedia(request: RuntimeRequestRecord): readonly MediaDescriptor[] {
  switch (request.kind) {
    case "a2a_message":
      return request.payload.items.flatMap((item) => item.type === "text" ? [] : [item.media]);
    case "discord_message":
    case "telegram_message":
    case "whatsapp_message":
      return request.payload.media;
    default:
      return [];
  }
}

export async function discardSettledRuntimeRequestMedia(
  request: RuntimeRequestRecord,
  _status: "completed" | "failed" = "completed",
): Promise<void> {
  const media = runtimeRequestMedia(request);
  if (media.length === 0) return;
  // This only releases transport staging. A relocated target can already be
  // referenced by a prior transcript after redelivery, so request settlement
  // cannot prove that the durable agent copy is unreferenced.
  await discardStagedMediaDescriptors(media);
}

/**
 * Resolves every known request kind in one query. Unknown kinds stay active so
 * an older daemon cannot delete staging bytes written by a newer connector.
 */
export async function resolveRuntimeRequestMediaReceiptOwners(
  owners: readonly MediaReceiptOwner[],
  requests: Pick<RuntimeRequestRepo, "getRequestStatusesByIdempotencyEntries">,
): Promise<readonly MediaReceiptOwnerState[]> {
  const known = owners.flatMap((owner, index) => (
    RUNTIME_REQUEST_KINDS.includes(owner.requestKind as RuntimeRequestKind)
      ? [{index, idempotencyKey: owner.requestIdempotencyKey, kind: owner.requestKind as RuntimeRequestKind}]
      : []
  ));
  const statuses = await requests.getRequestStatusesByIdempotencyEntries(known);
  const resolved: MediaReceiptOwnerState[] = owners.map(() => "active");
  for (const [statusIndex, entry] of known.entries()) {
    const status = statuses[statusIndex];
    resolved[entry.index] = status === "completed" || status === "failed"
      ? status
      : status ? "active" : "missing";
  }
  return resolved;
}
