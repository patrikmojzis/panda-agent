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
              toolPolicy: {allowedTools: ["bash", "read_file"]},
              createdAt: 1,
              updatedAt: 1,
            },
          ];
        },
        getEnvironment: async (environmentId: string) => {
          expect(environmentId).toBe("env-secret-vps");
          return {
            id: environmentId,
            agentKey: "panda",
            kind: "persistent_agent_runner",
            state: "ready",
            networkPolicy: "local_only",
            runnerUrl: "http://runner.internal:8080",
            metadata: {
              executionTarget: {
                description: "VPS shell with project checkout",
                capabilities: ["git", "docker", "secret token should not render"],
              },
            },
            createdAt: 1,
            updatedAt: 1,
          };
        },
      } as never,
    });

    const content = await contexts[0]!.getContent();

    expect(content).toContain("Available bash targets:\n- default: default session target\n- vps: VPS shell with project checkout; tools: bash, read_file; networkPolicy: local_only; capabilities: docker, git");
    expect(content).not.toContain("env-secret-vps");
    expect(content).not.toContain("http://");
    expect(content).not.toContain("runnerUrl");
    expect(content).not.toContain("secret token");
  });
});
