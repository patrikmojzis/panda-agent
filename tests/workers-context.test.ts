import {describe, expect, it} from "vitest";

import type {
  ExecutionEnvironmentRecord,
  SessionEnvironmentBindingRecord
} from "../src/domain/execution-environments/types.js";
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

function createBinding(
  sessionId: string,
  environmentId: string,
  overrides: Partial<SessionEnvironmentBindingRecord> = {},
): SessionEnvironmentBindingRecord {
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
    ...overrides,
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

  it("caps rendered workers per environment and summarizes older attached workers", async () => {
    const sessions = [
      createWorkerSession("worker-alpha", "parent-session"),
      createWorkerSession("worker-bravo", "parent-session"),
      createWorkerSession("worker-charlie", "parent-session"),
      createWorkerSession("worker-delta", "parent-session"),
      createWorkerSession("worker-echo", "parent-session"),
      createWorkerSession("worker-foreign", "other-parent"),
    ] satisfies SessionRecord[];
    const bindings = [
      createBinding("worker-alpha", "env-shared", {
        createdAt: NOW.getTime() - 5 * 60 * 1_000,
      }),
      createBinding("worker-bravo", "env-shared", {
        createdAt: NOW.getTime() - 4 * 60 * 1_000,
      }),
      createBinding("worker-charlie", "env-shared", {
        createdAt: NOW.getTime() - 3 * 60 * 1_000,
      }),
      createBinding("worker-delta", "env-shared", {
        createdAt: NOW.getTime() - 2 * 60 * 1_000,
      }),
      createBinding("worker-echo", "env-shared", {
        createdAt: NOW.getTime() - 1 * 60 * 1_000,
      }),
      createBinding("worker-foreign", "env-shared", {
        createdAt: NOW.getTime(),
      }),
    ];

    const context = new WorkersContext({
      sessions: {
        listAgentSessions: async () => sessions,
      },
      environments: {
        listDisposableEnvironmentsByOwner: async () => [createEnvironment("env-shared", "env-shared")],
        listBindingsForEnvironments: async () => bindings,
      },
      agentKey: "panda",
      parentSessionId: "parent-session",
      maxWorkersPerEnvironment: 3,
      now: NOW,
    });

    const rendered = await context.getContent();

    const echoIndex = rendered.indexOf("worker-echo");
    const deltaIndex = rendered.indexOf("worker-delta");
    const charlieIndex = rendered.indexOf("worker-charlie");
    const summaryIndex = rendered.indexOf("2 older workers omitted");
    expect(echoIndex).toBeGreaterThan(-1);
    expect(deltaIndex).toBeGreaterThan(echoIndex);
    expect(charlieIndex).toBeGreaterThan(deltaIndex);
    expect(summaryIndex).toBeGreaterThan(charlieIndex);
    expect(rendered).not.toContain("worker-alpha");
    expect(rendered).not.toContain("worker-bravo");
    expect(rendered).not.toContain("worker-foreign");
  });

  it("uses an eight-worker default cap", async () => {
    const workerIds = Array.from({length: 9}, (_, index) => `worker-${index + 1}`);
    const sessions = workerIds.map((workerId) => createWorkerSession(workerId, "parent-session"));
    const bindings = workerIds.map((workerId, index) => createBinding(workerId, "env-default-cap", {
      createdAt: NOW.getTime() - index * 60 * 1_000,
    }));

    const context = new WorkersContext({
      sessions: {
        listAgentSessions: async () => sessions,
      },
      environments: {
        listDisposableEnvironmentsByOwner: async () => [createEnvironment("env-default-cap", "env-default-cap")],
        listBindingsForEnvironments: async () => bindings,
      },
      agentKey: "panda",
      parentSessionId: "parent-session",
      now: NOW,
    });

    const rendered = await context.getContent();

    expect(rendered.match(/worker-\d role research/g)).toHaveLength(8);
    expect(rendered).toContain("1 older worker omitted");
    expect(rendered).not.toContain("worker-9");
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
