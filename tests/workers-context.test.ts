import {describe, expect, it} from "vitest";

import type {
  ExecutionEnvironmentRecord,
  SessionEnvironmentBindingRecord
} from "../src/domain/execution-environments/index.js";
import type {SessionRecord} from "../src/domain/sessions/index.js";
import {WorkersContext} from "../src/panda/contexts/workers-context.js";

const NOW = new Date("2026-05-08T12:00:00.000Z");

function createWorkerSession(
  id: string,
  parentSessionId: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    agentKey: "panda",
    kind: "worker",
    currentThreadId: `${id}-thread`,
    metadata: {
      worker: {
        role: "research",
        parentSessionId,
      },
    },
    createdAt: NOW.getTime() - 15 * 60 * 1_000,
    updatedAt: NOW.getTime() - 15 * 60 * 1_000,
    ...overrides,
  };
}

function createBinding(sessionId: string, environmentId: string): SessionEnvironmentBindingRecord {
  return {
    sessionId,
    environmentId,
    alias: "self",
    isDefault: true,
    credentialPolicy: {
      mode: "allowlist",
      envKeys: [],
    },
    skillPolicy: {
      mode: "allowlist",
      skillKeys: [],
    },
    toolPolicy: {},
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
  };
}

function createEnvironment(
  id: string,
  envDir: string,
  overrides: Partial<ExecutionEnvironmentRecord> = {},
): ExecutionEnvironmentRecord {
  return {
    id,
    agentKey: "panda",
    kind: "disposable_container",
    state: "ready",
    runnerUrl: `http://${id}:8080`,
    runnerCwd: "/workspace",
    rootPath: "/workspace",
    createdBySessionId: "parent-session",
    createdForSessionId: envDir,
    metadata: {
      filesystem: {
        envDir,
        root: {
          corePath: `/root/.panda/environments/panda/${envDir}`,
          parentRunnerPath: `/environments/${envDir}`,
        },
        workspace: {
          corePath: `/root/.panda/environments/panda/${envDir}/workspace`,
          parentRunnerPath: `/environments/${envDir}/workspace`,
          workerPath: "/workspace",
        },
        inbox: {
          corePath: `/root/.panda/environments/panda/${envDir}/inbox`,
          parentRunnerPath: `/environments/${envDir}/inbox`,
          workerPath: "/inbox",
        },
        artifacts: {
          corePath: `/root/.panda/environments/panda/${envDir}/artifacts`,
          parentRunnerPath: `/environments/${envDir}/artifacts`,
          workerPath: "/artifacts",
        },
      },
    },
    createdAt: NOW.getTime() - 15 * 60 * 1_000,
    updatedAt: NOW.getTime() - 10 * 60 * 1_000,
    ...overrides,
  };
}

describe("WorkersContext", () => {
  it("renders only workers owned by the current parent session", async () => {
    const sessions = [
      {
        id: "main-session",
        agentKey: "panda",
        kind: "main",
        currentThreadId: "main-thread",
        createdAt: NOW.getTime(),
        updatedAt: NOW.getTime(),
      },
      createWorkerSession("worker-a", "parent-session"),
      createWorkerSession("worker-b", "other-parent"),
    ] satisfies SessionRecord[];
    const bindings = new Map([
      ["worker-a", createBinding("worker-a", "env-a")],
      ["worker-b", createBinding("worker-b", "env-b")],
    ]);
    const environments = new Map([
      ["env-a", createEnvironment("env-a", "worker-a")],
      ["env-b", createEnvironment("env-b", "worker-b")],
    ]);

    const context = new WorkersContext({
      sessions: {
        listAgentSessions: async () => sessions,
      },
      environments: {
        listDisposableEnvironmentsByOwner: async () => [environments.get("env-a")!],
        listBindingsForEnvironments: async () => [...bindings.values()],
      },
      agentKey: "panda",
      parentSessionId: "parent-session",
      now: NOW,
    });

    const rendered = await context.getContent();

    expect(rendered).toContain("Worker environments owned by this session:");
    expect(rendered).toContain("worker-a");
    expect(rendered).toContain("env-a");
    expect(rendered).toContain("started 2026-05-08T11:45:00.000Z");
    expect(rendered).toContain("updated 2026-05-08T11:50:00.000Z");
    expect(rendered).not.toContain("age ");
    expect(rendered).not.toContain("expiresAt");
    expect(rendered).toContain("workspace /environments/worker-a/workspace");
    expect(rendered).toContain("artifacts /environments/worker-a/artifacts");
    expect(rendered).not.toContain("worker-b");
    expect(rendered).not.toContain("main-session");
  });

  it("keeps recently stopped workers visible and drops old stopped workers", async () => {
    const sessions = [
      createWorkerSession("worker-recent", "parent-session"),
      createWorkerSession("worker-old", "parent-session"),
    ] satisfies SessionRecord[];
    const bindings = new Map([
      ["worker-recent", createBinding("worker-recent", "env-recent")],
      ["worker-old", createBinding("worker-old", "env-old")],
    ]);
    const environments = new Map([
      ["env-recent", createEnvironment("env-recent", "worker-recent", {
        state: "stopped",
        updatedAt: NOW.getTime() - 30 * 60 * 1_000,
      })],
      ["env-old", createEnvironment("env-old", "worker-old", {
        state: "stopped",
        updatedAt: NOW.getTime() - 2 * 60 * 60 * 1_000,
      })],
    ]);

    const context = new WorkersContext({
      sessions: {
        listAgentSessions: async () => sessions,
      },
      environments: {
        listDisposableEnvironmentsByOwner: async () => [...environments.values()],
        listBindingsForEnvironments: async () => [...bindings.values()],
      },
      agentKey: "panda",
      parentSessionId: "parent-session",
      now: NOW,
    });

    const rendered = await context.getContent();

    expect(rendered).toContain("worker-recent");
    expect(rendered).toContain("state stopped");
    expect(rendered).not.toContain("worker-old");
  });

  it("renders parent-owned environments even when no worker is attached", async () => {
    const context = new WorkersContext({
      sessions: {
        listAgentSessions: async () => [],
      },
      environments: {
        listDisposableEnvironmentsByOwner: async () => [
          createEnvironment("env-empty", "env-empty", {
            createdForSessionId: undefined,
          }),
        ],
        listBindingsForEnvironments: async () => [],
      },
      agentKey: "panda",
      parentSessionId: "parent-session",
      now: NOW,
    });

    const rendered = await context.getContent();

    expect(rendered).toContain("env-empty");
    expect(rendered).toContain("workers none");
  });
});
