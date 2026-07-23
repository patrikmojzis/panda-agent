export const DEFAULT_CONTROL_PORT = 4767;
export const DEFAULT_CONTROL_HOST = "127.0.0.1";

export interface ControlServerBinding {
  enabled: true;
  host: string;
  port: number;
  uiStaticDir?: string;
}

export function resolveControlPublicUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.PANDA_CONTROL_PUBLIC_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PANDA_CONTROL_PUBLIC_URL must be a valid absolute URL.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("PANDA_CONTROL_PUBLIC_URL must use HTTPS except on loopback hosts.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("PANDA_CONTROL_PUBLIC_URL must not contain userinfo, query, or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function buildControlMcpOAuthCallbackUrl(publicUrl: string): string {
  return `${publicUrl}/api/control/mcp/oauth/callback`;
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
    uiStaticDir: env.PANDA_CONTROL_UI_DIR?.trim() || undefined,
  };
}
