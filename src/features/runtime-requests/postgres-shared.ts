import {buildPrefixedRelationNames, validateIdentifier} from "../thread-runtime/postgres-shared.js";

export interface PandaRuntimeRequestTableNames {
  prefix: string;
  runtimeRequests: string;
}

export function buildPandaRuntimeRequestTableNames(prefix: string): PandaRuntimeRequestTableNames {
  return buildPrefixedRelationNames(prefix, {
    runtimeRequests: "runtime_requests",
  });
}

export function buildPandaRuntimeRequestNotificationChannel(prefix = "thread_runtime"): string {
  return validateIdentifier(`${prefix}_runtime_request_events`);
}
