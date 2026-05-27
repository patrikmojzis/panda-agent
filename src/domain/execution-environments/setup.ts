import type {JsonObject, JsonValue} from "../../lib/json.js";
import {isJsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";

export const EXECUTION_ENVIRONMENT_SETUP_METADATA_KEY = "setup";
export const SETUP_ARTIFACTS_WORKER_DIR = "/artifacts/setup";
export const SETUP_SCRIPT_WORKER_PATH = `${SETUP_ARTIFACTS_WORKER_DIR}/setup.sh`;
export const SETUP_STDOUT_WORKER_PATH = `${SETUP_ARTIFACTS_WORKER_DIR}/stdout.log`;
export const SETUP_STDERR_WORKER_PATH = `${SETUP_ARTIFACTS_WORKER_DIR}/stderr.log`;
export const SETUP_RESULT_WORKER_PATH = `${SETUP_ARTIFACTS_WORKER_DIR}/setup-result.json`;
export const SETUP_TOOLCHAIN_WORKER_PATH = `${SETUP_ARTIFACTS_WORKER_DIR}/toolchain.json`;

export const SETUP_SCRIPT_INSPECTION_NOTE = "Copied setup.sh is intentionally inspectable under /artifacts/setup/setup.sh; do not embed secrets in setup scripts. Use harness-injected credential environment variables instead.";

export type SetupToolName = "node" | "pnpm" | "corepack";

export const SETUP_TOOL_NAMES: readonly SetupToolName[] = ["node", "pnpm", "corepack"];

export interface ExecutionEnvironmentSetupScriptInput {
  requestedPath: string;
  resolvedPath: string;
}

export interface ExecutionEnvironmentSetupRequest {
  setupScript: ExecutionEnvironmentSetupScriptInput;
}

export function buildSetupMetadataPatch(setup: JsonObject): JsonObject {
  return {
    [EXECUTION_ENVIRONMENT_SETUP_METADATA_KEY]: setup,
  };
}

export function readExecutionEnvironmentSetupMetadata(metadata: JsonValue | undefined): JsonObject | null {
  if (!isRecord(metadata)) {
    return null;
  }

  const setup = metadata[EXECUTION_ENVIRONMENT_SETUP_METADATA_KEY];
  if (!isJsonObject(setup)) {
    return null;
  }

  const status = setup.status;
  return status === "succeeded" || status === "failed" ? setup : null;
}

export function hasExecutionEnvironmentSetup(metadata: JsonValue | undefined): boolean {
  return readExecutionEnvironmentSetupMetadata(metadata) !== null;
}
