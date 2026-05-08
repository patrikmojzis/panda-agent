import {describe, expect, it, vi} from "vitest";

import {Agent, RunContext} from "../src/kernel/agent/index.js";
import type {DefaultAgentSessionContext} from "../src/app/runtime/panda-session-context.js";
import type {CreateWorkerSessionInput, CreateWorkerSessionResult} from "../src/app/runtime/worker-session-service.js";
import type {ExecutionEnvironmentRecord} from "../src/domain/execution-environments/index.js";
import type {SessionRecord} from "../src/domain/sessions/index.js";
import {WorkerSpawnTool, WorkerStopTool} from "../src/panda/tools/worker-tools.js";

function createRunContext(context: DefaultAgentSessionContext): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "panda",
      instructions: "Test",
    }),
    turn: 0,
    maxTurns: 5,
    messages: [],
    context,
  });
}

function createFilesystemMetadata(envDir = "worker-session") {
  return {
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
  };
}

function createWorkerSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "worker-session",
    agentKey: "panda",
    kind: "worker",
    currentThreadId: "worker-thread",
    metadata: {
      worker: {
        role: "research",
        parentSessionId: "parent-session",
      },
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function createEnvironment(overrides: Partial<ExecutionEnvironmentRecord> = {}): ExecutionEnvironmentRecord {
  return {
    id: "worker:worker-session",
    agentKey: "panda",
    kind: "disposable_container",
    state: "ready",
    runnerUrl: "http://worker:8080",
    runnerCwd: "/workspace",
    rootPath: "/workspace",
    createdBySessionId: "parent-session",
    createdForSessionId: "worker-session",
    metadata: createFilesystemMetadata(),
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

describe("worker control tools", () => {
  it("spawns workers with high default thinking, scoped allowlists, and parent-visible paths", async () => {
    const created: CreateWorkerSessionResult = {
      session: createWorkerSession(),
      thread: {
        id: "worker-thread",
        sessionId: "worker-session",
        context: {},
        createdAt: 1_000,
        updatedAt: 1_000,
      },
      environment: createEnvironment(),
      binding: {
        sessionId: "worker-session",
        environmentId: "worker:worker-session",
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
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    };
    const createWorkerSessionMock = vi.fn(async (_input: CreateWorkerSessionInput) => created);
    const tool = new WorkerSpawnTool({
      workerSessions: {
        createWorkerSession: createWorkerSessionMock,
      },
      env: {
        WORKER_MODEL: "gpt",
      } as NodeJS.ProcessEnv,
    });

    const result = await tool.run({
      role: "research",
      task: "Inspect docs.",
      credentialAllowlist: ["BRAVE_API_KEY"],
      skillAllowlist: ["debloater"],
      allowReadonlyPostgres: true,
    }, createRunContext({
      cwd: "/workspace/panda",
      agentKey: "panda",
      sessionId: "parent-session",
      threadId: "parent-thread",
      currentInput: {
        source: "tui",
        identityId: "identity-1",
      },
    }));

    expect(createWorkerSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: "panda",
      parentSessionId: "parent-session",
      createdByIdentityId: "identity-1",
      role: "research",
      task: "Inspect docs.",
      model: "openai-codex/gpt-5.4",
      thinking: "high",
      credentialAllowlist: ["BRAVE_API_KEY"],
      skillAllowlist: ["debloater"],
      toolPolicy: {
        bash: {allowed: true},
        postgresReadonly: {allowed: true},
      },
    }));
    expect(result).toMatchObject({
      status: "spawned",
      sessionId: "worker-session",
      threadId: "worker-thread",
      role: "research",
      environmentId: "worker:worker-session",
      paths: {
        root: "/environments/worker-session",
        workspace: "/environments/worker-session/workspace",
        inbox: "/environments/worker-session/inbox",
        artifacts: "/environments/worker-session/artifacts",
      },
    });
  });

  it("stops an owned worker environment and preserves file paths", async () => {
    const session = createWorkerSession();
    const environment = createEnvironment();
    const stopped = createEnvironment({
      state: "stopped",
      updatedAt: 3_000,
    });
    const stopEnvironment = vi.fn(async () => stopped);
    const tool = new WorkerStopTool({
      sessions: {
        getSession: async () => session,
      },
      environments: {
        getDefaultBinding: async () => ({
          sessionId: session.id,
          environmentId: environment.id,
          alias: "self",
          isDefault: true,
          credentialPolicy: {mode: "allowlist", envKeys: []},
          skillPolicy: {mode: "allowlist", skillKeys: []},
          toolPolicy: {},
          createdAt: 1_000,
          updatedAt: 1_000,
        }),
        getEnvironment: async () => environment,
      },
      lifecycle: {
        stopEnvironment,
      },
    });

    const result = await tool.run({
      sessionId: "worker-session",
    }, createRunContext({
      cwd: "/workspace/panda",
      agentKey: "panda",
      sessionId: "parent-session",
      threadId: "parent-thread",
    }));

    expect(stopEnvironment).toHaveBeenCalledWith("worker:worker-session");
    expect(result).toMatchObject({
      status: "stopped",
      sessionId: "worker-session",
      environmentId: "worker:worker-session",
      paths: {
        artifacts: "/environments/worker-session/artifacts",
      },
    });
  });

  it("rejects stopping a worker owned by another parent session", async () => {
    const tool = new WorkerStopTool({
      sessions: {
        getSession: async () => createWorkerSession({
          metadata: {
            worker: {
              role: "research",
              parentSessionId: "different-parent",
            },
          },
        }),
      },
      environments: {
        getDefaultBinding: async () => null,
        getEnvironment: async () => createEnvironment(),
      },
      lifecycle: {
        stopEnvironment: async () => createEnvironment({
          state: "stopped",
        }),
      },
    });

    await expect(tool.run({
      sessionId: "worker-session",
    }, createRunContext({
      cwd: "/workspace/panda",
      agentKey: "panda",
      sessionId: "parent-session",
      threadId: "parent-thread",
    }))).rejects.toThrow("is not owned by this session");
  });
});
