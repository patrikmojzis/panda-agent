import {buildPrefixedRelationNames, validateIdentifier,} from "../thread-runtime/postgres-shared.js";

export interface OutboundDeliveryTableNames {
  prefix: string;
  outboundDeliveries: string;
}

export function buildOutboundDeliveryTableNames(prefix: string): OutboundDeliveryTableNames {
  return buildPrefixedRelationNames(prefix, {
    outboundDeliveries: "outbound_deliveries",
  });
}

export function buildOutboundDeliveryNotificationChannel(prefix = "thread_runtime"): string {
  return validateIdentifier(`${prefix}_outbound_delivery_events`);
}
