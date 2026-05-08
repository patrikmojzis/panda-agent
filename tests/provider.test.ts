import {afterEach, describe, expect, it, vi} from "vitest";

import {
    Agent,
    assertProviderName,
    ConfigurationError,
    parseProviderName,
    resolveModelSelector,
    Thread,
} from "../src/index.js";
import {resolveProviderModel} from "../src/integrations/providers/shared/model.js";
import {
    resolveDefaultAgentBrowserSubagentModelSelector,
    resolveDefaultAgentMemorySubagentModelSelector,
    resolveDefaultAgentModelSelector,
    resolveDefaultAgentWorkerModelSelector,
    resolveDefaultAgentWorkspaceSubagentModelSelector,
} from "../src/panda/defaults.js";

describe("model selector", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses supported provider names", () => {
    expect(parseProviderName(" openai-codex ")).toBe("openai-codex");
    expect(parseProviderName("open-ai")).toBeNull();
  });

  it("throws a configuration error for unsupported providers", () => {
    expect(() => assertProviderName("open-ai")).toThrowError(ConfigurationError);
    expect(() => assertProviderName("open-ai")).toThrowError(
      'Unsupported provider "open-ai". Expected one of `openai`, `openai-codex`, `anthropic`, `anthropic-oauth`.',
    );
  });

  it("resolves canonical selectors and aliases", () => {
    expect(resolveModelSelector(" openai-codex/gpt-5.4 ")).toEqual({
      canonical: "openai-codex/gpt-5.4",
      providerName: "openai-codex",
      modelId: "gpt-5.4",
    });

    expect(resolveModelSelector("gpt")).toEqual({
      canonical: "openai-codex/gpt-5.4",
      providerName: "openai-codex",
      modelId: "gpt-5.4",
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
    })).toBe("openai-codex/gpt-5.4");

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

  it("resolves the workspace subagent selector from WORKSPACE_SUBAGENT_MODEL", () => {
    expect(resolveDefaultAgentWorkspaceSubagentModelSelector({
      WORKSPACE_SUBAGENT_MODEL: "opus",
    })).toBe("anthropic-oauth/claude-opus-4-7");

    expect(resolveDefaultAgentWorkspaceSubagentModelSelector({})).toBeUndefined();
  });

  it("resolves the memory subagent selector from MEMORY_SUBAGENT_MODEL", () => {
    expect(resolveDefaultAgentMemorySubagentModelSelector({
      MEMORY_SUBAGENT_MODEL: "gpt",
    })).toBe("openai-codex/gpt-5.4");

    expect(resolveDefaultAgentMemorySubagentModelSelector({})).toBeUndefined();
  });

  it("resolves the browser subagent selector from BROWSER_SUBAGENT_MODEL", () => {
    expect(resolveDefaultAgentBrowserSubagentModelSelector({
      BROWSER_SUBAGENT_MODEL: "opus",
    })).toBe("anthropic-oauth/claude-opus-4-7");

    expect(resolveDefaultAgentBrowserSubagentModelSelector({})).toBeUndefined();
  });

  it("resolves the worker selector from WORKER_MODEL", () => {
    expect(resolveDefaultAgentWorkerModelSelector({
      WORKER_MODEL: "gpt",
    })).toBe("openai-codex/gpt-5.4");

    expect(resolveDefaultAgentWorkerModelSelector({})).toBeUndefined();
  });

  it("throws a configuration error for unknown model ids", () => {
    expect(() => resolveProviderModel("openai", "gpt-not-real")).toThrowError(ConfigurationError);
    expect(() => resolveProviderModel("openai", "gpt-not-real")).toThrowError(
      'Unknown model "gpt-not-real" for provider "openai".',
    );
  });
});
