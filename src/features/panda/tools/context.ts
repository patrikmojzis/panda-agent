import path from "node:path";

import type { PandaSessionContext, PandaShellSession } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeShellSession(shellSession: PandaShellSession): PandaShellSession {
  shellSession.cwd = path.resolve(shellSession.cwd);

  if (!isRecord(shellSession.env)) {
    shellSession.env = {};
    return shellSession;
  }

  for (const [key, value] of Object.entries(shellSession.env)) {
    if (typeof value !== "string") {
      delete shellSession.env[key];
    }
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

export function ensurePandaShellSession(context: unknown): PandaShellSession | null {
  if (!isRecord(context)) {
    return null;
  }

  const shell = context.shell;
  if (isRecord(shell) && typeof shell.cwd === "string") {
    return normalizeShellSession(shell as unknown as PandaShellSession);
  }

  const nextShell: PandaShellSession = {
    cwd: readPandaBaseCwd(context),
    env: {},
  };

  context.shell = nextShell;
  return nextShell;
}

export function resolvePandaPath(rawPath: string, context: unknown): string {
  return path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(readPandaBaseCwd(context), rawPath);
}
