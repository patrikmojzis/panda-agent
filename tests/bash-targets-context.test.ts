import {describe, expect, it} from "vitest";

import {buildDefaultAgentLlmContexts, type DefaultAgentSessionContext} from "../src/index.js";

const baseContext: DefaultAgentSessionContext = {
  agentKey: "panda",
  sessionId: "session-main",
  threadId: "thread-main",
  cwd: "/workspace",
};

describe("BashTargetsContext", () => {
  it("exposes only safe session-bound aliases to the model", async () => {
    const contexts = buildDefaultAgentLlmContexts({
      context: baseContext,
      sections: ["bash_targets"],
      executionEnvironments: {
        listBindingsForSession: async (sessionId: string) => {
          expect(sessionId).toBe("session-main");
          return [
            {
              sessionId,
              environmentId: "env-secret-vps",
              alias: "vps",
              isDefault: false,
              credentialPolicy: {mode: "none"},
              skillPolicy: {mode: "none"},
              toolPolicy: {},
              createdAt: 1,
              updatedAt: 1,
            },
          ];
        },
      } as never,
    });

    const content = await contexts[0]!.getContent();

    expect(content).toBe("Available bash targets: default, vps");
    expect(content).not.toContain("env-secret-vps");
    expect(content).not.toContain("http://");
    expect(content).not.toContain("runnerUrl");
  });
});
