export const A2A_SOURCE = "a2a";
export const A2A_CONNECTOR_KEY = "local";
export const DEFAULT_A2A_MAX_MESSAGES_PER_HOUR = 300;

export function resolveA2AMaxMessagesPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.A2A_MAX_MESSAGES_PER_HOUR?.trim();
  if (!raw) {
    return DEFAULT_A2A_MAX_MESSAGES_PER_HOUR;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_A2A_MAX_MESSAGES_PER_HOUR;
  }

  return parsed;
}
