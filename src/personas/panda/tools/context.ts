import path from "node:path";

import {mapRunnerAgentPathToHost} from "../../../integrations/shell/path-mapping.js";
import type {ShellSession} from "../../../integrations/shell/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function readContextAgentKey(context: unknown): string | null {
  if (!isRecord(context)) {
    return null;
  }

  return trimNonEmptyString(context.agentKey);
}

function resolveMountedAgentPath(
  resolvedPath: string,
  context: unknown,
  env: NodeJS.ProcessEnv,
): string {
  const agentKey = readContextAgentKey(context);
  if (!agentKey) {
    return resolvedPath;
  }

  // Remote bash sees the agent home through the runner mount, but file tools
  // still run in panda-core and need the host-visible mirror path.
  return mapRunnerAgentPathToHost(resolvedPath, agentKey, env);
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

export function readPandaBaseCwd(context: unknown): string {
  if (isRecord(context)) {
    const shell = context.shell;
    if (isRecord(shell) && typeof shell.cwd === "string" && shell.cwd.trim()) {
      return path.resolve(shell.cwd);
    }

    if (typeof context.cwd === "string" && context.cwd.trim()) {
      return path.resolve(context.cwd);
    }
  }

  return process.cwd();
}

export function ensurePandaShellSession(context: unknown): ShellSession | null {
  if (!isRecord(context)) {
    return null;
  }

  const shell = context.shell;
  if (isRecord(shell) && typeof shell.cwd === "string") {
    return normalizeShellSession(shell as unknown as ShellSession);
  }

  const nextShell: ShellSession = {
    cwd: readPandaBaseCwd(context),
    env: {},
  };

  context.shell = nextShell;
  return nextShell;
}

export function readPandaCurrentInputIdentityId(context: unknown): string | undefined {
  if (!isRecord(context)) {
    return undefined;
  }

  const currentInput = context.currentInput;
  if (!isRecord(currentInput)) {
    return undefined;
  }

  return trimNonEmptyString(currentInput.identityId) ?? undefined;
}

export function resolvePandaPath(
  rawPath: string,
  context: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolvedPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(readPandaBaseCwd(context), rawPath);

  return resolveMountedAgentPath(resolvedPath, context, env);
}
