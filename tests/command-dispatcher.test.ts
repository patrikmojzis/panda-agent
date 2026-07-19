import {describe, expect, it} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import {createBashCommandExecutionReader} from "../src/app/runtime/bash-command-summary-reader.js";
import type {RegisteredCommand} from "../src/domain/commands/types.js";
import type {CreateThreadToolJobInput, ThreadToolJobRecord, ThreadToolJobUpdate} from "../src/domain/threads/runtime/types.js";

function createAuditStore() {
  const jobs: ThreadToolJobRecord[] = [];
  const updates: Array<{jobId: string; update: ThreadToolJobUpdate}> = [];

  return {
    jobs,
    updates,
    store: {
      async createToolJob(input: CreateThreadToolJobInput): Promise<ThreadToolJobRecord> {
        const record: ThreadToolJobRecord = {
          id: input.id,
          threadId: input.threadId,
          runId: input.runId,
          parentToolCallId: input.parentToolCallId,
          commandOrdinal: input.parentToolCallId
            ? jobs.filter((job) => job.parentToolCallId === input.parentToolCallId).length + 1
            : undefined,
          kind: input.kind,
          status: input.status ?? "running",
          summary: input.summary ?? "",
          startedAt: input.startedAt ?? 0,
          result: input.result,
          error: input.error,
          statusReason: input.statusReason,
          progress: input.progress,
        };
        jobs.push(record);
        return record;
      },
      async updateToolJob(jobId: string, update: ThreadToolJobUpdate): Promise<ThreadToolJobRecord> {
        updates.push({jobId, update});
        const job = jobs.find((candidate) => candidate.id === jobId);
        if (!job) {
          throw new Error(`Unknown job ${jobId}.`);
        }
        Object.assign(job, update);
        return job;
      },
      async listCommandToolJobsByParent(
        threadId: string,
        runId: string,
        parentToolCallId: string,
      ): Promise<readonly ThreadToolJobRecord[]> {
        return jobs
          .filter((job) => (
            job.threadId === threadId
            && job.runId === runId
            && job.parentToolCallId === parentToolCallId
          ))
          .sort((left, right) => (left.commandOrdinal ?? 0) - (right.commandOrdinal ?? 0));
      },
    },
  };
}

function createEchoCommand(): RegisteredCommand {
  return {
    descriptor: {
      name: "test.echo",
      summary: "Echo input.",
      description: "Returns the input payload.",
      usage: "panda test echo --json @payload.json",
      inputModes: ["json"],
      outputModes: ["json"],
      arguments: [],
      examples: [],
    },
    async execute(request) {
      return {
        ok: true,
        command: "test.echo",
        output: request.input,
      };
    },
  };
}

describe("RuntimeCommandDispatcher", () => {
  const scope = {
    agentKey: "panda",
    sessionId: "session-main",
    allowedCommands: ["test.*"] as const,
  };

  it("executes a registered command", async () => {
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [createEchoCommand()],
    });

    await expect(dispatcher.execute({
      command: "test.echo",
      input: {message: "hello"},
      scope,
    })).resolves.toEqual({
      ok: true,
      command: "test.echo",
      output: {
        message: "hello",
      },
    });
  });

  it("registers additional commands after construction", async () => {
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [],
    });

    dispatcher.registerCommands([createEchoCommand()]);

    await expect(dispatcher.execute({
      command: "test.echo",
      input: {message: "late"},
      scope,
    })).resolves.toMatchObject({
      ok: true,
      output: {
        message: "late",
      },
    });
    await expect(() => dispatcher.registerCommands([createEchoCommand()])).toThrow("Duplicate Panda command test.echo.");
  });

  it("rejects unknown commands", async () => {
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [createEchoCommand()],
    });

    await expect(dispatcher.execute({
      command: "test.missing",
      input: {},
      scope,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unknown_command",
      },
    });
  });

  it("filters commands through exact and wildcard allowlists", async () => {
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [createEchoCommand()],
    });

    await expect(dispatcher.execute({
      command: "test.echo",
      input: {},
      scope: {
        ...scope,
        allowedCommands: ["test.*"],
      },
    })).resolves.toMatchObject({
      ok: true,
    });

    await expect(dispatcher.execute({
      command: "test.echo",
      input: {},
      scope: {
        ...scope,
        allowedCommands: ["watch.create"],
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "forbidden",
      },
    });
  });

  it("rejects scoped commands without an explicit allowlist", async () => {
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [createEchoCommand()],
    });

    await expect(dispatcher.execute({
      command: "test.echo",
      input: {},
      scope: {
        agentKey: "panda",
        sessionId: "session-main",
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "forbidden",
      },
    });
  });

  it("rejects expired command leases", async () => {
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [createEchoCommand()],
      now: () => new Date("2026-06-24T12:00:00.000Z"),
    });

    await expect(dispatcher.execute({
      command: "test.echo",
      input: {},
      scope: {
        ...scope,
        expiresAt: "2026-06-24T11:59:59.000Z",
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unauthorized",
      },
    });
  });

  it("resolves the live session thread before execution and records command audit", async () => {
    const audit = createAuditStore();
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [{
        ...createEchoCommand(),
        async execute(request) {
          return {
            ok: true,
            command: "test.echo",
            output: {
              threadId: request.scope.threadId,
              secretEcho: request.input.secret,
            },
            summary: "Echoed command.",
          };
        },
      }],
      auditStore: audit.store,
      now: () => new Date("2026-06-24T12:00:00.000Z"),
      resolveScope: (inputScope) => ({
        ...inputScope,
        threadId: "thread-current",
        runId: "run-current",
        parentToolCallId: "bash-call-current",
      }),
    });

    await expect(dispatcher.execute({
      command: "test.echo",
      input: {secret: "do-not-persist"},
      scope,
    })).resolves.toMatchObject({
      ok: true,
      output: {
        threadId: "thread-current",
        secretEcho: "do-not-persist",
      },
    });

    expect(audit.jobs).toMatchObject([{
      threadId: "thread-current",
      runId: "run-current",
      parentToolCallId: "bash-call-current",
      commandOrdinal: 1,
      kind: "command",
      status: "completed",
      summary: "test.echo",
      progress: {
        command: "test.echo",
        outputMode: "json",
        dryRun: false,
      },
    }]);
    expect(audit.updates).toHaveLength(1);
    expect(audit.updates[0]?.update).toMatchObject({
      status: "completed",
      result: {
        command: "test.echo",
        ok: true,
      },
    });
    expect(JSON.stringify(audit.jobs)).not.toContain("do-not-persist");
    expect(JSON.stringify(audit.updates)).not.toContain("do-not-persist");
    expect(JSON.stringify(audit.jobs)).not.toContain("Echoed command.");
  });

  it("assigns stable parent ordinals and persists only sanitized terminal metadata", async () => {
    const audit = createAuditStore();
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [createEchoCommand()],
      auditStore: audit.store,
    });
    const parentScope = {
      ...scope,
      threadId: "thread-lineage",
      runId: "run-lineage",
      parentToolCallId: "bash-call-lineage",
    };

    await Promise.all([
      dispatcher.execute({
        command: "test.echo",
        input: {secret: "lineage-secret"},
        scope: parentScope,
      }),
      dispatcher.execute({
        command: "test.missing",
        input: {secret: "second-lineage-secret"},
        scope: parentScope,
      }),
    ]);

    expect(audit.jobs.map((job) => ({
      runId: job.runId,
      parentToolCallId: job.parentToolCallId,
      commandOrdinal: job.commandOrdinal,
      status: job.status,
    }))).toEqual([
      {
        runId: "run-lineage",
        parentToolCallId: "bash-call-lineage",
        commandOrdinal: 1,
        status: "completed",
      },
      {
        runId: "run-lineage",
        parentToolCallId: "bash-call-lineage",
        commandOrdinal: 2,
        status: "failed",
      },
    ]);
    expect(audit.updates.find(({update}) => update.result?.command === "test.missing")?.update).toMatchObject({
      status: "failed",
      error: null,
      result: {
        command: "test.missing",
        ok: false,
        code: "unknown_command",
      },
    });
    expect(JSON.stringify({jobs: audit.jobs, updates: audit.updates})).not.toContain("lineage-secret");
    await expect(createBashCommandExecutionReader(audit.store)({
      threadId: "thread-lineage",
      runId: "run-lineage",
      parentToolCallId: "bash-call-lineage",
    })).resolves.toEqual([
      {ordinal: 1, command: "test.echo", status: "completed"},
      {ordinal: 2, command: "test.missing", status: "failed", code: "unknown_command"},
    ]);
  });

  it("records forbidden command attempts without executing the handler", async () => {
    const audit = createAuditStore();
    let executed = false;
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [{
        ...createEchoCommand(),
        async execute(request) {
          executed = true;
          return {
            ok: true,
            command: "test.echo",
            output: request.input,
          };
        },
      }],
      auditStore: audit.store,
      resolveScope: (inputScope) => ({
        ...inputScope,
        threadId: "thread-current",
      }),
    });

    await expect(dispatcher.execute({
      command: "test.echo",
      input: {},
      scope: {
        ...scope,
        allowedCommands: ["watch.create"],
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "forbidden",
      },
    });

    expect(executed).toBe(false);
    expect(audit.jobs).toMatchObject([{
      kind: "command",
      status: "failed",
      summary: "test.echo",
    }]);
    expect(audit.updates[0]?.update).toMatchObject({
      status: "failed",
      result: {
        command: "test.echo",
        ok: false,
        code: "forbidden",
      },
    });
  });
});
