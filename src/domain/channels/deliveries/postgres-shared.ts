import {buildPrefixedRelationNames, validateIdentifier,} from "../../threads/runtime/postgres-shared.js";

export interface OutboundDeliveryTableNames {
  prefix: string;
  outboundDeliveries: string;
}

export function buildOutboundDeliveryTableNames(prefix: string): OutboundDeliveryTableNames {
  return buildPrefixedRelationNames(prefix, {
    outboundDeliveries: "outbound_deliveries",
  });
}

export function buildDeliveryNotificationChannel(prefix = "thread_runtime"): string {
  return validateIdentifier(`${prefix}_outbound_delivery_events`);
}
