import {afterEach, describe, expect, it, vi} from "vitest";

import {
  BashTool,
  BraveSearchTool,
  BrowserTool,
  DateTimeContext,
  DEFAULT_AGENT_INSTRUCTIONS,
  EnvironmentContext,
  MediaTool,
  PostgresReadonlyQueryTool,
  WebFetchTool,
  WebResearchTool,
  WhisperTool,
} from "../src/index.js";
import {buildDefaultAgentTools, buildDefaultAgentToolsets} from "../src/panda/definition.js";
import {resolveStoredContext} from "../src/app/runtime/create-runtime.js";
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
    const tools = buildDefaultAgentTools();

    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("## Channels & Inner Monologue");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("No outbound call = no message delivered.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("Use `role=\"workspace\"` for read-only workspace inspection, file search, and local PDF/image/sketch inspection.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("Use `role=\"browser\"` for browser automation and website inspection.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("For quick one-shot reads, you may use `postgres_readonly_query` directly.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      "Foreground bash mutates the shared shell session. The working directory persists across foreground bash calls, and simple export/unset environment changes persist across foreground bash calls in both local and remote mode.",
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      "Stored credentials and values saved with `set_env_value` are injected into `bash` as normal environment variables.",
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      "Use normal shell expansion like `$API_KEY` or `$BASE_URL` inside bash commands. This is bash-only, not a guarantee that every tool can read those values.",
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("Background bash is isolated.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("Running background bash jobs may appear in context");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("the runtime may queue a machine-generated background event as external input on the next cycle");
    expect(tools).toHaveLength(3);
    expect(tools[0]).toBeInstanceOf(BashTool);
    expect(tools[1]).toBeInstanceOf(MediaTool);
    expect(tools[2]).toBeInstanceOf(WebFetchTool);
  });

  it("adds Brave search when BRAVE_API_KEY is configured", () => {
    vi.stubEnv("BRAVE_API_KEY", "BSA-test-key");
    vi.stubEnv("OPENAI_API_KEY", "");
    const tools = buildDefaultAgentTools();

    expect(tools).toHaveLength(4);
    expect(tools[3]).toBeInstanceOf(BraveSearchTool);
  });

  it("adds Whisper when OPENAI_API_KEY is configured", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const tools = buildDefaultAgentTools();

    expect(tools).toHaveLength(5);
    expect(tools[3]).toBeInstanceOf(WebResearchTool);
    expect(tools[4]).toBeInstanceOf(WhisperTool);
  });

  it("appends extra tools without adding hidden defaults", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const extraTool = { name: "extra-tool" } as any;
    const tools = buildDefaultAgentTools([extraTool]);

    expect(tools).toHaveLength(4);
    expect(tools[3]).toBe(extraTool);
  });

  it("builds explicit specialist toolsets and keeps workspace/browser tools off the main agent", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const toolsets = buildDefaultAgentToolsets({
      postgresReadonly: {
        pool: new FakeReadonlyPool(),
      },
    });

    expect(toolsets.main.map((tool) => tool.name)).toEqual([
      "bash",
      "view_media",
      "web_fetch",
      "postgres_readonly_query",
    ]);
    expect(toolsets.main.some((tool) => tool instanceof PostgresReadonlyQueryTool)).toBe(true);
    expect(toolsets.main.some((tool) => tool instanceof BrowserTool)).toBe(false);
    expect(toolsets.workspace.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
    ]);
    expect(toolsets.memory.map((tool) => tool.name)).toEqual([
      "postgres_readonly_query",
    ]);
    expect(toolsets.browser.map((tool) => tool.name)).toEqual([
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
      "browser",
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
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");

    expect(resolveRemoteInitialCwd("jozef")).toBeNull();

    vi.stubEnv("BASH_EXECUTION_MODE", "local");

    expect(resolveRemoteInitialCwd("jozef")).toBeNull();
  });

  it("lets remote setups override the default runner cwd template", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("RUNNER_CWD_TEMPLATE", "/workspace/agents/{agentKey}");

    expect(resolveRemoteInitialCwd("jozef")).toBe("/workspace/agents/jozef");
  });

  it("prefers the configured remote initial cwd when stored cwd is still the daemon fallback", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");

    expect(resolveStoredContext(
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
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("DATA_DIR", "/Users/patrikmojzis/.panda");

    expect(resolveStoredContext(
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
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("DATA_DIR", "/Users/patrikmojzis/.panda");

    expect(resolveStoredContext(
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
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");

    expect(resolveStoredContext(
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
