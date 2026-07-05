import {afterEach, describe, expect, it, vi} from "vitest";

import {
    Agent,
    BashTool,
    BrowserTool,
    DateTimeContext,
    DEFAULT_AGENT_INSTRUCTIONS,
    EnvironmentContext,
    MediaTool,
    RunContext,
    Tool,
    z,
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

function createBackgroundJobService(): BackgroundToolJobService {
  return new BackgroundToolJobService({
    store: new TestThreadRuntimeStore(),
  });
}

class ExtraTool extends Tool<typeof ExtraTool.schema> {
  static schema = z.object({});
  name = "extra";
  description = "Extra test tool.";
  schema = ExtraTool.schema;

  async handle() {
    return {content: [{type: "text" as const, text: "ok"}]};
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
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("Run `panda commands --json`");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("No send command means no message is delivered.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("`panda subagent spawn <task|@file|@-> [--profile <slug>] [--context @-]`");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("`profile=\"browser\"` for browser automation and website inspection.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("`profile=\"skill_maintainer\"` to distill reusable learning");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("use `panda postgres readonly query`");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("Load it with `panda skill load`.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("a reusable artifact was produced");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      "Use `panda skill set` for direct skill body edits you are intentionally making yourself.",
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      "Use `panda skill patch` when only an existing skill's injected short description should change.",
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      "**Foreground bash** shares one persistent shell session.",
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      "Values stored via `panda env set` are injected into bash as normal env vars",
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      "use `$API_KEY`, `$BASE_URL`, etc.",
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("**Background bash** is isolated.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("the runtime may inject a machine-generated event on the next cycle");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("If the current instruction says to run exact commands and stop, run only those commands and stop.");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain("Ask first before sending private material anywhere new");
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(
      'Do not leak sensitive details through "just a summary," paraphrase, excerpt, or forwarding the emotional gist.',
    );
    expect(tools).toHaveLength(3);
    expect(tools[0]).toBeInstanceOf(BashTool);
    expect(tools[1]).toBeInstanceOf(MediaTool);
    expect(tools[2]?.name).toBe("thinking_set");
  });

  it("exposes only core background controls on the native surface", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const jobService = createBackgroundJobService();
    const tools = buildDefaultAgentTools([], {
      bash: {
        jobService,
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "bash",
      "background_job_status",
      "background_job_wait",
      "background_job_cancel",
      "view_media",
      "thinking_set",
    ]);
  });

  it("does not expose optional command-backed tools on the main native surface", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const tools = buildDefaultAgentTools([], {
      bash: {
        jobService: createBackgroundJobService(),
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "bash",
      "background_job_status",
      "background_job_wait",
      "background_job_cancel",
      "view_media",
      "thinking_set",
    ]);
  });

  it("uses the configured background job service for background bash", async () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-1",
      sessionId: "session-main",
    });
    const jobService = new BackgroundToolJobService({store});
    const tools = buildDefaultAgentTools([], {
      bash: {
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

  it("keeps Brave search behind the CLI even when BRAVE_API_KEY is configured", () => {
    vi.stubEnv("BRAVE_API_KEY", "BSA-test-key");
    vi.stubEnv("OPENAI_API_KEY", "");
    const tools = buildDefaultAgentTools();

    expect(tools.map((tool) => tool.name)).toEqual(["bash", "view_media", "thinking_set"]);
  });

  it("keeps Whisper behind the CLI even when OPENAI_API_KEY is configured", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const tools = buildDefaultAgentTools();

    expect(tools.map((tool) => tool.name)).toEqual(["bash", "view_media", "thinking_set"]);
  });

  it("keeps web research behind the CLI even when OpenAI and background jobs are available", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const tools = buildDefaultAgentTools([], {
      bash: {
        jobService: createBackgroundJobService(),
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "bash",
      "background_job_status",
      "background_job_wait",
      "background_job_cancel",
      "view_media",
      "thinking_set",
    ]);
  });

  it("appends extra tools without adding hidden defaults", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const extraTool = new ExtraTool();
    const tools = buildDefaultAgentTools([extraTool]);

    expect(tools).toHaveLength(4);
    expect(tools[3]).toBe(extraTool);
  });

  it("builds explicit specialist toolsets and keeps workspace/browser tools off the main agent", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const toolsets = buildDefaultAgentToolsetsFromRegistry(createDefaultAgentToolRegistry());

    expect(toolsets.main.map((tool) => tool.name)).toEqual([
      "bash",
      "view_media",
      "thinking_set",
    ]);
    expect(toolsets.main.some((tool) => tool instanceof BrowserTool)).toBe(false);
    expect(toolsets.workspace.map((tool) => tool.name)).toEqual([
      "view_media",
    ]);
    expect(toolsets.memory.map((tool) => tool.name)).toEqual([]);
    expect(toolsets.browser.map((tool) => tool.name)).toEqual([
      "view_media",
      "browser",
    ]);
    expect(toolsets.worker.map((tool) => tool.name)).toEqual([
      "bash",
      "view_media",
      "browser",
      "thinking_set",
    ]);
    expect(toolsets.skill_maintainer.map((tool) => tool.name)).toEqual([
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
    vi.stubEnv("BASH_SERVER_CWD_TEMPLATE", "/workspace/agents/{agentKey}");

    expect(resolveRemoteInitialCwd("jozef")).toBe("/workspace/agents/jozef");
  });

  it("uses the configured remote initial cwd instead of fallback cwd", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("BASH_SERVER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");

    expect(resolveStoredContext(
      {
        cwd: "/Users/patrikmojzis/Projects/panda-agent",
      },
      "jozef",
    )).toMatchObject({
      cwd: "/root/.panda/agents/jozef",
    });
  });

  it("rewrites a host agent-home execution cwd to the remote runner path", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("BASH_SERVER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("DATA_DIR", "/Users/patrikmojzis/.panda");

    expect(resolveStoredContext(
      {
        cwd: "/Users/patrikmojzis/Projects/panda-agent",
      },
      "jozef",
      {
        initialCwd: "/Users/patrikmojzis/.panda/agents/jozef",
        kind: "persistent_agent_runner",
        source: "fallback",
      } as never,
    ).cwd).toBe("/root/.panda/agents/jozef");
  });

  it("rewrites nested host agent-home execution cwd suffixes to the remote runner path", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("BASH_SERVER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("DATA_DIR", "/Users/patrikmojzis/.panda");

    expect(resolveStoredContext(
      {
        cwd: "/Users/patrikmojzis/Projects/panda-agent",
      },
      "jozef",
      {
        initialCwd: "/Users/patrikmojzis/.panda/agents/jozef/projects/demo",
        kind: "persistent_agent_runner",
        source: "fallback",
      } as never,
    ).cwd).toBe("/root/.panda/agents/jozef/projects/demo");
  });

  it("hard-cuts arbitrary stored cwd by using the fallback or remote initial cwd", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("BASH_SERVER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");

    expect(resolveStoredContext(
      {
        cwd: "/workspace/shared/project",
      },
      "jozef",
    ).cwd).toBe("/root/.panda/agents/jozef");
  });
});
