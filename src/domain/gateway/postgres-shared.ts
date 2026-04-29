import {buildRuntimeRelationNames} from "../threads/runtime/postgres-shared.js";

export function buildGatewayTableNames() {
  return buildRuntimeRelationNames({
    sources: "gateway_sources",
    eventTypes: "gateway_event_types",
    accessTokens: "gateway_access_tokens",
    events: "gateway_events",
    rateLimits: "gateway_rate_limits",
    strikes: "gateway_strikes",
  });
}
