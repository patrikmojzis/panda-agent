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
