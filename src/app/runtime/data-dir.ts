import os from "node:os";
import path from "node:path";
import {trimToNull} from "../../lib/strings.js";

function requireSafeAgentPathKey(agentKey: string): string {
  const trimmed = agentKey.trim();
  if (!trimmed || /[\\/]/.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`Unsafe agent key for filesystem path: ${agentKey}`);
  }

  return trimmed;
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = trimToNull(env.DATA_DIR);
  if (!configured) {
    return path.join(os.homedir(), ".panda");
  }

  if (configured === "~") {
    return os.homedir();
  }

  if (configured.startsWith("~/")) {
    return path.join(os.homedir(), configured.slice(2));
  }

  return path.resolve(configured);
}

export function resolveMediaDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDataDir(env), "media");
}

export function resolveAgentDir(agentKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDataDir(env), "agents", requireSafeAgentPathKey(agentKey));
}

export function resolveAgentMediaDir(agentKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveAgentDir(agentKey, env), "media");
}
