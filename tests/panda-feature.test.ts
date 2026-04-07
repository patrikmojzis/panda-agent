import { describe, expect, it } from "vitest";

import { BashTool, DateTimeContext, createPandaAgent } from "../src/index.js";

describe("Panda feature surface", () => {
  it("creates Panda agents with the bash tool enabled by default", () => {
    const agent = createPandaAgent();

    expect(agent.instructions).toContain("You are Panda, a personal assistant operating inside Panda.");
    expect(agent.tools[0]).toBeInstanceOf(BashTool);
  });

  it("renders the datetime context with the configured timezone", async () => {
    const context = new DateTimeContext({
      now: new Date("2026-04-06T10:30:00.000Z"),
      timeZone: "UTC",
      locale: "en-US",
    });

    await expect(context.getContent()).resolves.toContain("Timezone: UTC");
  });
});
