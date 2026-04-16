import {buildRuntimeRelationNames} from "../runtime/postgres-shared.js";

export interface RuntimeRequestTableNames {
  prefix: string;
  runtimeRequests: string;
}

export function buildRuntimeRequestTableNames(): RuntimeRequestTableNames {
  return buildRuntimeRelationNames({
    runtimeRequests: "runtime_requests",
  });
}

export function buildRuntimeRequestNotificationChannel(): string {
  return "runtime_request_events";
}
