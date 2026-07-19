import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {stringToUserMessage} from "../src/index.js";
import {PostgresExecutionEnvironmentStore} from "../src/domain/execution-environments/postgres.js";
import type {JsonObject} from "../src/lib/json.js";
import {PostgresSubagentInventory} from "../src/domain/subagents/inventory.js";
import {buildSubagentSessionMetadata} from "../src/domain/subagents/session-metadata.js";
import type {PostgresSessionStore} from "../src/domain/sessions/index.js";
import type {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

function filesystemMetadata(environmentId: string): JsonObject {
  return {
    filesystem: {
      envDir: environmentId,
      root: {
        corePath: `/core/environments/panda/${environmentId}`,
        parentRunnerPath: `/environments/${environmentId}`,
      },
      workspace: {
        corePath: `/core/environments/panda/${environmentId}/workspace`,
        parentRunnerPath: `/environments/${environmentId}/workspace`,
        workerPath: "/workspace",
      },
      inbox: {
        corePath: `/core/environments/panda/${environmentId}/inbox`,
        parentRunnerPath: `/environments/${environmentId}/inbox`,
        workerPath: "/inbox",
      },
      artifacts: {
        corePath: `/core/environments/panda/${environmentId}/artifacts`,
        parentRunnerPath: `/environments/${environmentId}/artifacts`,
        workerPath: "/artifacts",
      },
    },
  };
}

function subagentMetadata(input: {
  parentSessionId: string;
  task: string;
  execution?: "agent_workspace" | "isolated_environment";
  environmentId?: string;
}) {
  return buildSubagentSessionMetadata({
    role: "workspace",
    task: input.task,
    parentSessionId: input.parentSessionId,
    execution: input.execution ?? "agent_workspace",
    environmentId: input.environmentId,
    profile: {
      slug: "workspace",
      source: "builtin",
      description: "Workspace helper.",
      prompt: "Inspect workspace files.",
      toolGroups: ["core"],
      transcriptMode: "none",
    },
    resolved: {
      credentialPolicy: {mode: "allowlist", envKeys: []},
      skillPolicy: {mode: "all_agent"},
      toolPolicy: {allowedTools: ["a2a.send"]},
    },
  });
}

async function createSession(
  sessions: PostgresSessionStore,
  threads: PostgresThreadRuntimeStore,
  input: {
    id: string;
    agentKey?: string;
    parentSessionId?: string;
    currentThreadId?: string;
    kind?: "main" | "branch";
    execution?: "agent_workspace" | "isolated_environment";
    environmentId?: string;
    task?: string;
  },
) {
  const threadId = input.currentThreadId ?? `${input.id}-thread`;
  await sessions.createSession({
    id: input.id,
    agentKey: input.agentKey ?? "panda",
    kind: input.parentSessionId ? "subagent" : (input.kind ?? "main"),
    currentThreadId: threadId,
    metadata: input.parentSessionId
      ? subagentMetadata({
        parentSessionId: input.parentSessionId,
        task: input.task ?? `  Task\nfor   ${input.id}  `,
        execution: input.execution,
        environmentId: input.environmentId,
      })
      : undefined,
  });
  await threads.createThread({
    id: threadId,
    sessionId: input.id,
  });
  return threadId;
}

describe("PostgresSubagentInventory", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function createHarness() {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    db.public.registerFunction({
      name: "hashtextextended",
      args: [DataType.text, DataType.integer],
      returns: DataType.bigint,
      implementation: (value: string) => value.length,
    });
    db.public.registerFunction({
      name: "pg_advisory_xact_lock",
      args: [DataType.bigint],
      returns: DataType.void,
      implementation: () => undefined,
    });
    db.public.registerFunction({
      name: "length",
      args: [DataType.text],
      returns: DataType.integer,
      implementation: (value: string) => value.length,
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const {agentStore, sessionStore, threadStore} = await createRuntimeStores(pool);
    // pg-mem can incorrectly hide non-main rows when it plans through these session indexes.
    // The production query still uses them; this test only disables the emulator bug.
    await pool.query('DROP INDEX IF EXISTS "runtime"."runtime_agent_sessions_agent_idx"');
    await pool.query('DROP INDEX IF EXISTS "runtime"."runtime_agent_sessions_main_idx"');
    await pool.query('DROP INDEX IF EXISTS "runtime"."runtime_agent_sessions_agent_alias_idx"');
    const environmentStore = new PostgresExecutionEnvironmentStore({pool});
    await environmentStore.ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "other-agent",
      displayName: "Other",
    });

    await createSession(sessionStore, threadStore, {id: "parent-session"});
    await createSession(sessionStore, threadStore, {id: "other-parent", kind: "branch"});
    await createSession(sessionStore, threadStore, {
      id: "unbound-environment-child",
      parentSessionId: "parent-session",
      execution: "isolated_environment",
      environmentId: "environment-2",
      task: " x ".repeat(200),
    });
    await createSession(sessionStore, threadStore, {
      id: "no-run-child",
      parentSessionId: "parent-session",
    });
    const runningThread = await createSession(sessionStore, threadStore, {
      id: "running-child",
      parentSessionId: "parent-session",
    });
    await threadStore.createRun(runningThread);

    const failedCurrentThread = await createSession(sessionStore, threadStore, {
      id: "failed-child",
      parentSessionId: "parent-session",
      currentThreadId: "failed-current-thread",
      execution: "isolated_environment",
      environmentId: "environment-1",
    });
    await threadStore.createThread({
      id: "failed-old-thread",
      sessionId: "failed-child",
    });
    const failedRun = await threadStore.createRun("failed-old-thread");
    await threadStore.failRunIfRunning(
      failedRun.id,
      "failureKind=provider_error Runner unavailable.\nrequest body: {\"token\":\"secret\"}",
    );
    await threadStore.enqueueInput("failed-old-thread", {
      message: stringToUserMessage("old applied message"),
      source: "tui",
    });
    await threadStore.applyPendingInputs("failed-old-thread");
    await threadStore.enqueueInput(failedCurrentThread, {
      message: stringToUserMessage("queued current input"),
      source: "tui",
    }, "queue");

    const completedThread = await createSession(sessionStore, threadStore, {
      id: "completed-child",
      parentSessionId: "parent-session",
    });
    const completedRun = await threadStore.createRun(completedThread);
    await threadStore.completeRun(completedRun.id);

    await createSession(sessionStore, threadStore, {
      id: "missing-environment-child",
      parentSessionId: "parent-session",
      execution: "isolated_environment",
      environmentId: "missing-environment",
    });
    await createSession(sessionStore, threadStore, {
      id: "other-parent-child",
      parentSessionId: "other-parent",
    });
    await createSession(sessionStore, threadStore, {
      id: "other-agent-child",
      agentKey: "other-agent",
      parentSessionId: "parent-session",
    });

    await environmentStore.createEnvironment({
      id: "environment-1",
      agentKey: "panda",
      kind: "disposable_container",
      state: "failed",
      runnerCwd: "/workspace",
      rootPath: "/workspace",
      createdBySessionId: "parent-session",
      expiresAt: Date.now() + 60_000,
      metadata: filesystemMetadata("environment-1"),
    });
    await environmentStore.createEnvironment({
      id: "environment-2",
      agentKey: "panda",
      kind: "disposable_container",
      state: "ready",
      runnerCwd: "/workspace",
      rootPath: "/workspace",
      createdBySessionId: "parent-session",
      metadata: filesystemMetadata("environment-2"),
    });
    await environmentStore.bindSession({
      sessionId: "failed-child",
      environmentId: "environment-1",
      alias: "self",
    });

    return {
      inventory: new PostgresSubagentInventory(pool),
    };
  }

  it("lists direct children in actionable factual order with bounded output", async () => {
    const {inventory} = await createHarness();

    const result = await inventory.list({
      agentKey: "panda",
      parentSessionId: "parent-session",
      runStatus: "all",
      limit: 4,
    });

    expect(result.hasMore).toBe(true);
    expect(result.records.map((record) => record.sessionId)).toEqual([
      "missing-environment-child",
      "no-run-child",
      "unbound-environment-child",
      "running-child",
    ]);
    expect(result.records[0]).toMatchObject({
      taskPreview: "Task for missing-environment-child",
      latestRun: null,
      environment: {
        id: "missing-environment",
        alias: null,
        state: null,
      },
    });
    expect(result.records.find((record) => record.sessionId === "unbound-environment-child")).toMatchObject({
      environment: {
        id: "environment-2",
        alias: null,
        state: "ready",
      },
    });
    const unboundTaskPreview = result.records.find(
      (record) => record.sessionId === "unbound-environment-child",
    )?.taskPreview;
    expect(unboundTaskPreview?.length).toBeLessThanOrEqual(240);
    expect(unboundTaskPreview).not.toContain("  ");
  });

  it("reads latest run across reset threads and current-thread pending input", async () => {
    const {inventory} = await createHarness();

    const record = await inventory.show({
      agentKey: "panda",
      parentSessionId: "parent-session",
      sessionId: "failed-child",
    });

    expect(record).toMatchObject({
      currentThreadId: "failed-current-thread",
      messageCount: 1,
      pendingInputCount: 1,
      latestRun: {
        status: "failed",
        errorSummary: "Runner unavailable.",
      },
      environment: {
        id: "environment-1",
        alias: "self",
        state: "failed",
        runnerCwd: "/workspace",
        paths: {
          workspace: "/environments/environment-1/workspace",
          inbox: "/environments/environment-1/inbox",
          artifacts: "/environments/environment-1/artifacts",
        },
      },
    });
    expect(JSON.stringify(record)).not.toContain("secret");
    expect(JSON.stringify(record)).not.toContain("request body");
  });

  it("filters by factual latest run status and hides sibling-parent or cross-agent sessions", async () => {
    const {inventory} = await createHarness();

    const failed = await inventory.list({
      agentKey: "panda",
      parentSessionId: "parent-session",
      runStatus: "failed",
      limit: 20,
    });
    const otherParent = await inventory.show({
      agentKey: "panda",
      parentSessionId: "parent-session",
      sessionId: "other-parent-child",
    });
    const otherAgent = await inventory.show({
      agentKey: "panda",
      parentSessionId: "parent-session",
      sessionId: "other-agent-child",
    });

    expect(failed.records.map((record) => record.sessionId)).toEqual(["failed-child"]);
    expect(otherParent).toBeNull();
    expect(otherAgent).toBeNull();
  });
});
