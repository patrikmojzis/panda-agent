import {describe, expect, it} from "vitest";

import {hasAnthropicOauthToken, hasOpenAICodexOauthToken} from "../../src/index.js";
import {runLiveSmokeTest} from "../helpers/live-smoke.js";

describe("live prompt credential guidance", () => {
  const hasSmokeDb = Boolean(process.env.TEST_DATABASE_URL?.trim());
  const hasLiveAuth = Boolean(
    process.env.OPENAI_API_KEY?.trim()
    || process.env.ANTHROPIC_API_KEY?.trim()
    || hasOpenAICodexOauthToken()
    || hasAnthropicOauthToken(),
  );
  const liveIt = hasSmokeDb && hasLiveAuth ? it : it.skip;

  liveIt("understands that stored credentials are usable from bash via normal shell expansion", async () => {
    const result = await runLiveSmokeTest({
      agentKey: "panda",
      expectText: ["yes", "bash-only"],
      inputs: [
        [
          "If OURA_API_TOKEN and OURA_API_BASE are stored in your credentials, can you run this in bash?",
          "",
          'curl -s -H "Authorization: Bearer $OURA_API_TOKEN" "$OURA_API_BASE/usercollection/daily_sleep?start_date=2026-04-01"',
          "",
          "Answer in exactly two short sentences.",
          "Say yes or no plainly in the first sentence.",
          "Include the exact phrase bash-only in the second sentence if that limitation matters.",
        ].join("\n"),
      ],
    });

    expect(result.success).toBe(true);
  });
});
