import {describe, expect, it, vi} from "vitest";

import {
  createSubagentListCommand,
  createSubagentShowCommand,
  SUBAGENT_LIST_COMMAND_NAME,
  SUBAGENT_SHOW_COMMAND_NAME,
} from "../src/domain/subagents/inventory-commands.js";
import type {SubagentInventoryReader, SubagentInventoryRecord} from "../src/domain/subagents/inventory.js";

const RECORD: SubagentInventoryRecord = {
  sessionId: "child-session",
  currentThreadId: "child-thread",
  profile: "workspace",
  execution: "isolated_environment",
  taskPreview: "Inspect runtime wiring.",
  startedAt: "2026-07-19T10:00:00.000Z",
  messageCount: 3,
  pendingInputCount: 1,
  lastMessageAt: "2026-07-19T10:02:00.000Z",
  latestRun: {
    id: "run-1",
    status: "failed",
    startedAt: "2026-07-19T10:01:00.000Z",
    finishedAt: "2026-07-19T10:02:00.000Z",
    errorSummary: "Runner unavailable.",
  },
  environment: {
    id: "environment-1",
    alias: "self",
    state: "failed",
    runnerCwd: "/workspace",
    rootPath: "/workspace",
    expiresAt: "2026-07-20T10:00:00.000Z",
    paths: {
      workspace: "/environments/environment-1/workspace",
      inbox: "/environments/environment-1/inbox",
      artifacts: "/environments/environment-1/artifacts",
    },
  },
};

function scope() {
  return {
    agentKey: "panda",
    sessionId: "parent-session",
  };
}

describe("subagent inventory commands", () => {
  it("defaults list to all statuses and 20 records", async () => {
    const list = vi.fn<SubagentInventoryReader["list"]>(async () => ({
      records: [],
      hasMore: false,
    }));
    const command = createSubagentListCommand({list, show: async () => null});

    await command.execute({
      command: SUBAGENT_LIST_COMMAND_NAME,
      input: {},
      scope: scope(),
    });

    expect(list).toHaveBeenCalledWith({
      agentKey: "panda",
      parentSessionId: "parent-session",
      runStatus: "all",
      limit: 20,
    });
  });

  it("lists bounded child state through the inventory interface", async () => {
    const list = vi.fn<SubagentInventoryReader["list"]>(async () => ({
      records: [RECORD],
      hasMore: true,
    }));
    const command = createSubagentListCommand({
      list,
      show: async () => null,
    });

    const result = await command.execute({
      command: SUBAGENT_LIST_COMMAND_NAME,
      input: {runStatus: "failed", limit: 7},
      scope: scope(),
    });

    expect(list).toHaveBeenCalledWith({
      agentKey: "panda",
      parentSessionId: "parent-session",
      runStatus: "failed",
      limit: 7,
    });
    expect(result.output).toMatchObject({
      operation: "list",
      count: 1,
      hasMore: true,
      subagents: [{
        sessionId: "child-session",
        latestRun: {status: "failed", errorSummary: "Runner unavailable."},
        environment: {
          environmentId: "environment-1",
          alias: "self",
          state: "failed",
        },
      }],
    });
    expect(JSON.stringify(result.output)).not.toContain("runnerCwd");
    expect(JSON.stringify(result.output)).not.toContain("/environments/");
  });

  it("shows expanded environment details for one direct child", async () => {
    const show = vi.fn<SubagentInventoryReader["show"]>(async () => RECORD);
    const command = createSubagentShowCommand({
      list: async () => ({records: [], hasMore: false}),
      show,
    });

    const result = await command.execute({
      command: SUBAGENT_SHOW_COMMAND_NAME,
      input: {sessionId: "child-session"},
      scope: scope(),
    });

    expect(show).toHaveBeenCalledWith({
      agentKey: "panda",
      parentSessionId: "parent-session",
      sessionId: "child-session",
    });
    expect(result.output).toMatchObject({
      operation: "show",
      sessionId: "child-session",
      environment: {
        environmentId: "environment-1",
        runnerCwd: "/workspace",
        paths: {
          workspace: "/environments/environment-1/workspace",
        },
      },
    });
  });

  it("uses the same not-found error for absent and out-of-scope sessions", async () => {
    const command = createSubagentShowCommand({
      list: async () => ({records: [], hasMore: false}),
      show: async () => null,
    });

    await expect(command.execute({
      command: SUBAGENT_SHOW_COMMAND_NAME,
      input: {sessionId: "unknown-or-out-of-scope"},
      scope: scope(),
    })).rejects.toThrow("Subagent session unknown-or-out-of-scope was not found.");
  });

  it("rejects unbounded or ambiguous list inputs", async () => {
    const command = createSubagentListCommand({
      list: async () => ({records: [], hasMore: false}),
      show: async () => null,
    });

    await expect(command.execute({
      command: SUBAGENT_LIST_COMMAND_NAME,
      input: {limit: 51},
      scope: scope(),
    })).rejects.toThrow("subagent.list limit must be an integer from 1 to 50.");
    await expect(command.execute({
      command: SUBAGENT_LIST_COMMAND_NAME,
      input: {runStatus: "active"},
      scope: scope(),
    })).rejects.toThrow("subagent.list runStatus must be running, completed, failed, or all.");
  });
});
