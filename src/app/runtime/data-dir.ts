import os from "node:os";
import path from "node:path";

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function requireSafeAgentPathKey(agentKey: string): string {
  const trimmed = agentKey.trim();
  if (!trimmed || /[\\/]/.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`Unsafe agent key for filesystem path: ${agentKey}`);
  }

  return trimmed;
}

export function resolvePandaDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = trimNonEmptyString(env.PANDA_DATA_DIR);
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

export function resolvePandaMediaDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePandaDataDir(env), "media");
}

export function resolvePandaAgentDir(agentKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePandaDataDir(env), "agents", requireSafeAgentPathKey(agentKey));
}

export function resolvePandaAgentMediaDir(agentKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePandaAgentDir(agentKey, env), "media");
}

export function resolvePandaSkillsDir(agentKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePandaAgentDir(agentKey, env), "skills");
}
