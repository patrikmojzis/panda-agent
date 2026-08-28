import {createHmac} from "node:crypto";
import {lstatSync, readFileSync} from "node:fs";
import path from "node:path";

import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/types.js";
import {trimToNull} from "../../lib/strings.js";

const RUNNER_AUTH_DOMAIN = "panda-runner-auth-v1";
const MINIMUM_MASTER_KEY_BYTES = 32;

export type RunnerAuthScope =
  | {kind: "persistent-agent"; agentKey: string; scopeId: string}
  | {kind: "execution-environment"; agentKey: string; scopeId: string};

export interface RunnerTokenAuthority {
  derive(scope: RunnerAuthScope): string;
}

function decodeMasterKey(value: string): Buffer {
  const normalized = value.trim();
  const encoded = normalized.startsWith("base64:")
    ? normalized.slice("base64:".length)
    : null;
  const key = encoded === null ? Buffer.from(normalized, "utf8") : Buffer.from(encoded, "base64");
  if (
    encoded !== null
    && key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    throw new Error("Runner token master key has invalid base64 encoding.");
  }
  if (key.byteLength < MINIMUM_MASTER_KEY_BYTES) {
    throw new Error(`Runner token master keys must contain at least ${MINIMUM_MASTER_KEY_BYTES} bytes.`);
  }
  return key;
}

function readMasterKeyFile(filePath: string): Buffer {
  if (!path.isAbsolute(filePath)) {
    throw new Error("PANDA_RUNNER_TOKEN_MASTER_KEY_FILE must be an absolute path.");
  }
  const file = lstatSync(filePath);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error("Runner token master key path must be a regular file, not a symlink.");
  }
  if (process.platform !== "win32" && (file.mode & 0o077) !== 0) {
    throw new Error("Runner token master key file must not be accessible by group or other users (use chmod 600).");
  }
  return decodeMasterKey(readFileSync(filePath, "utf8"));
}

export class HmacRunnerTokenAuthority implements RunnerTokenAuthority {
  private readonly masterKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.byteLength < MINIMUM_MASTER_KEY_BYTES) {
      throw new Error(`Runner token master keys must contain at least ${MINIMUM_MASTER_KEY_BYTES} bytes.`);
    }
    this.masterKey = Buffer.from(masterKey);
  }

  derive(scope: RunnerAuthScope): string {
    return createHmac("sha256", this.masterKey)
      .update(`${RUNNER_AUTH_DOMAIN}\0${scope.kind}\0${scope.agentKey}\0${scope.scopeId}`)
      .digest("base64url");
  }
}

export function loadRunnerTokenAuthority(
  env: NodeJS.ProcessEnv = process.env,
): RunnerTokenAuthority | null {
  const inlineKey = trimToNull(env.PANDA_RUNNER_TOKEN_MASTER_KEY);
  const keyFile = trimToNull(env.PANDA_RUNNER_TOKEN_MASTER_KEY_FILE);
  if (inlineKey && keyFile) {
    throw new Error(
      "Set PANDA_RUNNER_TOKEN_MASTER_KEY or PANDA_RUNNER_TOKEN_MASTER_KEY_FILE, not both.",
    );
  }
  if (inlineKey) {
    return new HmacRunnerTokenAuthority(decodeMasterKey(inlineKey));
  }
  if (keyFile) {
    return new HmacRunnerTokenAuthority(readMasterKeyFile(keyFile));
  }
  return null;
}

export function runnerAuthScopeForEnvironment(
  agentKey: string,
  environment?: Pick<ResolvedExecutionEnvironment, "agentKey" | "id" | "kind" | "source">,
): RunnerAuthScope {
  if (environment && environment.agentKey !== agentKey) {
    throw new Error(`Execution environment ${environment.id} does not belong to agent ${agentKey}.`);
  }
  if (!environment || environment.source === "fallback") {
    return {kind: "persistent-agent", agentKey, scopeId: agentKey};
  }
  return {kind: "execution-environment", agentKey, scopeId: environment.id};
}

export function executionEnvironmentRunnerAuthScope(
  agentKey: string,
  environmentId: string,
): RunnerAuthScope {
  return {kind: "execution-environment", agentKey, scopeId: environmentId};
}
