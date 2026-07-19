import {afterEach, describe, expect, it, vi} from "vitest";

import {
  Agent,
  assertProviderName,
  ConfigurationError,
  parseProviderName,
  resolveModelSelector,
  resolveProviderApiKey,
  Thread,
} from "../src/index.js";
import {resolveProviderModel} from "../src/integrations/providers/shared/model.js";
import {resolveDefaultAgentModelSelector, resolveDefaultAgentSubagentModelSelector,} from "../src/panda/defaults.js";

describe("model selector", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses supported provider names", () => {
    expect(parseProviderName(" openai-codex ")).toBe("openai-codex");
    expect(parseProviderName(" kimi-coding ")).toBe("kimi-coding");
    expect(parseProviderName("open-ai")).toBeNull();
  });

  it("throws a configuration error for unsupported providers", () => {
    expect(() => assertProviderName("open-ai")).toThrowError(ConfigurationError);
    expect(() => assertProviderName("open-ai")).toThrowError(
      'Unsupported provider "open-ai". Expected one of `openai`, `openai-codex`, `anthropic`, `anthropic-oauth`, `kimi-coding`.',
    );
  });

  it("resolves canonical selectors and aliases", () => {
    expect(resolveModelSelector(" openai-codex/gpt-5.4 ")).toEqual({
      canonical: "openai-codex/gpt-5.4",
      providerName: "openai-codex",
      modelId: "gpt-5.4",
    });

    expect(resolveModelSelector("gpt")).toEqual({
      canonical: "openai-codex/gpt-5.5",
      providerName: "openai-codex",
      modelId: "gpt-5.5",
    });

    expect(resolveModelSelector("opus")).toEqual({
      canonical: "anthropic-oauth/claude-opus-4-7",
      providerName: "anthropic-oauth",
      modelId: "claude-opus-4-7",
    });
  });

  it("rejects bare raw model ids that are not aliases", () => {
    expect(() => resolveModelSelector("gpt-5.4")).toThrowError(ConfigurationError);
    expect(() => resolveModelSelector("gpt-5.4")).toThrowError(
      'Unknown model alias "gpt-5.4". Use a canonical selector like `provider/model` or one of `gpt`, `opus`.',
    );
  });

  it("fails fast instead of falling back to OpenAI", () => {
    expect(() => resolveModelSelector("open-ai/gpt-5.1")).toThrowError(ConfigurationError);
    expect(() => new Thread({
      agent: new Agent({
        name: "core",
        instructions: "Be helpful",
      }),
      model: "gpt-5.1",
    })).toThrowError(ConfigurationError);
  });

  it("resolves the default selector from DEFAULT_MODEL and auth heuristics", () => {
    expect(resolveDefaultAgentModelSelector({
      DEFAULT_MODEL: "gpt",
    })).toBe("openai-codex/gpt-5.5");

    expect(resolveDefaultAgentModelSelector({
      ANTHROPIC_AUTH_TOKEN: "anthropic-oauth-token",
      ANTHROPIC_MODEL: "claude-sonnet-4-7",
    })).toBe("anthropic-oauth/claude-sonnet-4-7");

    expect(resolveDefaultAgentModelSelector({
      OPENAI_OAUTH_TOKEN: "codex-oauth-token",
      OPENAI_CODEX_MODEL: "gpt-5.5",
    })).toBe("openai-codex/gpt-5.5");

    expect(resolveDefaultAgentModelSelector({
      ANTHROPIC_API_KEY: "anthropic-api-key",
      ANTHROPIC_MODEL: "claude-haiku-4-5",
      CODEX_HOME: "/tmp/panda-empty-codex-home",
    })).toBe("anthropic/claude-haiku-4-5");

    expect(resolveDefaultAgentModelSelector({
      KIMI_API_KEY: "kimi-api-key",
      KIMI_MODEL: "k3",
      CODEX_HOME: "/tmp/panda-empty-codex-home",
    })).toBe("kimi-coding/k3");
  });

  it("resolves Kimi Code membership auth", () => {
    expect(resolveProviderApiKey("kimi-coding", {KIMI_API_KEY: " kimi-api-key "})).toBe(
      "kimi-api-key",
    );
    expect(resolveProviderApiKey("kimi-coding", {})).toBeUndefined();
  });

  it("uses the environment default when a thread has no explicit model", () => {
    vi.stubEnv("DEFAULT_MODEL", "anthropic-oauth/claude-opus-4-7");

    const thread = new Thread({
      agent: new Agent({
        name: "core",
        instructions: "Be helpful",
      }),
    });

    expect(thread.model).toBe("anthropic-oauth/claude-opus-4-7");
  });

  it.each([
    ["workspace", "WORKSPACE_SUBAGENT_MODEL", "opus", "anthropic-oauth/claude-opus-4-7"],
    ["memory", "MEMORY_SUBAGENT_MODEL", "gpt", "openai-codex/gpt-5.5"],
    ["browser", "BROWSER_SUBAGENT_MODEL", "opus", "anthropic-oauth/claude-opus-4-7"],
    ["skill_maintainer", "SKILL_MAINTAINER_SUBAGENT_MODEL", "gpt", "openai-codex/gpt-5.5"],
  ] as const)("resolves the %s subagent selector from %s", (role, envKey, configured, expected) => {
    expect(resolveDefaultAgentSubagentModelSelector(role, {[envKey]: configured})).toBe(expected);
    expect(resolveDefaultAgentSubagentModelSelector(role, {})).toBeUndefined();
  });

  it.each([
    ["openai-codex", "gpt-5.6-luna"],
    ["openai-codex", "gpt-5.6-sol"],
    ["openai-codex", "gpt-5.6-terra"],
    ["openai", "gpt-5.6-luna"],
    ["openai", "gpt-5.6-sol"],
    ["openai", "gpt-5.6-terra"],
  ] as const)("resolves the pi-ai GPT-5.6 catalog model %s/%s", (providerName, modelId) => {
    expect(resolveModelSelector(`${providerName}/${modelId}`)).toEqual({
      canonical: `${providerName}/${modelId}`,
      providerName,
      modelId,
    });
    expect(resolveProviderModel(providerName, modelId)).toMatchObject({
      id: modelId,
      provider: providerName,
    });
  });

  it("resolves the pi-ai Kimi Code K3 catalog model", () => {
    expect(resolveModelSelector("kimi-coding/k3")).toEqual({
      canonical: "kimi-coding/k3",
      providerName: "kimi-coding",
      modelId: "k3",
    });
    expect(resolveProviderModel("kimi-coding", "k3")).toMatchObject({
      id: "k3",
      provider: "kimi-coding",
      api: "anthropic-messages",
      baseUrl: "https://api.kimi.com/coding",
      contextWindow: 1_048_576,
    });
  });

  it("throws a configuration error for unknown model ids", () => {
    expect(() => resolveProviderModel("openai", "gpt-not-real")).toThrowError(ConfigurationError);
    expect(() => resolveProviderModel("openai", "gpt-not-real")).toThrowError(
      'Unknown model "gpt-not-real" for provider "openai".',
    );
  });
});
