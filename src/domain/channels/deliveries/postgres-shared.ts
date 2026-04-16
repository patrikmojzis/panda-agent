import {buildRuntimeRelationNames} from "../../threads/runtime/postgres-shared.js";

export interface OutboundDeliveryTableNames {
  prefix: string;
  outboundDeliveries: string;
}

export function buildOutboundDeliveryTableNames(): OutboundDeliveryTableNames {
  return buildRuntimeRelationNames({
    outboundDeliveries: "outbound_deliveries",
  });
}

export function buildDeliveryNotificationChannel(): string {
  return "runtime_outbound_delivery_events";
}
