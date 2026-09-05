import {describe, expect, it} from "vitest";

import {buildDefaultAgentLlmContexts, type DefaultAgentSessionContext} from "../src/index.js";

const baseContext: DefaultAgentSessionContext = {
  agentKey: "panda",
  sessionId: "session-main",
  threadId: "thread-main",
  cwd: "/workspace",
};

describe("BashTargetsContext", () => {
  it("keeps storage declarations scoped to each named target", async () => {
    const contexts = buildDefaultAgentLlmContexts({
      context: {
        ...baseContext,
        executionEnvironment: {
          id: "fallback:panda",
          agentKey: "panda",
          kind: "persistent_agent_runner",
          state: "ready",
          executionMode: "remote",
          source: "fallback",
          credentialPolicy: {mode: "none"},
          skillPolicy: {mode: "none"},
          toolPolicy: {},
          persistentRoots: ["/default-only"],
        },
      },
      sections: ["bash_targets"],
      executionEnvironments: {
        listBindingsForSession: async () => ["vps", "unknown", "disposable"].map((alias) => ({
          sessionId: baseContext.sessionId!,
          environmentId: alias,
          alias,
          isDefault: false,
          credentialPolicy: {mode: "none" as const},
          skillPolicy: {mode: "none" as const},
          toolPolicy: {allowedTools: ["bash"]},
          createdAt: 1,
          updatedAt: 1,
        })),
        getEnvironment: async (id: string) => ({
          id,
          agentKey: "panda",
          kind: id === "disposable" ? "disposable_container" : "persistent_agent_runner",
          state: "ready",
          runnerCwd: `/target-${id}/project`,
          metadata: id === "unknown" ? undefined : {storage: {persistentRoots: [`/target-${id}`]}},
          createdAt: 1,
          updatedAt: 1,
        }),
      } as never,
    });

    const content = await contexts[0]!.getContent();

    expect(content).toContain('Storage for bash target "vps":\nInitial working directory: /target-vps/project\nDeclared persistent roots: /target-vps');
    expect(content).toContain('Storage for bash target "unknown":\nInitial working directory: /target-unknown/project\nPersistent roots: unspecified');
    expect(content).toContain('Storage for bash target "disposable":\nInitial working directory: /target-disposable/project\nPersistent roots: unspecified');
    expect(content).not.toContain("Declared persistent roots: /target-disposable");
    expect(content).not.toContain("/default-only");
  });

  it("exposes session-bound aliases without hiding token-shaped prose", async () => {
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
              toolPolicy: {allowedTools: ["bash", "view_media"]},
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
            runnerUrl: "http://runner.internal:8080",
            metadata: {
              executionTarget: {
                description: "VPS shell with project checkout",
                capabilities: ["git", "docker", "token-capable runner"],
              },
            },
            createdAt: 1,
            updatedAt: 1,
          };
        },
      } as never,
    });

    const content = await contexts[0]!.getContent();

    expect(content).toContain("Available bash targets:\n- default: default session target\n- vps: VPS shell with project checkout; tools: bash, view_media; capabilities: docker, git, token-capable runner");
    expect(content).not.toContain("env-secret-vps");
    expect(content).not.toContain("http://");
    expect(content).not.toContain("runnerUrl");
    expect(content).toContain("token-capable runner");
  });
});
