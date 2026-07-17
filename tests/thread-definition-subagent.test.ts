import {describe, expect, it} from "vitest";

import {createThreadDefinition} from "../src/app/runtime/create-runtime.js";
import type {CommandDescriptor} from "../src/domain/commands/index.js";
import type {ResolvedExecutionEnvironment} from "../src/domain/execution-environments/types.js";
import {buildSubagentSessionMetadata, readSubagentSessionMetadata} from "../src/domain/subagents/index.js";
import type {ThreadRecord} from "../src/domain/threads/runtime/types.js";
import {DEFAULT_AGENT_INSTRUCTIONS} from "../src/prompts/runtime/default-agent.js";
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

const customCommandDescriptor: CommandDescriptor = {
  name: "custom.inspect",
  summary: "Inspect a custom extension.",
  description: "Inspect a custom extension.",
  usage: "panda custom inspect <target>",
  inputModes: ["flags", "json"],
  outputModes: ["json"],
  arguments: [],
  examples: [],
};

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
      toolGroups: ["core"],
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
          "bash",
          "background_job_status",
          "background_job_wait",
          "background_job_cancel",
          "a2a.send",
          "a2a.inspect",
          "a2a.history",
          "skill.load",
          "postgres.readonly.query",
          "wiki.read",
          ["worker", "spawn"].join("_"),
          "spawn_subagent",
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
      allowedTools: ["bash", "a2a.send", "a2a.inspect", "a2a.history", "skill.load"],
      agentSkill: {allowedOperations: ["load"]},
    },
    source: "fallback",
    ...overrides,
  };
}

describe("subagent thread definitions", () => {
  it("uses supplied command descriptors in the thread command catalog", async () => {
    const definition = createThreadDefinition({
      thread: createThread({
        id: "thread-main",
        sessionId: "session-main",
      }),
      session: {
        id: "session-main",
        agentKey: "panda",
        metadata: {},
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
      commandDescriptors: [customCommandDescriptor],
      llmContextSections: ["command_catalog"],
      tools: [],
    });

    const dump = await gatherContexts(definition.llmContexts ?? []);

    expect(dump).toContain("`panda custom inspect <target>`: Inspect a custom extension.");
    expect(dump).not.toContain("`panda watch list");
  });

  it("uses snapshotted profile prompt and subagent runtime context", async () => {
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
        listAgentSkills: async () => [
          {
            agentKey: "panda",
            skillKey: "calendar",
            description: "Use for calendar work.",
            content: "# Calendar",
            tags: [],
            loadCount: 0,
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
      },
      sessionStore: {
        listAgentSessions: async () => {
          throw new Error("subagent context should not list child sessions");
        },
        readSessionTodo: async () => null,
      },
    });

    const dump = await gatherContexts(definition.llmContexts ?? []);

    expect(definition.agent.instructions).toBe("PROFILE PROMPT ONLY");
    expect(definition.agent.instructions).not.toBe(DEFAULT_AGENT_INSTRUCTIONS);
    expect(definition.model).toBe("openai/gpt-5.1");
    expect(definition.thinking).toBe("medium");
    expect(dump).toContain("**Subagent Runtime Context:**");
    expect(dump).toContain("role: workspace");
    expect(dump).toContain("task: Inspect files.");
    expect(dump).toContain("context: Read-only please.");
    expect(dump).toContain("parentSessionId: parent-session");
    expect(dump).toContain('panda a2a send --to-session "parent-session" --text <message>');
    expect(dump).toContain("calendar: Use for calendar work.");
    expect(dump).not.toContain("**Subagents:**");
    expect(dump).not.toContain("**Session Prompts:**");
  });

  it("filters tools by subagent policy and always denies nested spawn tools", () => {
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
            "bash",
            "background_job_status",
            "background_job_wait",
            "background_job_cancel",
            "a2a.send",
            "a2a.inspect",
            "a2a.history",
            "skill.load",
            "postgres.readonly.query",
            "wiki.read",
            ["worker", "spawn"].join("_"),
            "spawn_subagent",
          ],
          agentSkill: {allowedOperations: ["load"]},
          postgresReadonly: {allowed: true},
          bash: {allowed: true},
        },
      }),
      tools: [
        new NamedTool("bash"),
        new NamedTool("background_job_status"),
        new NamedTool("background_job_wait"),
        new NamedTool("background_job_cancel"),
        new NamedTool("message_agent"),
        new NamedTool("agent_skill"),
        new NamedTool("postgres_readonly_query"),
        new NamedTool("outbound"),
        new NamedTool("wiki"),
        new NamedTool("skill.load"),
        new NamedTool("postgres.readonly.query"),
        new NamedTool("wiki.read"),
        new NamedTool(["worker", "spawn"].join("_")),
        new NamedTool("spawn_subagent"),
        new NamedTool("environment.create"),
      ],
    });

    expect(definition.agent.tools.map((tool) => tool.name)).toEqual([
      "bash",
      "background_job_status",
      "background_job_wait",
      "background_job_cancel",
      "skill.load",
      "postgres.readonly.query",
      "wiki.read",
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
          allowedTools: ["bash", "postgres.readonly.query"],
          bash: {allowed: false},
        },
      }),
      tools: [
        new NamedTool("bash"),
        new NamedTool("postgres.readonly.query"),
      ],
    });

    expect(definition.agent.tools.map((tool) => tool.name)).toEqual([]);
  });

  it("rejects unknown tool groups in persisted subagent metadata", () => {
    expect(() => readSubagentSessionMetadata({
      subagent: {
        version: 1,
        role: "workspace",
        task: "Inspect files.",
        parentSessionId: "parent-session",
        execution: "agent_workspace",
        profile: {
          slug: "workspace",
          source: "builtin",
          description: "Workspace reader.",
          prompt: "PROFILE PROMPT ONLY",
          toolGroups: ["core", "bash"],
          transcriptMode: "none",
        },
        resolved: {
          credentialPolicy: {mode: "allowlist", envKeys: []},
          skillPolicy: {mode: "all_agent"},
          toolPolicy: {},
        },
      },
    })).toThrow('Unknown subagent tool group "bash".');
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
