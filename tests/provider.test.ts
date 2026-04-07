import { describe, expect, it } from "vitest";

import {
  Agent,
  ConfigurationError,
  Thread,
  assertProviderName,
  parseProviderName,
} from "../src/index.js";
import { resolvePandaModel } from "../src/features/agent-core/pi/model.js";

describe("provider guards", () => {
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

  it("fails fast instead of falling back to OpenAI", () => {
    expect(() => resolvePandaModel("open-ai" as never, "gpt-5.1")).toThrowError(ConfigurationError);

    expect(() => new Thread({
      agent: new Agent({
        name: "core",
        instructions: "Be helpful",
        model: "gpt-5.1",
      }),
      provider: "open-ai" as never,
    })).toThrowError(ConfigurationError);
  });
});
