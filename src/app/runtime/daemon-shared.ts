import {createHash} from "node:crypto";
import {buildMissingRuntimeIdentityIdMessage} from "./daemon-copy.js";

export const DEFAULT_PANDA_DAEMON_KEY = "primary";
export const PANDA_DAEMON_HEARTBEAT_INTERVAL_MS = 5_000;
export const PANDA_DAEMON_STALE_AFTER_MS = 15_000;
export const PANDA_DAEMON_REQUEST_TIMEOUT_MS = 30_000;

export interface PandaDaemonOptions {
  cwd: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
  maxSubagentDepth?: number;
  tablePrefix?: string;
}

export interface PandaDaemonServices {
  run(): Promise<void>;
  stop(): Promise<void>;
}

export function trimNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

export function hashLockKey(value: string): readonly [number, number] {
  const digest = createHash("sha256").update(value).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)] as const;
}

export function requireIdentityId(identityId: string | undefined, kind: string): string {
  const trimmed = trimNonEmptyString(identityId);
  if (!trimmed) {
    throw new Error(buildMissingRuntimeIdentityIdMessage(kind));
  }

  return trimmed;
}

export function resolveImplicitHomeThreadReplacementAgent(input: {
  requestedAgentKey?: string;
  existingAgentKey: string;
  identityDefaultAgentKey?: string;
}): string | undefined {
  const requestedAgentKey = trimNonEmptyString(input.requestedAgentKey);
  const defaultAgentKey = trimNonEmptyString(input.identityDefaultAgentKey);
  if (requestedAgentKey || !defaultAgentKey || input.existingAgentKey === defaultAgentKey) {
    return undefined;
  }

  // "Open chat without --agent" should follow the identity default now, not
  // whatever agent happened to own the home thread some time in the past.
  return defaultAgentKey;
}
