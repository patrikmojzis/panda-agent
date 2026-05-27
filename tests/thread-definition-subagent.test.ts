import {describe, expect, it, vi} from "vitest";

import {createThreadDefinition} from "../src/app/runtime/create-runtime.js";
import type {ResolvedExecutionEnvironment} from "../src/domain/execution-environments/types.js";
import {buildSubagentSessionMetadata} from "../src/domain/subagents/index.js";
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
    id: "thread-subagent",
    sessionId: "session-subagent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createSubagentMetadata(overrides: Partial<Parameters<typeof buildSubagentSessionMetadata>[0]> = {}) {
  return buildSubagentSessionMetadata({
    role: "workspace",
    task: "Inspect files.",
    context: "Read-only please.",
    parentSessionId: "parent-session",
    execution: "agent_workspace",
    profile: {
      slug: "workspace",
      source: "builtin",
      description: "Workspace reader.",
      prompt: "PROFILE PROMPT ONLY",
      toolGroups: ["core", "workspace_read"],
      thinking: "medium",
      transcriptMode: "none",
    },
    resolved: {
      model: "openai/gpt-5.1",
      modelSource: "profile",
      thinking: "medium",
      credentialPolicy: {mode: "allowlist", envKeys: []},
      skillPolicy: {mode: "all_agent"},
      toolPolicy: {
        allowedTools: [
          "current_datetime",
          "message_agent",
          "agent_skill",
          "read_file",
          "bash",
          "postgres_readonly_query",
          "outbound",
          "wiki",
          "worker_spawn",
        ],
        agentSkill: {allowedOperations: ["load"]},
        postgresReadonly: {allowed: true},
        bash: {allowed: true},
      },
    },
    ...overrides,
  });
}

function createEnvironment(
  overrides: Partial<ResolvedExecutionEnvironment> = {},
): ResolvedExecutionEnvironment {
  return {
    id: "local:panda",
    agentKey: "panda",
    kind: "local",
    state: "ready",
    executionMode: "local",
    credentialPolicy: {mode: "allowlist", envKeys: []},
    skillPolicy: {mode: "all_agent"},
    toolPolicy: {
      allowedTools: ["current_datetime", "message_agent", "agent_skill", "read_file"],
      agentSkill: {allowedOperations: ["load"]},
    },
    source: "fallback",
    ...overrides,
  };
}

describe("subagent thread definitions", () => {
  it("uses snapshotted profile prompt and subagent runtime context", async () => {
    const readAgentPrompt = vi.fn(async () => {
      throw new Error("subagent context should not read agent prompts");
    });
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-subagent",
        agentKey: "panda",
        kind: "subagent",
        metadata: createSubagentMetadata(),
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
      executionEnvironment: createEnvironment(),
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
        ],
      },
      sessionStore: {
        listAgentSessions: async () => {
          throw new Error("subagent context should not list workers");
        },
        readSessionTodo: async () => null,
      },
    });

    const dump = await gatherContexts(definition.llmContexts ?? []);

    expect(definition.agent.instructions).toBe("PROFILE PROMPT ONLY");
    expect(definition.agent.instructions).not.toBe(DEFAULT_AGENT_INSTRUCTIONS);
    expect(definition.agent.instructions).not.toBe(DEFAULT_WORKER_INSTRUCTIONS);
    expect(definition.model).toBe("openai/gpt-5.1");
    expect(definition.thinking).toBe("medium");
    expect(readAgentPrompt).not.toHaveBeenCalled();
    expect(dump).toContain("**Subagent Runtime Context:**");
    expect(dump).toContain("role: workspace");
    expect(dump).toContain("task: Inspect files.");
    expect(dump).toContain("context: Read-only please.");
    expect(dump).toContain("parentSessionId: parent-session");
    expect(dump).toContain('message_agent({ sessionId: "parent-session" })');
    expect(dump).toContain("calendar\nUse for calendar work.");
    expect(dump).not.toContain("**Worker Runtime Context:**");
    expect(dump).not.toContain("**Workers:**");
    expect(dump).not.toContain("[agent]");
  });

  it("filters tools by subagent policy and always denies worker_spawn", () => {
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-subagent",
        agentKey: "panda",
        kind: "subagent",
        metadata: createSubagentMetadata(),
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
      executionEnvironment: createEnvironment({
        toolPolicy: {
          allowedTools: [
            "current_datetime",
            "message_agent",
            "agent_skill",
            "read_file",
            "bash",
            "postgres_readonly_query",
            "outbound",
            "wiki",
            "worker_spawn",
          ],
          agentSkill: {allowedOperations: ["load"]},
          postgresReadonly: {allowed: true},
          bash: {allowed: true},
        },
      }),
      tools: [
        new NamedTool("current_datetime"),
        new NamedTool("message_agent"),
        new NamedTool("agent_skill"),
        new NamedTool("read_file"),
        new NamedTool("bash"),
        new NamedTool("postgres_readonly_query"),
        new NamedTool("outbound"),
        new NamedTool("wiki"),
        new NamedTool("worker_spawn"),
        new NamedTool("environment_create"),
      ],
    });

    expect(definition.agent.tools.map((tool) => tool.name)).toEqual([
      "current_datetime",
      "message_agent",
      "agent_skill",
      "read_file",
      "bash",
      "postgres_readonly_query",
      "outbound",
      "wiki",
    ]);
  });

  it("keeps bash and readonly Postgres special deny checks", () => {
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-subagent",
        agentKey: "panda",
        kind: "subagent",
        metadata: createSubagentMetadata(),
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
      executionEnvironment: createEnvironment({
        toolPolicy: {
          allowedTools: ["bash", "postgres_readonly_query"],
          bash: {allowed: false},
        },
      }),
      tools: [
        new NamedTool("bash"),
        new NamedTool("postgres_readonly_query"),
      ],
    });

    expect(definition.agent.tools.map((tool) => tool.name)).toEqual([]);
  });

  it("fails closed for malformed subagent metadata", () => {
    expect(() => createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-subagent",
        agentKey: "panda",
        kind: "subagent",
        metadata: {
          subagent: {
            version: 99,
          },
        },
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
      executionEnvironment: createEnvironment(),
      tools: [],
    })).toThrow("Unsupported subagent metadata version 99.");
  });
});
