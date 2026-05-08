import {existsSync, realpathSync} from "node:fs";
import {realpath} from "node:fs/promises";
import path from "node:path";

import {
    DEFAULT_PARENT_RUNNER_ENVIRONMENTS_ROOT,
    isPathWithinRoot,
    mapPathBetweenRoots,
    readExecutionEnvironmentFilesystemMetadata,
} from "../../domain/execution-environments/index.js";
import {mapRunnerAgentPathToHost} from "../../integrations/shell/path-mapping.js";
import type {JsonValue} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull, trimToUndefined} from "../../lib/strings.js";
import type {ShellSession} from "../../integrations/shell/types.js";
import {resolveDataDir} from "./data-dir.js";

const DEFAULT_SHELL_ENVIRONMENT_ID = "default";

interface ResolvedPath {
  path: string;
  containmentRoot?: string;
  blockedReason?: string;
}

function readContextAgentKey(context: unknown): string | null {
  if (!isRecord(context)) {
    return null;
  }

  return trimToNull(context.agentKey);
}

function resolveCoreEnvironmentsRoot(env: NodeJS.ProcessEnv): string {
  return path.resolve(
    trimToUndefined(env.PANDA_CORE_ENVIRONMENTS_ROOT)
    ?? trimToUndefined(env.PANDA_ENVIRONMENTS_ROOT)
    ?? path.join(resolveDataDir(env), "environments"),
  );
}

function resolveParentRunnerEnvironmentsRoot(env: NodeJS.ProcessEnv): string {
  return path.resolve(trimToUndefined(env.PANDA_RUNNER_ENVIRONMENTS_ROOT) ?? DEFAULT_PARENT_RUNNER_ENVIRONMENTS_ROOT);
}

function resolveAgentEnvironmentPath(
  resolvedPath: string,
  agentKey: string,
  env: NodeJS.ProcessEnv,
): ResolvedPath | null {
  const sourceRoot = resolveParentRunnerEnvironmentsRoot(env);
  const targetRoot = path.join(resolveCoreEnvironmentsRoot(env), agentKey);
  const mapped = mapPathBetweenRoots(resolvedPath, sourceRoot, targetRoot);
  return mapped ? {path: mapped, containmentRoot: targetRoot} : null;
}

function resolveBoundEnvironmentPath(resolvedPath: string, context: Record<string, unknown>): ResolvedPath | null {
  const executionEnvironment = context.executionEnvironment;
  const agentKey = readContextAgentKey(context);
  if (!agentKey || !isRecord(executionEnvironment) || executionEnvironment.agentKey !== agentKey) {
    return null;
  }

  const filesystem = readExecutionEnvironmentFilesystemMetadata(executionEnvironment.metadata as JsonValue | undefined);
  if (!filesystem) {
    return null;
  }

  const entries: ReadonlyArray<{corePath: string; parentRunnerPath?: string; workerPath?: string}> = [
    filesystem.root,
    filesystem.workspace,
    filesystem.inbox,
    filesystem.artifacts,
  ];
  for (const entry of entries) {
    if (entry.workerPath) {
      const mapped = mapPathBetweenRoots(resolvedPath, entry.workerPath, entry.corePath);
      if (mapped) {
        return {path: mapped, containmentRoot: entry.corePath};
      }
    }
    if (entry.parentRunnerPath) {
      const mapped = mapPathBetweenRoots(resolvedPath, entry.parentRunnerPath, entry.corePath);
      if (mapped) {
        return {path: mapped, containmentRoot: entry.corePath};
      }
    }
  }

  return {
    path: resolvedPath,
    blockedReason: "Path is outside this execution environment's shared filesystem roots.",
  };
}

function resolveMountedAgentPath(
  resolvedPath: string,
  context: unknown,
  env: NodeJS.ProcessEnv,
): ResolvedPath {
  const agentKey = readContextAgentKey(context);
  if (isRecord(context)) {
    const environmentPath = resolveBoundEnvironmentPath(resolvedPath, context)
      ?? (agentKey ? resolveAgentEnvironmentPath(resolvedPath, agentKey, env) : null);
    if (environmentPath) {
      return environmentPath;
    }

    const executionEnvironment = context.executionEnvironment;
    if (
      isRecord(executionEnvironment)
      && executionEnvironment.source !== "fallback"
      && executionEnvironment.kind !== "persistent_agent_runner"
    ) {
      return {path: resolvedPath};
    }
  }

  if (!agentKey) {
    return {path: resolvedPath};
  }

  // Remote bash sees the agent home through the runner mount, but file tools
  // still run in panda-core and need the host-visible mirror path.
  return {path: mapRunnerAgentPathToHost(resolvedPath, agentKey, env)};
}

function normalizeShellSession(shellSession: ShellSession): ShellSession {
  shellSession.cwd = path.resolve(shellSession.cwd);

  if (!isRecord(shellSession.env)) {
    shellSession.env = {};
  } else {
    for (const [key, value] of Object.entries(shellSession.env)) {
      if (typeof value !== "string") {
        delete shellSession.env[key];
      }
    }
  }

  if (!Array.isArray(shellSession.secretEnvKeys)) {
    shellSession.secretEnvKeys = [];
  } else {
    shellSession.secretEnvKeys = [...new Set(
      shellSession.secretEnvKeys.filter((key): key is string => typeof key === "string" && key in shellSession.env),
    )];
  }

  return shellSession;
}

function readExecutionEnvironmentId(context: unknown): string {
  if (!isRecord(context)) {
    return DEFAULT_SHELL_ENVIRONMENT_ID;
  }

  const environment = context.executionEnvironment;
  if (isRecord(environment) && typeof environment.id === "string" && environment.id.trim()) {
    return environment.id.trim();
  }

  return DEFAULT_SHELL_ENVIRONMENT_ID;
}

function readEnvironmentInitialCwd(context: unknown): string | null {
  if (!isRecord(context)) {
    return null;
  }

  const environment = context.executionEnvironment;
  if (isRecord(environment) && typeof environment.initialCwd === "string" && environment.initialCwd.trim()) {
    return path.resolve(environment.initialCwd);
  }

  return null;
}

function readShellSessions(context: Record<string, unknown>): Record<string, ShellSession> {
  if (isRecord(context.shellSessions)) {
    return context.shellSessions as Record<string, ShellSession>;
  }

  const sessions: Record<string, ShellSession> = {};
  context.shellSessions = sessions;
  return sessions;
}

function canMigrateLegacyShell(context: Record<string, unknown>): boolean {
  const environment = context.executionEnvironment;
  return !isRecord(environment) || environment.source !== "binding";
}

export function readBaseCwd(context: unknown): string {
  if (isRecord(context)) {
    const environmentId = readExecutionEnvironmentId(context);
    const shellSessions = isRecord(context.shellSessions)
      ? context.shellSessions as Record<string, ShellSession>
      : undefined;
    const environmentShell = shellSessions?.[environmentId];
    if (environmentShell?.cwd?.trim()) {
      return path.resolve(environmentShell.cwd);
    }

    const environmentInitialCwd = readEnvironmentInitialCwd(context);
    if (environmentInitialCwd) {
      return environmentInitialCwd;
    }

    const shell = context.shell;
    if (!shellSessions && isRecord(shell) && typeof shell.cwd === "string" && shell.cwd.trim()) {
      return path.resolve(shell.cwd);
    }

    if (typeof context.cwd === "string" && context.cwd.trim()) {
      return path.resolve(context.cwd);
    }
  }

  return process.cwd();
}

export function ensureShellSession(context: unknown): ShellSession | null {
  if (!isRecord(context)) {
    return null;
  }

  const environmentId = readExecutionEnvironmentId(context);
  const shellSessions = readShellSessions(context);
  const existing = shellSessions[environmentId];
  if (existing?.cwd) {
    return normalizeShellSession(existing);
  }

  const shell = context.shell;
  if (
    Object.keys(shellSessions).length === 0
    && canMigrateLegacyShell(context)
    && isRecord(shell)
    && typeof shell.cwd === "string"
  ) {
    const normalized = normalizeShellSession(shell as unknown as ShellSession);
    shellSessions[environmentId] = normalized;
    return normalized;
  }

  const nextShell: ShellSession = {
    cwd: readBaseCwd(context),
    env: {},
  };

  shellSessions[environmentId] = nextShell;
  return nextShell;
}

export function readCurrentInputIdentityId(context: unknown): string | undefined {
  if (!isRecord(context)) {
    return undefined;
  }

  const currentInput = context.currentInput;
  if (!isRecord(currentInput)) {
    return undefined;
  }

  return trimToUndefined(currentInput.identityId);
}

export function resolveContextPath(
  rawPath: string,
  context: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolved = resolveContextPathDetails(rawPath, context, env);
  if (resolved.blockedReason) {
    throw new Error(`${resolved.blockedReason} Path: ${rawPath}`);
  }
  if (!resolved.containmentRoot) {
    return resolved.path;
  }

  return resolveContainedPathSync(resolved.path, resolved.containmentRoot, rawPath);
}

function resolveContextPathDetails(
  rawPath: string,
  context: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPath {
  const resolvedPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(readBaseCwd(context), rawPath);

  return resolveMountedAgentPath(resolvedPath, context, env);
}

function realpathNearestExistingSync(targetPath: string): string {
  let current = path.resolve(targetPath);
  const missingParts: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(targetPath);
    }
    missingParts.unshift(path.basename(current));
    current = parent;
  }

  let existingRealPath: string;
  try {
    existingRealPath = realpathSync.native(current);
  } catch {
    existingRealPath = path.resolve(current);
  }
  return path.join(existingRealPath, ...missingParts);
}

function resolveContainedPathSync(targetPath: string, rootPath: string, rawPath: string): string {
  const rootRealPath = realpathNearestExistingSync(rootPath);
  const targetRealPath = realpathNearestExistingSync(targetPath);
  if (!isPathWithinRoot(rootRealPath, targetRealPath)) {
    throw new Error(`Resolved path escapes the execution environment root: ${rawPath}`);
  }

  return targetRealPath;
}

async function realpathNearestExisting(targetPath: string): Promise<string> {
  let current = path.resolve(targetPath);
  const missingParts: string[] = [];
  while (true) {
    try {
      const existingRealPath = await realpath(current);
      return path.join(existingRealPath, ...missingParts);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(targetPath);
      }
      missingParts.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function realpathIfPossible(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export async function resolveReadableContextPath(
  rawPath: string,
  context: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const resolved = resolveContextPathDetails(rawPath, context, env);
  if (resolved.blockedReason) {
    throw new Error(`${resolved.blockedReason} Path: ${rawPath}`);
  }
  if (!resolved.containmentRoot) {
    return resolved.path;
  }

  const [rootRealPath, targetRealPath] = await Promise.all([
    realpathIfPossible(resolved.containmentRoot),
    realpathNearestExisting(resolved.path),
  ]);
  if (!isPathWithinRoot(rootRealPath, targetRealPath)) {
    throw new Error(`Resolved path escapes the execution environment root: ${rawPath}`);
  }

  return targetRealPath;
}
