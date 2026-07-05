import {describe, expect, it, vi} from "vitest";

import {
  createSubagentSpawnCommand,
  SUBAGENT_SPAWN_COMMAND_NAME,
  type SubagentSpawnSessionCreator,
} from "../src/domain/subagents/commands.js";
import {buildSubagentSessionMetadata} from "../src/domain/subagents/session-metadata.js";

describe("subagent spawn command", () => {
  it("creates a durable subagent session", async () => {
    const createSubagentSession = vi.fn<SubagentSpawnSessionCreator["createSubagentSession"]>(async (input) => ({
      session: {
        id: "subagent-session",
        metadata: buildSubagentSessionMetadata({
          role: input.profile ?? "workspace",
          task: input.task,
          context: input.context,
          parentSessionId: input.parentSessionId,
          execution: input.execution ?? "agent_workspace",
          environmentId: input.environmentId,
          profile: {
            slug: input.profile ?? "workspace",
            source: "builtin",
            description: "Workspace helper.",
            prompt: "Help with workspace tasks.",
            toolGroups: input.toolGroups ?? ["core"],
            transcriptMode: "none",
          },
          resolved: {
            credentialPolicy: {
              mode: "allowlist",
              envKeys: input.credentialAllowlist ?? [],
            },
            skillPolicy: {mode: "all_agent"},
            toolPolicy: {allowedTools: ["a2a.send"]},
          },
        }),
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
    }));
    const command = createSubagentSpawnCommand({
      createSubagentSession,
    });

    const result = await command.execute({
      command: SUBAGENT_SPAWN_COMMAND_NAME,
      input: {
        prompt: "Inspect runtime wiring.",
        profile: "workspace",
        context: "Focus issue #94.",
        execution: "isolated_environment",
        environmentId: "env-parent-owned",
        credentialAllowlist: ["BRAVE_API_KEY"],
      },
      scope: {
        agentKey: "panda",
        sessionId: "parent-session",
        identityId: "identity-1",
      },
    });

    expect(createSubagentSession).toHaveBeenCalledWith({
      agentKey: "panda",
      parentSessionId: "parent-session",
      task: "Inspect runtime wiring.",
      profile: "workspace",
      context: "Focus issue #94.",
      execution: "isolated_environment",
      environmentId: "env-parent-owned",
      credentialAllowlist: ["BRAVE_API_KEY"],
      createdByIdentityId: "identity-1",
    });
    expect(result).toMatchObject({
      ok: true,
      command: SUBAGENT_SPAWN_COMMAND_NAME,
      output: {
        status: "spawned",
        sessionId: "subagent-session",
        threadId: "subagent-thread",
        profile: "workspace",
        profileSource: "builtin",
        execution: "isolated_environment",
        environmentId: "env-parent-owned",
      },
    });
  });
});
