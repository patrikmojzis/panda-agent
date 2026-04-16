import {afterEach, describe, expect, it, vi} from "vitest";

import {
    BashTool,
    BraveSearchTool,
    BrowserTool,
    DateTimeContext,
    EnvironmentContext,
    MediaTool,
    PANDA_PROMPT,
    PostgresReadonlyQueryTool,
    WebFetchTool,
    WebResearchTool,
    WhisperTool,
} from "../src/index.js";
import {buildPandaTools, buildPandaToolsets} from "../src/panda/definition.js";
import {resolveStoredPandaContext} from "../src/app/runtime/create-runtime.js";
import {resolveRemoteInitialCwd} from "../src/integrations/shell/bash-executor.js";

class FakeReadonlyPool {
  async connect(): Promise<never> {
    throw new Error("not used in toolset tests");
  }
}

describe("Panda feature surface", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the Panda prompt and default main tools", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const tools = buildPandaTools();

    expect(PANDA_PROMPT).toContain("## Soul");
    expect(PANDA_PROMPT).toContain("## Channels & Inner Monologue");
    expect(PANDA_PROMPT).toContain("No outbound call = no message delivered.");
    expect(PANDA_PROMPT).toContain("Use `role=\"explore\"` for read-only workspace inspection, file search, and local PDF/image/sketch inspection.");
    expect(PANDA_PROMPT).toContain("delegate that lookup to `memory_explorer` instead of guessing.");
    expect(PANDA_PROMPT).toContain(
      "Foreground bash mutates the shared shell session. The working directory persists across foreground bash calls, and simple export/unset environment changes persist across foreground bash calls in both local and remote mode.",
    );
    expect(PANDA_PROMPT).toContain("Background bash is isolated.");
    expect(PANDA_PROMPT).toContain("Running background bash jobs may appear in context");
    expect(PANDA_PROMPT).toContain("Panda may receive a runtime note about it");
    expect(tools).toHaveLength(4);
    expect(tools[0]).toBeInstanceOf(BashTool);
    expect(tools[1]).toBeInstanceOf(MediaTool);
    expect(tools[2]).toBeInstanceOf(WebFetchTool);
    expect(tools[3]).toBeInstanceOf(BrowserTool);
  });

  it("adds Brave search when BRAVE_API_KEY is configured", () => {
    vi.stubEnv("BRAVE_API_KEY", "BSA-test-key");
    vi.stubEnv("OPENAI_API_KEY", "");
    const tools = buildPandaTools();

    expect(tools).toHaveLength(5);
    expect(tools[4]).toBeInstanceOf(BraveSearchTool);
  });

  it("adds Whisper when OPENAI_API_KEY is configured", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const tools = buildPandaTools();

    expect(tools).toHaveLength(6);
    expect(tools[4]).toBeInstanceOf(WebResearchTool);
    expect(tools[5]).toBeInstanceOf(WhisperTool);
  });

  it("appends extra tools without adding hidden defaults", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const extraTool = { name: "extra-tool" } as any;
    const tools = buildPandaTools([extraTool]);

    expect(tools).toHaveLength(5);
    expect(tools[4]).toBe(extraTool);
  });

  it("builds explicit specialist toolsets and keeps readonly tools off the main agent", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const toolsets = buildPandaToolsets({
      postgresReadonly: {
        pool: new FakeReadonlyPool(),
      },
    });

    expect(toolsets.main.map((tool) => tool.name)).toEqual([
      "bash",
      "view_media",
      "web_fetch",
      "browser",
    ]);
    expect(toolsets.main.some((tool) => tool instanceof PostgresReadonlyQueryTool)).toBe(false);
    expect(toolsets.explore.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
    ]);
    expect(toolsets.memoryExplorer.map((tool) => tool.name)).toEqual([
      "postgres_readonly_query",
    ]);
  });

  it("renders the datetime context with the host timezone", async () => {
    const context = new DateTimeContext({
      now: new Date("2026-04-06T10:30:00.000Z"),
    });

    await expect(context.getContent()).resolves.toContain(
      `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"}`,
    );
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

    expect(resolveRemoteInitialCwd("jozef")).toBeNull();

    vi.stubEnv("PANDA_BASH_EXECUTION_MODE", "local");

    expect(resolveRemoteInitialCwd("jozef")).toBeNull();
  });

  it("lets remote setups override the default runner cwd template", () => {
    vi.stubEnv("PANDA_BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("PANDA_RUNNER_CWD_TEMPLATE", "/workspace/agents/{agentKey}");

    expect(resolveRemoteInitialCwd("jozef")).toBe("/workspace/agents/jozef");
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
      },
      "jozef",
    )).toMatchObject({
      cwd: "/root/.panda/agents/jozef",
    });
  });

  it("rewrites an explicit host agent-home cwd to the remote runner path", () => {
    vi.stubEnv("PANDA_BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("PANDA_RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("PANDA_DATA_DIR", "/Users/patrikmojzis/.panda");

    expect(resolveStoredPandaContext(
      {
        cwd: "/Users/patrikmojzis/.panda/agents/jozef",
      } as any,
      {
        cwd: "/Users/patrikmojzis/Projects/panda-agent",
      },
      "jozef",
    ).cwd).toBe("/root/.panda/agents/jozef");
  });

  it("rewrites nested host agent-home cwd suffixes to the remote runner path", () => {
    vi.stubEnv("PANDA_BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("PANDA_RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("PANDA_DATA_DIR", "/Users/patrikmojzis/.panda");

    expect(resolveStoredPandaContext(
      {
        cwd: "/Users/patrikmojzis/.panda/agents/jozef/projects/demo",
      } as any,
      {
        cwd: "/Users/patrikmojzis/Projects/panda-agent",
      },
      "jozef",
    ).cwd).toBe("/root/.panda/agents/jozef/projects/demo");
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
      },
      "jozef",
    ).cwd).toBe("/workspace/shared/project");
  });
});
