import path from "node:path";

import type {JsonValue} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";

export const DEFAULT_WORKER_WORKSPACE_PATH = "/workspace";
export const DEFAULT_WORKER_INBOX_PATH = "/inbox";
export const DEFAULT_WORKER_ARTIFACTS_PATH = "/artifacts";
export const DEFAULT_PARENT_RUNNER_ENVIRONMENTS_ROOT = "/environments";

export interface ExecutionEnvironmentFilesystemPathSet {
  hostPath?: string;
  managerPath?: string;
  corePath: string;
  parentRunnerPath?: string;
  workerPath?: string;
}

export interface ExecutionEnvironmentFilesystemMetadata {
  envDir: string;
  root: Omit<ExecutionEnvironmentFilesystemPathSet, "workerPath">;
  workspace: ExecutionEnvironmentFilesystemPathSet;
  inbox: ExecutionEnvironmentFilesystemPathSet;
  artifacts: ExecutionEnvironmentFilesystemPathSet;
}

export function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function mapPathBetweenRoots(
  resolvedPath: string,
  sourceRoot: string,
  targetRoot: string,
): string | null {
  if (!isPathWithinRoot(sourceRoot, resolvedPath)) {
    return null;
  }

  return path.join(targetRoot, path.relative(path.resolve(sourceRoot), path.resolve(resolvedPath)));
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  return trimToUndefined(typeof record[key] === "string" ? record[key] : undefined);
}

function readPathSet(value: unknown, requireWorkerPath: boolean): ExecutionEnvironmentFilesystemPathSet | null {
  if (!isRecord(value)) {
    return null;
  }

  const corePath = readString(value, "corePath");
  const workerPath = readString(value, "workerPath");
  if (!corePath || (requireWorkerPath && !workerPath)) {
    return null;
  }

  return {
    ...(readString(value, "hostPath") ? {hostPath: readString(value, "hostPath")} : {}),
    ...(readString(value, "managerPath") ? {managerPath: readString(value, "managerPath")} : {}),
    corePath,
    ...(readString(value, "parentRunnerPath") ? {parentRunnerPath: readString(value, "parentRunnerPath")} : {}),
    ...(workerPath ? {workerPath} : {}),
  };
}

export function readExecutionEnvironmentFilesystemMetadata(
  metadata: JsonValue | undefined,
): ExecutionEnvironmentFilesystemMetadata | null {
  if (!isRecord(metadata) || !isRecord(metadata.filesystem)) {
    return null;
  }

  const filesystem = metadata.filesystem;
  const envDir = readString(filesystem, "envDir");
  const root = readPathSet(filesystem.root, false);
  const workspace = readPathSet(filesystem.workspace, true);
  const inbox = readPathSet(filesystem.inbox, true);
  const artifacts = readPathSet(filesystem.artifacts, true);
  if (!envDir || !root || !workspace || !inbox || !artifacts) {
    return null;
  }

  return {
    envDir,
    root,
    workspace,
    inbox,
    artifacts,
  };
}
