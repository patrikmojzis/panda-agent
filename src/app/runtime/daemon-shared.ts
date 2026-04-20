import {createHash} from "node:crypto";
import {buildMissingRuntimeIdentityIdMessage} from "./daemon-copy.js";
import {trimToUndefined} from "../../lib/strings.js";

export const DEFAULT_DAEMON_KEY = "primary";
export const DAEMON_HEARTBEAT_INTERVAL_MS = 5_000;
export const DAEMON_STALE_AFTER_MS = 15_000;
export const DAEMON_REQUEST_TIMEOUT_MS = 30_000;

export interface DaemonOptions {
  cwd: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
  maxSubagentDepth?: number;
}

export interface DaemonServices {
  run(): Promise<void>;
  stop(): Promise<void>;
}

export const trimNonEmptyString = trimToUndefined;

export function hashLockKey(value: string): readonly [number, number] {
  const digest = createHash("sha256").update(value).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)] as const;
}

export function requireIdentityId(identityId: string | undefined, kind: string): string {
  const trimmed = trimToUndefined(identityId);
  if (!trimmed) {
    throw new Error(buildMissingRuntimeIdentityIdMessage(kind));
  }

  return trimmed;
}
