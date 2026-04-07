import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasAnthropicOauthToken,
  hasOpenAICodexOauthToken,
  resolveAnthropicAccessToken,
  resolveCodexHome,
  resolveOpenAICodexAuthFilePath,
  resolveOpenAICodexOauthToken,
} from "../src/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("auth helpers", () => {
  it("resolves OpenAI Codex OAuth tokens from OPENAI_OAUTH_TOKEN first", () => {
    expect(
      resolveOpenAICodexOauthToken({
        env: { OPENAI_OAUTH_TOKEN: " codex-token " },
      }),
    ).toBe("codex-token");
  });

  it("reads chatgpt login tokens from the Codex auth cache", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "panda-codex-auth-"));

    try {
      await fs.writeFile(
        path.join(tempDir, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: "cached-codex-token",
          },
        }),
      );

      const env = { CODEX_HOME: tempDir };
      expect(resolveCodexHome(env)).toBe(tempDir);
      expect(resolveOpenAICodexAuthFilePath(env)).toBe(path.join(tempDir, "auth.json"));
      expect(resolveOpenAICodexOauthToken({ env })).toBe("cached-codex-token");
      expect(hasOpenAICodexOauthToken({ env })).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves Anthropic OAuth tokens from the supported env vars", () => {
    expect(
      resolveAnthropicAccessToken({
        CLAUDE_CODE_OAUTH_TOKEN: " claude-token ",
      }),
    ).toBe("claude-token");

    expect(
      resolveAnthropicAccessToken({
        ANTHROPIC_AUTH_TOKEN: " anthropic-auth ",
      }),
    ).toBe("anthropic-auth");
  });

  it("reports whether Anthropic OAuth is configured", () => {
    expect(hasAnthropicOauthToken({ ANTHROPIC_OAUTH_TOKEN: "oauth-token" })).toBe(true);
    expect(hasAnthropicOauthToken({})).toBe(false);
  });
});
