export const DEFAULT_CONTROL_PORT = 4767;
export const DEFAULT_CONTROL_HOST = "127.0.0.1";

export interface ControlServerBinding {
  enabled: true;
  host: string;
  port: number;
}

function readControlPort(value: string | undefined): number {
  if (!value) return DEFAULT_CONTROL_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("PANDA_CONTROL_PORT must be a positive integer.");
  return parsed;
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function resolveOptionalControlServerBinding(env: NodeJS.ProcessEnv = process.env): ControlServerBinding | null {
  if (!envFlagEnabled(env.PANDA_CONTROL_ENABLED)) return null;
  return {
    enabled: true,
    host: env.PANDA_CONTROL_HOST?.trim() || DEFAULT_CONTROL_HOST,
    port: readControlPort(env.PANDA_CONTROL_PORT),
  };
}
