import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export function buildGatewayTableNames() {
  return buildRuntimeRelationNames({
    sources: "gateway_sources",
    devices: "gateway_devices",
    deviceAuditEvents: "gateway_device_audit_events",
    eventTypes: "gateway_event_types",
    accessTokens: "gateway_access_tokens",
    events: "gateway_events",
    attachments: "gateway_attachments",
    eventAttachments: "gateway_event_attachments",
    rateLimits: "gateway_rate_limits",
    strikes: "gateway_strikes",
  });
}
