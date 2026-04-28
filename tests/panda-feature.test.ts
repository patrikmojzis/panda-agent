import {afterEach, describe, expect, it, vi} from "vitest";

import {
    Agent,
    BashTool,
    BraveSearchTool,
    BrowserTool,
    DateTimeContext,
    DEFAULT_AGENT_INSTRUCTIONS,
    EnvironmentContext,
    ImageGenerateTool,
    MediaTool,
    PostgresReadonlyQueryTool,
    RunContext,
    WebFetchTool,
    WebResearchTool,
    WhisperTool,
} from "../src/index.js";
import {
    buildDefaultAgentTools,
    buildDefaultAgentToolsetsFromRegistry,
    createDefaultAgentToolRegistry,
} from "../src/panda/definition.js";
import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import {resolveStoredContext} from "../src/app/runtime/create-runtime.js";
import {resolveRemoteInitialCwd} from "../src/integrations/shell/bash-executor.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

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

    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("<channels_vs_inner_monologue>");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("no outbound call = no message delivered.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("`role=\"workspace\"` for read-only workspace inspection, file search");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("`role=\"browser\"` for browser automation and website inspection");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("`role=\"skill_maintainer\"` to distill reusable learning");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("you may use `postgres_readonly_query` directly.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain('Load it with `agent_skill(operation="load")`.');
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("a reusable artifact was produced");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      'Use `agent_skill(operation="set")` for direct skill edits you are intentionally making yourself.',
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      "**Foreground bash** shares one persistent shell session.",
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      "Values stored via `set_env_value` are injected into bash as normal env vars",
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      "use `$API_KEY`, `$BASE_URL`, etc.",
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("**Background bash** is isolated.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("the runtime may inject a machine-generated event on the next cycle");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("Ask first before sending private material anywhere new");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      'Do not leak sensitive details through "just a summary," paraphrase, excerpt, or forwarding the emotional gist.',
    );
    expect(tools).toHaveLength(4);
    expect(tools[0]).toBeInstanceOf(BashTool);
    expect(tools[1]?.name).toBe("current_datetime");
    expect(tools[2]).toBeInstanceOf(MediaTool);
    expect(tools[3]).toBeInstanceOf(WebFetchTool);
  });

  it("adds image generation only when background jobs are available", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const jobService = {} as any;
    const tools = buildDefaultAgentTools([], {
      imageGenerate: {
        jobService,
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "bash",
      "background_job_status",
      "background_job_wait",
      "background_job_cancel",
      "current_datetime",
      "view_media",
      "image_generate",
      "web_fetch",
    ]);
    expect(tools[6]).toBeInstanceOf(ImageGenerateTool);
  });

  it("reuses the bash background job service for image generation", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const tools = buildDefaultAgentTools([], {
      bash: {
        jobService: {} as any,
      },
    });

    expect(tools.map((tool) => tool.name)).toContain("image_generate");
  });

  it("reuses the image generation background job service for background bash", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-1",
      sessionId: "session-main",
    });
    const jobService = new BackgroundToolJobService({store});
    const tools = buildDefaultAgentTools([], {
      imageGenerate: {
        jobService,
      },
    });
    const bash = tools.find((tool) => tool.name === "bash") as BashTool | undefined;
    expect(bash).toBeInstanceOf(BashTool);
    const agent = new Agent({
      name: "panda",
      instructions: "test",
      tools,
    });

    const started = await bash!.run({
      command: "printf ok",
      background: true,
    }, new RunContext({
      agent,
      turn: 1,
      maxTurns: 5,
      messages: [],
      context: {
        threadId: "thread-1",
        sessionId: "session-main",
        agentKey: "panda",
        cwd: process.cwd(),
      },
    })) as Record<string, unknown>;

    expect(started).toMatchObject({
      kind: "bash",
      status: "running",
    });
    const finished = await jobService.wait("thread-1", String(started.jobId), 1_000);
    expect(finished).toMatchObject({
      status: "completed",
      result: {
        stdout: "ok",
      },
    });
  });

  it("adds Brave search when BRAVE_API_KEY is configured", () => {
    vi.stubEnv("BRAVE_API_KEY", "BSA-test-key");
    vi.stubEnv("OPENAI_API_KEY", "");
    const tools = buildDefaultAgentTools();

    expect(tools).toHaveLength(5);
    expect(tools[4]).toBeInstanceOf(BraveSearchTool);
  });

  it("adds Whisper when OPENAI_API_KEY is configured", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const tools = buildDefaultAgentTools();

    expect(tools).toHaveLength(5);
    expect(tools[4]).toBeInstanceOf(WhisperTool);
  });

  it("adds web research only when OpenAI and background jobs are available", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const tools = buildDefaultAgentTools([], {
      bash: {
        jobService: {} as any,
      },
    });

    expect(tools.map((tool) => tool.name)).toContain("web_research");
    expect(tools.find((tool) => tool.name === "web_research")).toBeInstanceOf(WebResearchTool);
  });

  it("appends extra tools without adding hidden defaults", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const extraTool = { name: "extra-tool" } as any;
    const tools = buildDefaultAgentTools([extraTool]);

    expect(tools).toHaveLength(5);
    expect(tools[4]).toBe(extraTool);
  });

  it("builds explicit specialist toolsets and keeps workspace/browser tools off the main agent", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const toolsets = buildDefaultAgentToolsetsFromRegistry(createDefaultAgentToolRegistry({
      postgresReadonly: {
        pool: new FakeReadonlyPool(),
      },
    }));

    expect(toolsets.main.map((tool) => tool.name)).toEqual([
      "bash",
      "current_datetime",
      "view_media",
      "web_fetch",
      "postgres_readonly_query",
    ]);
    expect(toolsets.main.some((tool) => tool instanceof PostgresReadonlyQueryTool)).toBe(true);
    expect(toolsets.main.some((tool) => tool instanceof BrowserTool)).toBe(false);
    expect(toolsets.workspace.map((tool) => tool.name)).toEqual([
      "current_datetime",
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
    ]);
    expect(toolsets.memory.map((tool) => tool.name)).toEqual([
      "current_datetime",
      "postgres_readonly_query",
    ]);
    expect(toolsets.browser.map((tool) => tool.name)).toEqual([
      "current_datetime",
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
      "browser",
    ]);
    expect(toolsets.skill_maintainer.map((tool) => tool.name)).toEqual([
      "current_datetime",
      "postgres_readonly_query",
      "read_file",
      "glob_files",
      "grep_files",
      "view_media",
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
