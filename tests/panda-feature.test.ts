import { describe, expect, it } from "vitest";

import { BashTool, DateTimeContext, EnvironmentContext, MediaTool, buildPandaPrompt } from "../src/index.js";
import { buildPandaTools } from "../src/features/panda/agent.js";

describe("Panda feature surface", () => {
  it("builds the Panda prompt and default tools", () => {
    const tools = buildPandaTools();

    expect(buildPandaPrompt()).toContain("Your name is Panda.");
    expect(tools[0]).toBeInstanceOf(BashTool);
    expect(tools[1]).toBeInstanceOf(MediaTool);
  });

  it("renders the datetime context with the configured timezone", async () => {
    const context = new DateTimeContext({
      now: new Date("2026-04-06T10:30:00.000Z"),
      timeZone: "UTC",
      locale: "en-US",
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
