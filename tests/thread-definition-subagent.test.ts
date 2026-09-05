import {describe, expect, it} from "vitest";

import {createThreadDefinition} from "../src/app/runtime/create-runtime.js";
import type {CommandDescriptor} from "../src/domain/commands/index.js";
import type {ResolvedExecutionEnvironment} from "../src/domain/execution-environments/types.js";
import {buildSubagentSessionMetadata, readSubagentSessionMetadata} from "../src/domain/subagents/session-metadata.js";
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
  it.each(["main", "branch", "subagent"] as const)("shows declared storage to %s sessions without inventing artifact mounts", async (kind) => {
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-subagent",
        agentKey: "panda",
        kind,
        metadata: kind === "subagent" ? createSubagentMetadata() : {},
      },
      fallbackContext: {cwd: "/wrong-fallback"},
      executionEnvironment: createEnvironment({
        id: "runner-custom",
        kind: "persistent_agent_runner",
        executionMode: "remote",
        initialCwd: "/durable/panda/project",
        persistentRoots: ["/durable/panda"],
        source: "binding",
      }),
      tools: [],
    });

    const dump = await gatherContexts(definition.llmContexts ?? []);

    expect(dump).toContain('Storage for bash target "default":');
    expect(dump).toContain("Initial working directory: /durable/panda/project");
    expect(dump).toContain("Declared persistent roots: /durable/panda");
    expect(dump).toContain("Keep reusable source, non-secret configuration, state, and dependency manifests in declared persistent roots.");
    expect(dump).not.toContain("/wrong-fallback");
    expect(dump).not.toContain("/workspace");
    expect(dump).not.toContain("/inbox");
    expect(dump).not.toContain("/artifacts");
    if (kind === "subagent") {
      expect(definition.agent.instructions).toBe("PROFILE PROMPT ONLY");
      expect(dump).toContain("environmentId: runner-custom");
    }
  });

  it.each([
    {kind: "main" as const},
    {kind: "branch" as const},
    {kind: "subagent" as const, execution: "agent_workspace" as const},
    {kind: "subagent" as const, execution: "isolated_environment" as const},
  ])("preserves configured handoff coordinates for $kind / $execution", async ({kind, execution}) => {
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-subagent",
        agentKey: "panda",
        kind,
        metadata: kind === "subagent" ? createSubagentMetadata({
          execution,
          ...(execution === "isolated_environment" ? {environmentId: "env-custom"} : {}),
        }) : {},
      },
      fallbackContext: {cwd: "/wrong-fallback"},
      executionEnvironment: createEnvironment({
        id: "env-custom",
        kind: "disposable_container",
        executionMode: "remote",
        initialCwd: "/work/project/src",
        source: "binding",
        metadata: {
          filesystem: {
            envDir: "custom",
            root: {corePath: "/core/custom", parentRunnerPath: "/owner/custom"},
            workspace: {corePath: "/core/custom/work", workerPath: "/work", parentRunnerPath: "/owner/project"},
            inbox: {corePath: "/core/custom/input", workerPath: "/input", parentRunnerPath: "/owner/input"},
            artifacts: {corePath: "/core/custom/output", workerPath: "/output", parentRunnerPath: "/owner/deliverables"},
          },
        },
      }),
      tools: [],
    });

    const dump = await gatherContexts(definition.llmContexts ?? []);

    expect(dump).toContain("Initial working directory: /work/project/src");
    expect(dump).toContain("Configured workspace: /work");
    expect(dump).toContain("Configured inbox: /input");
    expect(dump).toContain("Configured artifacts: /output");
    expect(dump).toContain("Owner-runner artifacts: /owner/deliverables");
    expect(dump).toContain("Environment stop retains these mapped directories; purge deletes them.");
    expect(dump).toContain("The owner must copy accepted outputs needed long-term into its declared persistent storage before purge.");
    expect(dump).not.toContain("/core/custom");
    expect(dump).not.toContain("/artifacts");
    expect(dump).not.toContain("Declared persistent roots:");
  });

  it.each([
    {kind: "local" as const, metadata: undefined},
    {kind: "persistent_agent_runner" as const, metadata: undefined},
    {kind: "disposable_container" as const, metadata: {filesystem: {workspace: {workerPath: "/invented"}}}},
  ])("does not infer storage guarantees for $kind without complete declarations", async ({kind, metadata}) => {
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-subagent",
        agentKey: "panda",
        kind: "subagent",
        metadata: createSubagentMetadata(),
      },
      fallbackContext: {cwd: "/local-project"},
      executionEnvironment: createEnvironment({kind, metadata, initialCwd: "/custom-cwd", source: "binding"}),
      tools: [],
    });

    const dump = await gatherContexts(definition.llmContexts ?? []);

    expect(dump).toContain("Initial working directory: /custom-cwd");
    expect(dump).toContain("Persistent roots: unspecified; do not infer durability from HOME or cwd.");
    expect(dump).not.toContain("Configured workspace:");
    expect(dump).not.toContain("Configured inbox:");
    expect(dump).not.toContain("Configured artifacts:");
    expect(dump).not.toContain("Environment stop retains");
    expect(dump).not.toContain("/invented");
  });

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
