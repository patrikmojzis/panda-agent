import {constants} from "node:fs";
import {access, stat} from "node:fs/promises";
import path from "node:path";

import type {JsonObject} from "../../kernel/agent/types.js";

type BashSpawnScope = "local" | "remote";

export interface BashSpawnPreflightOptions {
  cwd: string;
  shell: string;
  scope: BashSpawnScope;
}

export interface BashSpawnPreflightFailure {
  message: string;
  details: JsonObject;
}

function buildMissingCwdMessage(scope: BashSpawnScope, cwd: string): string {
  if (scope === "remote") {
    return `Requested cwd does not exist inside the remote bash runner: ${cwd}. This usually means Panda is using a host path instead of a runner-visible path.`;
  }

  return `Requested cwd does not exist: ${cwd}`;
}

function buildNonDirectoryMessage(scope: BashSpawnScope, cwd: string): string {
  if (scope === "remote") {
    return `Requested cwd is not a directory inside the remote bash runner: ${cwd}`;
  }

  return `Requested cwd is not a directory: ${cwd}`;
}

function buildShellMessage(scope: BashSpawnScope, shell: string): string {
  if (scope === "remote") {
    return `Remote bash runner shell executable does not exist: ${shell}`;
  }

  return `Shell executable does not exist: ${shell}`;
}

export async function readBashSpawnPreflightFailure(
  options: BashSpawnPreflightOptions,
): Promise<BashSpawnPreflightFailure | null> {
  const resolvedCwd = path.resolve(options.cwd);

  try {
    const cwdStats = await stat(resolvedCwd);
    if (!cwdStats.isDirectory()) {
      return {
        message: buildNonDirectoryMessage(options.scope, resolvedCwd),
        details: {
          cwd: resolvedCwd,
          shell: options.shell,
          reason: "cwd_not_directory",
        },
      };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return {
        message: buildMissingCwdMessage(options.scope, resolvedCwd),
        details: {
          cwd: resolvedCwd,
          shell: options.shell,
          reason: "cwd_missing",
          ...(options.scope === "remote"
            ? {
              hint: "Use a cwd that exists inside the runner, such as /root/.panda/agents/{agentKey} or /workspace/shared/...",
            }
            : {}),
        },
      };
    }

    if (code === "EACCES") {
      return {
        message: `Permission denied while accessing cwd: ${resolvedCwd}`,
        details: {
          cwd: resolvedCwd,
          shell: options.shell,
          reason: "cwd_permission_denied",
        },
      };
    }

    throw error;
  }

  if (!path.isAbsolute(options.shell)) {
    return null;
  }

  try {
    await access(options.shell, constants.X_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return {
        message: buildShellMessage(options.scope, options.shell),
        details: {
          cwd: resolvedCwd,
          shell: options.shell,
          reason: "shell_missing",
        },
      };
    }

    if (code === "EACCES") {
      return {
        message: `Shell executable is not runnable: ${options.shell}`,
        details: {
          cwd: resolvedCwd,
          shell: options.shell,
          reason: "shell_not_executable",
        },
      };
    }

    throw error;
  }

  return null;
}
