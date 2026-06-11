import {describe, expect, it, vi} from "vitest";

import {
  Agent,
  type DefaultAgentSessionContext,
  RunContext,
  ToolError,
  UpsertSubagentProfileTool,
} from "../src/index.js";
import type {SubagentProfileRecord, UpsertSubagentProfileInput} from "../src/domain/subagents/types.js";
import type {UpsertSubagentProfileToolStore} from "../src/panda/tools/upsert-subagent-profile-tool.js";

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
      sessionId: "session-1",
      threadId: "thread-1",
      currentInput: {source: "tui"},
      ...overrides,
    },
  });
}

function createProfile(input: UpsertSubagentProfileInput): SubagentProfileRecord {
  return {
    slug: input.slug.trim().toLowerCase(),
    agentKey: input.agentKey ?? undefined,
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    toolGroups: input.toolGroups as SubagentProfileRecord["toolGroups"],
    ...(input.model ? {model: input.model.trim()} : {}),
    ...(input.thinking ? {thinking: input.thinking} : {}),
    transcriptMode: input.transcriptMode ?? "none",
    source: input.source,
    createdByAgentKey: input.createdByAgentKey ?? undefined,
    enabled: input.enabled ?? true,
    createdAt: 1,
    updatedAt: 2,
  };
}

function createStore(): {
  upsertProfile: ReturnType<typeof vi.fn<UpsertSubagentProfileToolStore["upsertProfile"]>>;
  store: UpsertSubagentProfileToolStore;
} {
  const upsertProfile = vi.fn<UpsertSubagentProfileToolStore["upsertProfile"]>(async (input) => createProfile(input));
  return {
    upsertProfile,
    store: {upsertProfile},
  };
}

describe("UpsertSubagentProfileTool", () => {
  it("upserts custom profiles scoped to the current agent", async () => {
    const {store, upsertProfile} = createStore();
    const tool = new UpsertSubagentProfileTool({store});

    const result = await tool.run({
      slug: "Code-Reviewer",
      description: "Review code changes.",
      prompt: "Inspect the diff and report blockers.",
      toolGroups: ["core", "workspace_read"],
      model: "openai-codex/gpt-5.2",
      thinking: "high",
      enabled: false,
    }, createRunContext({agentKey: "clawd"}));

    expect(upsertProfile).toHaveBeenCalledWith({
      slug: "Code-Reviewer",
      description: "Review code changes.",
      prompt: "Inspect the diff and report blockers.",
      toolGroups: ["core", "workspace_read"],
      model: "openai-codex/gpt-5.2",
      thinking: "high",
      enabled: false,
      source: "custom",
      agentKey: "clawd",
      createdByAgentKey: "clawd",
      transcriptMode: "none",
    });
    expect(result).toEqual({
      slug: "code-reviewer",
      source: "custom",
      agentKey: "clawd",
      description: "Review code changes.",
      toolGroups: ["core", "workspace_read"],
      model: "openai-codex/gpt-5.2",
      thinking: "high",
      enabled: false,
    });
    expect(result).not.toHaveProperty("prompt");
  });

  it("does not accept spawn-time or policy fields", async () => {
    const {store, upsertProfile} = createStore();
    const tool = new UpsertSubagentProfileTool({store});
    const run = createRunContext();
    const forbiddenFields: Record<string, unknown> = {
      credentialAllowlist: ["BRAVE_API_KEY"],
      credentials: {BRAVE_API_KEY: "secret"},
      credentialPolicy: {mode: "all"},
      environmentId: "env-1",
      execution: "isolated_environment",
      toolNames: ["bash"],
      toolAllowlist: ["bash"],
      skillAllowlist: ["github"],
      transcriptMode: "none",
      source: "builtin",
      agentKey: "other",
      createdByAgentKey: "other",
    };

    for (const [field, value] of Object.entries(forbiddenFields)) {
      await expect(tool.run({
        slug: "reviewer",
        description: "Review code.",
        prompt: "Review the code.",
        toolGroups: ["core"],
        [field]: value,
      }, run)).rejects.toThrow(`Unrecognized key: "${field}"`);
    }
    expect(upsertProfile).not.toHaveBeenCalled();
  });

  it("requires an agent-scoped runtime context", async () => {
    const {store, upsertProfile} = createStore();
    const tool = new UpsertSubagentProfileTool({store});

    await expect(tool.run({
      slug: "reviewer",
      description: "Review code.",
      prompt: "Review the code.",
      toolGroups: ["core"],
    }, createRunContext({agentKey: ""}))).rejects.toBeInstanceOf(ToolError);
    await expect(tool.run({
      slug: "reviewer",
      description: "Review code.",
      prompt: "Review the code.",
      toolGroups: ["core"],
    }, createRunContext({agentKey: ""}))).rejects.toThrow(
      "upsert_subagent_profile requires agentKey in the runtime session context.",
    );
    expect(upsertProfile).not.toHaveBeenCalled();
  });

  it("surfaces store normalization errors as tool errors", async () => {
    const upsertProfile = vi.fn<UpsertSubagentProfileToolStore["upsertProfile"]>(async () => {
      throw new Error("Custom subagent profiles must set agentKey.");
    });
    const tool = new UpsertSubagentProfileTool({store: {upsertProfile}});

    await expect(tool.run({
      slug: "reviewer",
      description: "Review code.",
      prompt: "Review the code.",
      toolGroups: ["core"],
    }, createRunContext())).rejects.toMatchObject({
      name: "ToolError",
      message: "Custom subagent profiles must set agentKey.",
    });
  });

  it("surfaces mutually exclusive tool groups as a recoverable tool error", async () => {
    const upsertProfile = vi.fn<UpsertSubagentProfileToolStore["upsertProfile"]>(async () => {
      throw new Error(
        "Subagent tool groups workspace_read and execute are mutually exclusive. Choose workspace_read for read-only workspace wrapper tools, or execute for shell/background execution; execute can read workspace files through shell commands, so do not combine them.",
      );
    });
    const tool = new UpsertSubagentProfileTool({store: {upsertProfile}});

    await expect(tool.run({
      slug: "operator",
      description: "Operate on code.",
      prompt: "Inspect and modify as needed.",
      toolGroups: ["core", "workspace_read", "execute"],
    }, createRunContext())).rejects.toMatchObject({
      name: "ToolError",
      message: expect.stringContaining("execute can read workspace files through shell commands"),
    });
  });
});
