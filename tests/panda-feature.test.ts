import {afterEach, describe, expect, it, vi} from "vitest";

import {
    BashTool,
    BraveSearchTool,
    DateTimeContext,
    EnvironmentContext,
    MediaTool,
    PANDA_PROMPT,
    WhisperTool,
} from "../src/index.js";
import {buildPandaTools} from "../src/features/panda/agent.js";
import {resolveStoredPandaContext} from "../src/features/panda/runtime.js";
import {resolveRemoteInitialCwd} from "../src/features/panda/tools/bash-executor.js";

describe("Panda feature surface", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the Panda prompt and default tools", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const tools = buildPandaTools();

    expect(PANDA_PROMPT).toContain("## Soul");
    expect(PANDA_PROMPT).toContain("## Channels & Inner Monologue");
    expect(PANDA_PROMPT).toContain("No outbound call = no message delivered.");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toBeInstanceOf(BashTool);
    expect(tools[1]).toBeInstanceOf(MediaTool);
  });

  it("adds Brave search when BRAVE_API_KEY is configured", () => {
    vi.stubEnv("BRAVE_API_KEY", "BSA-test-key");
    vi.stubEnv("OPENAI_API_KEY", "");
    const tools = buildPandaTools();

    expect(tools).toHaveLength(3);
    expect(tools[2]).toBeInstanceOf(BraveSearchTool);
  });

  it("adds Whisper when OPENAI_API_KEY is configured", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const tools = buildPandaTools();

    expect(tools).toHaveLength(3);
    expect(tools[2]).toBeInstanceOf(WhisperTool);
  });

  it("appends extra tools without adding hidden defaults", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const extraTool = { name: "extra-tool" } as any;
    const tools = buildPandaTools([extraTool]);

    expect(tools).toHaveLength(3);
    expect(tools[2]).toBe(extraTool);
  });

  it("renders the datetime context with the configured timezone", async () => {
    const context = new DateTimeContext({
      now: new Date("2026-04-06T10:30:00.000Z"),
      timeZone: "UTC",
    });

    await expect(context.getContent()).resolves.toContain("Timezone: UTC");
  });

  it("renders a compact environment overview", async () => {
    const context = new EnvironmentContext({
      cwd: "/workspace/panda",
      hostname: "panda-box",
      username: "patrik",
      shell: "/bin/zsh",
      terminalProgram: "Warp",
      platform: "darwin",
      release: "24.6.0",
      arch: "arm64",
      cpuModel: "Apple M4",
      cpuCount: 10,
      totalMemoryBytes: 16 * 1024 ** 3,
      nodeVersion: "v25.8.2",
    });

    await expect(context.getContent()).resolves.toBe(
      [
        "User: patrik @ panda-box",
        "OS: macOS 24.6.0 (arm64)",
        "Hardware: Apple M4 · 10 cores · 16 GB RAM",
        "Runtime: Node v25.8.2 · zsh · Warp",
        "Workspace: /workspace/panda",
      ].join("\n"),
    );
  });

  it("resolves a remote initial cwd only in remote mode", () => {
    vi.stubEnv("PANDA_BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("PANDA_RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");

    expect(resolveRemoteInitialCwd("jozef")).toBe("/root/.panda/agents/jozef");

    vi.stubEnv("PANDA_BASH_EXECUTION_MODE", "local");

    expect(resolveRemoteInitialCwd("jozef")).toBeNull();
  });

  it("prefers the configured remote initial cwd when stored cwd is still the daemon fallback", () => {
    vi.stubEnv("PANDA_BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("PANDA_RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");

    expect(resolveStoredPandaContext(
      {
        cwd: "/Users/patrikmojzis/Projects/panda-agent",
      } as any,
      {
        cwd: "/Users/patrikmojzis/Projects/panda-agent",
        identityId: "identity-1",
        identityHandle: "patrik",
      },
      "jozef",
    )).toMatchObject({
      cwd: "/root/.panda/agents/jozef",
      identityId: "identity-1",
      identityHandle: "patrik",
    });
  });

  it("preserves an explicit stored cwd in remote mode", () => {
    vi.stubEnv("PANDA_BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("PANDA_RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");

    expect(resolveStoredPandaContext(
      {
        cwd: "/workspace/shared/project",
      } as any,
      {
        cwd: "/Users/patrikmojzis/Projects/panda-agent",
        identityId: "identity-1",
        identityHandle: "patrik",
      },
      "jozef",
    ).cwd).toBe("/workspace/shared/project");
  });
});
