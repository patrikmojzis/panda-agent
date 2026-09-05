import path from "node:path";

import type {JsonValue} from "../../lib/json.js";
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

/** Validate declared paths in the target runner's namespace without probing its filesystem. */
export function normalizeExecutionEnvironmentPersistentRoots(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const roots: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    const root = entry.trim();
    if (!root || root.length > 4096 || /[\x00-\x1f\x7f]/.test(root)
      || (!path.posix.isAbsolute(root) && !path.win32.isAbsolute(root))) return undefined;
    roots.push(root);
  }
  return [...new Set(roots)];
}

/** Read optional deployment/operator storage declarations; malformed metadata grants no guarantee. */
export function readExecutionEnvironmentPersistentRoots(metadata: JsonValue | undefined): string[] | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.storage)) return undefined;
  return normalizeExecutionEnvironmentPersistentRoots(metadata.storage.persistentRoots);
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
