import {describe, expect, it} from "vitest";

import {runLiveSmokeTest} from "../helpers/live-smoke.js";

describe("live panda smoke", () => {
  it("requires TEST_DATABASE_URL for live runs", () => {
    expect(process.env.TEST_DATABASE_URL?.trim()).toBeTruthy();
  });

  const hasSmokeDb = Boolean(process.env.TEST_DATABASE_URL?.trim());
  const liveIt = hasSmokeDb ? it : it.skip;

  liveIt("runs a basic headless smoke", async () => {
    const result = await runLiveSmokeTest({
      agentKey: "panda",
      expectText: ["banana"],
      inputs: ["Reply with the single word banana."],
    });

    expect(result.success).toBe(true);
  });
});
