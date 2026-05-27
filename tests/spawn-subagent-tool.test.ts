import {describe, expect, it, vi} from "vitest";

import {
  Agent,
  type DefaultAgentSessionContext,
  RunContext,
  SpawnSubagentTool,
} from "../src/index.js";
import {buildSubagentSessionMetadata} from "../src/domain/subagents/session-metadata.js";
import type {SubagentSessionCreator} from "../src/panda/tools/spawn-subagent-tool.js";

function createRunContext(overrides: Partial<DefaultAgentSessionContext> = {}): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "panda",
      instructions: "Parent agent",
    }),
    turn: 0,
    maxTurns: 5,
    messages: [],
    context: {
      cwd: "/workspace/panda",
      agentKey: "panda",
      sessionId: "parent-session",
      threadId: "parent-thread",
      currentInput: {
        source: "tui",
        identityId: "identity-1",
      },
      ...overrides,
    },
  });
}

function createSubagentSessions(): {
  createSubagentSession: ReturnType<typeof vi.fn<SubagentSessionCreator["createSubagentSession"]>>;
  service: SubagentSessionCreator;
} {
  const createSubagentSession = vi.fn<SubagentSessionCreator["createSubagentSession"]>(async (input) => {
    const toolGroups = input.toolGroups ?? ["core", "workspace_read"];
    const profileSlug = input.toolGroups ? "ad_hoc" : input.profile ?? "workspace";
    const metadata = buildSubagentSessionMetadata({
      role: profileSlug,
      task: input.task,
      context: input.context,
      parentSessionId: input.parentSessionId,
      execution: input.execution ?? "agent_workspace",
      environmentId: input.environmentId,
      profile: {
        slug: profileSlug,
        source: input.toolGroups ? "ad_hoc" : "builtin",
        description: "Test subagent profile.",
        prompt: "Test subagent prompt.",
        toolGroups,
        transcriptMode: "none",
      },
      resolved: {
        credentialPolicy: {
          mode: "allowlist",
          envKeys: input.credentialAllowlist ?? [],
        },
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {allowedTools: ["message_agent"]},
      },
    });
    return {
      session: {
        id: "subagent-session",
        metadata,
      },
      thread: {
        id: "subagent-thread",
      },
      ...(input.environmentId
        ? {
          environment: {
            id: input.environmentId,
          },
        }
        : {}),
    };
  });
  return {
    createSubagentSession,
    service: {createSubagentSession},
  };
}

describe("SpawnSubagentTool", () => {
  it("creates durable subagent sessions from the hard-cut prompt schema", async () => {
    const {createSubagentSession, service} = createSubagentSessions();
    const tool = new SpawnSubagentTool({subagentSessions: service});

    const result = await tool.run({
      prompt: "Inspect the repo for issue #16 PR3.",
      profile: "workspace",
      context: "Focus on runtime wiring.",
      execution: "isolated_environment",
      environmentId: "env-parent-owned",
      credentialAllowlist: ["BRAVE_API_KEY"],
    }, createRunContext());

    expect(createSubagentSession).toHaveBeenCalledWith({
      agentKey: "panda",
      parentSessionId: "parent-session",
      task: "Inspect the repo for issue #16 PR3.",
      profile: "workspace",
      context: "Focus on runtime wiring.",
      execution: "isolated_environment",
      environmentId: "env-parent-owned",
      credentialAllowlist: ["BRAVE_API_KEY"],
      createdByIdentityId: "identity-1",
    });
    expect(result).toMatchObject({
      status: "spawned",
      sessionId: "subagent-session",
      threadId: "subagent-thread",
      profile: "workspace",
      profileSource: "builtin",
      execution: "isolated_environment",
      environmentId: "env-parent-owned",
    });
    expect(result).not.toHaveProperty("jobId");
  });

  it("preserves ad-hoc toolGroups by not defaulting profile in the schema", async () => {
    const {createSubagentSession, service} = createSubagentSessions();
    const tool = new SpawnSubagentTool({subagentSessions: service});

    const result = await tool.run({
      prompt: "Search memory and summarize evidence.",
      toolGroups: ["core", "memory"],
    }, createRunContext({
      currentInput: {
        source: "heartbeat",
      },
    }));

    expect(createSubagentSession).toHaveBeenCalledWith({
      agentKey: "panda",
      parentSessionId: "parent-session",
      task: "Search memory and summarize evidence.",
      toolGroups: ["core", "memory"],
      credentialAllowlist: [],
    });
    expect(result).toMatchObject({
      status: "spawned",
      profile: "ad_hoc",
      profileSource: "ad_hoc",
      execution: "agent_workspace",
    });
    expect(result).not.toHaveProperty("jobId");
  });

  it("rejects old spawn fields instead of silently stripping them", async () => {
    const {createSubagentSession, service} = createSubagentSessions();
    const tool = new SpawnSubagentTool({subagentSessions: service});
    const run = createRunContext();
    const oldFields: Record<string, unknown> = {
      role: "workspace",
      task: "old task",
      model: "openai/gpt-5.1",
      thinking: "high",
      skillAllowlist: ["calendar"],
      toolAllowlist: ["bash"],
      allowReadonlyPostgres: true,
      ttlMs: 1_000,
      ttlHours: 1,
      transcriptMode: "none",
    };

    await expect(tool.run({
      role: "workspace",
      task: "Old shape.",
    }, run)).rejects.toThrow("Invalid tool arguments");

    for (const [field, value] of Object.entries(oldFields)) {
      await expect(tool.run({
        prompt: "Valid prompt, invalid legacy field.",
        [field]: value,
      }, run)).rejects.toThrow(`Unrecognized key: "${field}"`);
    }
    expect(createSubagentSession).not.toHaveBeenCalled();
  });

  it("requires runtime agent and parent session scope", async () => {
    const {service} = createSubagentSessions();
    const tool = new SpawnSubagentTool({subagentSessions: service});

    await expect(tool.run({
      prompt: "Do scoped work.",
    }, createRunContext({
      agentKey: "",
    }))).rejects.toMatchObject({
      name: "ToolError",
      message: "spawn_subagent requires agentKey and sessionId in the runtime session context.",
    });
  });
});
