import type { ProviderName } from "../agent-core/types.js";

export type PandaProviderName = ProviderName;

export interface PandaShellSession {
  cwd: string;
  env: Record<string, string>;
}

export interface PandaSessionContext {
  cwd?: string;
  shell?: PandaShellSession;
  locale?: string;
  timezone?: string;
}
