import {afterEach, describe, expect, it, vi} from "vitest";

import {
    BashTool,
    BraveSearchTool,
    DateTimeContext,
    EnvironmentContext,
    MediaTool,
    PANDA_PROMPT,
} from "../src/index.js";
import {buildPandaTools} from "../src/features/panda/agent.js";

describe("Panda feature surface", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the Panda prompt and default tools", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
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
    const tools = buildPandaTools();

    expect(tools).toHaveLength(3);
    expect(tools[2]).toBeInstanceOf(BraveSearchTool);
  });

  it("appends extra tools without adding hidden defaults", () => {
    vi.stubEnv("BRAVE_API_KEY", "");
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
});
