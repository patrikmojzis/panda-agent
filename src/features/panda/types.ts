export type PandaProviderName = "openai" | "openai-codex" | "anthropic" | "anthropic-oauth";

export interface PandaSessionContext {
  cwd?: string;
  locale?: string;
  timezone?: string;
}
