import {trimToUndefined} from "../../../lib/strings.js";

export const ACTIVE_PANDA_RUN_ENV = {
  agentKey: "PANDA_ACTIVE_AGENT_KEY",
  sessionId: "PANDA_ACTIVE_SESSION_ID",
  threadId: "PANDA_ACTIVE_THREAD_ID",
  runId: "PANDA_ACTIVE_RUN_ID",
} as const;

const ACTIVE_PANDA_RUN_ENV_KEYS = new Set<string>(Object.values(ACTIVE_PANDA_RUN_ENV));

export interface ActivePandaRunContext {
  agentKey: string;
  sessionId: string;
  threadId: string;
  runId: string;
}

function readRequiredActiveRunEnv(
  env: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = trimToUndefined(env[key]);
  if (!value) {
    throw new Error(
      `panda telegram react must be run from an active Panda agent bash run (missing ${key}).`,
    );
  }

  return value;
}

export function isActivePandaRunEnvKey(key: string): boolean {
  return ACTIVE_PANDA_RUN_ENV_KEYS.has(key);
}

export function readActivePandaRunContext(
  env: NodeJS.ProcessEnv = process.env,
): ActivePandaRunContext {
  return {
    agentKey: readRequiredActiveRunEnv(env, ACTIVE_PANDA_RUN_ENV.agentKey),
    sessionId: readRequiredActiveRunEnv(env, ACTIVE_PANDA_RUN_ENV.sessionId),
    threadId: readRequiredActiveRunEnv(env, ACTIVE_PANDA_RUN_ENV.threadId),
    runId: readRequiredActiveRunEnv(env, ACTIVE_PANDA_RUN_ENV.runId),
  };
}

export function buildActivePandaRunEnv(
  context: Partial<ActivePandaRunContext> | undefined,
): Record<string, string> {
  const agentKey = trimToUndefined(context?.agentKey);
  const sessionId = trimToUndefined(context?.sessionId);
  const threadId = trimToUndefined(context?.threadId);
  const runId = trimToUndefined(context?.runId);
  if (!agentKey || !sessionId || !threadId || !runId) {
    return {};
  }

  return {
    [ACTIVE_PANDA_RUN_ENV.agentKey]: agentKey,
    [ACTIVE_PANDA_RUN_ENV.sessionId]: sessionId,
    [ACTIVE_PANDA_RUN_ENV.threadId]: threadId,
    [ACTIVE_PANDA_RUN_ENV.runId]: runId,
  };
}
