import { describe, expect, it } from "vitest";

import { BashTool, DateTimeContext, EnvironmentContext, MediaTool, createPandaAgent } from "../src/index.js";

describe("Panda feature surface", () => {
  it("creates Panda agents with the bash tool enabled by default", () => {
    const agent = createPandaAgent();

    expect(agent.instructions).toContain("You are Panda, a personal assistant operating inside Panda.");
    expect(agent.tools[0]).toBeInstanceOf(BashTool);
    expect(agent.tools[1]).toBeInstanceOf(MediaTool);
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
