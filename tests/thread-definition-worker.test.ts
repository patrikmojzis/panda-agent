import {describe, expect, it, vi} from "vitest";

import {createThreadDefinition} from "../src/app/runtime/create-runtime.js";
import type {ResolvedExecutionEnvironment} from "../src/domain/execution-environments/index.js";
import type {ThreadRecord} from "../src/domain/threads/runtime/types.js";
import {DEFAULT_AGENT_INSTRUCTIONS} from "../src/prompts/runtime/default-agent.js";
import {DEFAULT_WORKER_INSTRUCTIONS} from "../src/prompts/runtime/worker.js";
import {gatherContexts, Tool, z} from "../src/index.js";

class NamedTool extends Tool<typeof NamedTool.schema> {
  static schema = z.object({});
  schema = NamedTool.schema;
  description = "Test tool";

  constructor(readonly name: string) {
    super();
  }

  async handle(): Promise<null> {
    return null;
  }
}

function createThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  const now = Date.now();
  return {
    id: "thread-worker",
    sessionId: "session-worker",
    context: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createEnvironment(
  overrides: Partial<ResolvedExecutionEnvironment> = {},
): ResolvedExecutionEnvironment {
  return {
    id: "worker:session-worker",
    agentKey: "panda",
    kind: "disposable_container",
    state: "ready",
    executionMode: "remote",
    runnerUrl: "http://worker:8080",
    initialCwd: "/workspace",
    credentialPolicy: {
      mode: "allowlist",
      envKeys: [],
    },
    skillPolicy: {
      mode: "allowlist",
      skillKeys: [],
    },
    toolPolicy: {},
    metadata: {
      filesystem: {
        envDir: "worker-session",
        root: {
          corePath: "/root/.panda/environments/panda/worker-session",
          parentRunnerPath: "/environments/worker-session",
        },
        workspace: {
          corePath: "/root/.panda/environments/panda/worker-session/workspace",
          workerPath: "/workspace",
        },
        inbox: {
          corePath: "/root/.panda/environments/panda/worker-session/inbox",
          workerPath: "/inbox",
        },
        artifacts: {
          corePath: "/root/.panda/environments/panda/worker-session/artifacts",
          workerPath: "/artifacts",
        },
      },
    },
    source: "binding",
    ...overrides,
  };
}

describe("worker thread definitions", () => {
  it("uses the worker base prompt only for worker sessions", () => {
    const main = createThreadDefinition({
      thread: createThread({
        sessionId: "session-main",
      }),
      session: {
        id: "session-main",
        agentKey: "panda",
        kind: "main",
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
    });
    const worker = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-worker",
        agentKey: "panda",
        kind: "worker",
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
      executionEnvironment: createEnvironment(),
      extraContext: {
        worker: {
          role: "research",
          task: "Inspect the package graph.",
          context: "Keep it read-only.",
          parentSessionId: "parent-session",
        },
      },
    });

    expect(main.agent.instructions).toBe(DEFAULT_AGENT_INSTRUCTIONS);
    expect(worker.agent.instructions).toBe(DEFAULT_WORKER_INSTRUCTIONS);
    expect(worker.agent.instructions).not.toBe(DEFAULT_AGENT_INSTRUCTIONS);
    expect(worker.agent.instructions).toContain("<process_notes>");
  });

  it("filters worker tools through the execution environment allowlist", () => {
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-worker",
        agentKey: "panda",
        kind: "worker",
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
      executionEnvironment: createEnvironment({
        toolPolicy: {
          allowedTools: [
            "bash",
            "message_agent",
            "agent_prompt",
            "postgres_readonly_query",
            "worker_spawn",
            "environment_create",
            "environment_stop",
          ],
        },
      }),
      tools: [
        new NamedTool("bash"),
        new NamedTool("message_agent"),
        new NamedTool("agent_prompt"),
        new NamedTool("postgres_readonly_query"),
        new NamedTool("worker_spawn"),
        new NamedTool("environment_create"),
        new NamedTool("environment_stop"),
        new NamedTool("wiki"),
      ],
    });

    expect(definition.agent.tools.map((tool) => tool.name)).toEqual([
      "bash",
      "message_agent",
      "agent_prompt",
    ]);
  });

  it("includes browser in the default worker tool allowlist", () => {
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-worker",
        agentKey: "panda",
        kind: "worker",
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
      executionEnvironment: createEnvironment(),
      tools: [
        new NamedTool("bash"),
        new NamedTool("browser"),
        new NamedTool("wiki"),
      ],
    });

    expect(definition.agent.tools.map((tool) => tool.name)).toEqual([
      "bash",
      "browser",
    ]);
  });

  it("keeps postgres readonly and bash special policy checks", () => {
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-worker",
        agentKey: "panda",
        kind: "worker",
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
      executionEnvironment: createEnvironment({
        toolPolicy: {
          allowedTools: ["bash", "postgres_readonly_query"],
          bash: {allowed: false},
          postgresReadonly: {allowed: true},
        },
      }),
      tools: [
        new NamedTool("bash"),
        new NamedTool("postgres_readonly_query"),
      ],
    });

    expect(definition.agent.tools.map((tool) => tool.name)).toEqual([
      "postgres_readonly_query",
    ]);
  });

  it("renders durable worker runtime context and allowed skill summaries", async () => {
    const readAgentPrompt = vi.fn(async () => {
      throw new Error("worker context should not read agent prompts");
    });
    const definition = createThreadDefinition({
      thread: createThread({
        context: {
          worker: {
            role: "research",
            task: "Inspect the package graph.",
            context: "Keep it read-only.",
            parentSessionId: "parent-session",
          },
        },
      }),
      session: {
        id: "session-worker",
        agentKey: "panda",
        kind: "worker",
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
      executionEnvironment: createEnvironment({
        skillPolicy: {
          mode: "allowlist",
          skillKeys: ["calendar"],
        },
      }),
      agentStore: {
        readAgentPrompt,
        listAgentSkills: async () => [
          {
            agentKey: "panda",
            skillKey: "calendar",
            description: "Use for calendar work.",
            content: "# Calendar",
            loadCount: 0,
            createdAt: 1_000,
            updatedAt: 1_000,
          },
          {
            agentKey: "panda",
            skillKey: "finance",
            description: "Use for finance work.",
            content: "# Finance",
            loadCount: 0,
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
      } as any,
    });

    const dump = await gatherContexts(definition.llmContexts ?? []);

    expect(readAgentPrompt).not.toHaveBeenCalled();
    expect(dump).toContain("**Worker Runtime Context:**");
    expect(dump).toContain("role: research");
    expect(dump).toContain("task: Inspect the package graph.");
    expect(dump).toContain("context: Keep it read-only.");
    expect(dump).toContain("parentSessionId: parent-session");
    expect(dump).toContain('message_agent({ sessionId: "parent-session" })');
    expect(dump).toContain("workspace: /workspace");
    expect(dump).toContain("inbox: /inbox");
    expect(dump).toContain("artifacts: /artifacts");
    expect(dump).toContain("parent-visible root: /environments/worker-session");
    expect(dump).toContain("load every allowed skill");
    expect(dump).toContain("**Environment Overview:**");
    expect(dump).toContain("calendar\nUse for calendar work.");
    expect(dump).not.toContain("finance\nUse for finance work.");
    expect(dump).not.toContain("[agent]");
    expect(dump).not.toContain("**Wiki Overview:**");
    expect(dump).not.toContain("**Workers:**");
  });
});
