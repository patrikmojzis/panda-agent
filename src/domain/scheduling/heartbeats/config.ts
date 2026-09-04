export interface HeartbeatCadenceBounds {
  minEveryMinutes: number;
  maxEveryMinutes: number;
}

const MAX_HEARTBEAT_EVERY_MINUTES = 2_147_483_647;

function readMinutes(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  const minutes = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_HEARTBEAT_EVERY_MINUTES) {
    throw new Error(`${name} must be a positive integer no greater than ${MAX_HEARTBEAT_EVERY_MINUTES}.`);
  }
  return minutes;
}

export function resolveHeartbeatCadenceBounds(env: NodeJS.ProcessEnv): HeartbeatCadenceBounds {
  const minEveryMinutes = readMinutes(env, "PANDA_HEARTBEAT_MIN_EVERY_MINUTES", 15);
  const maxEveryMinutes = readMinutes(env, "PANDA_HEARTBEAT_MAX_EVERY_MINUTES", 1_440);
  if (minEveryMinutes > maxEveryMinutes) {
    throw new Error("PANDA_HEARTBEAT_MIN_EVERY_MINUTES must not exceed PANDA_HEARTBEAT_MAX_EVERY_MINUTES.");
  }
  return {minEveryMinutes, maxEveryMinutes};
}
