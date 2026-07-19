import {describe, expect, it} from "vitest";

import {RuntimeCommandDispatcher} from "../src/app/runtime/command-dispatcher.js";
import {createBashCommandExecutionReader} from "../src/app/runtime/bash-command-summary-reader.js";
import {commandScopeDenied, commandStaleVersionConflict} from "../src/domain/commands/errors.js";
import {COMMAND_AUDIT_METADATA} from "../src/domain/commands/types.js";
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
        details: {
          failureCode: "capability_missing",
          retryable: false,
          requiredCapability: "test.echo",
          nextAction: {
            kind: "discover_capabilities",
            command: "panda commands --output json",
          },
          exitCode: 3,
        },
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
        details: {
          failureCode: "lease_expired",
          retryable: false,
          nextAction: {
            kind: "stop",
          },
          exitCode: 3,
        },
      },
    });
  });

  it("returns a sanitized terminal denial when live scope resolution fails", async () => {
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [createEchoCommand()],
      resolveScope: () => {
        throw new Error("private-token-and-policy-state");
      },
    });

    const result = await dispatcher.execute({command: "test.echo", input: {}, scope});
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unauthorized",
        message: "Panda command scope could not be resolved.",
        details: {
          failureCode: "scope_resolution_failed",
          retryable: false,
          exitCode: 3,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(JSON.stringify(result)).not.toContain("policy-state");
  });

  it("preserves typed command-level denials instead of collapsing them to command_failed", async () => {
    const audit = createAuditStore();
    let attempts = 0;
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [{
        ...createEchoCommand(),
        async execute() {
          attempts += 1;
          throw commandScopeDenied(
            "Credential mutation is not allowed in this execution environment.",
            "command_scope_denied",
            "The current command lease does not permit credential mutation.",
          );
        },
      }],
      auditStore: audit.store,
    });

    const result = await dispatcher.execute({
      command: "test.echo",
      input: {secret: "never-persist-this"},
      scope: {...scope, threadId: "thread-denial"},
    });
    expect(attempts).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "forbidden",
        details: {
          failureCode: "command_scope_denied",
          retryable: false,
          nextAction: {kind: "stop"},
          exitCode: 3,
        },
      },
    });
    expect(audit.updates[0]?.update.result).toEqual({
      command: "test.echo",
      ok: false,
      code: "forbidden",
      failureCode: "command_scope_denied",
      retryable: false,
    });
    expect(JSON.stringify(audit.updates)).not.toContain("never-persist-this");
  });

  it("preserves stale conflict recovery metadata through dispatch and audit without retrying", async () => {
    const audit = createAuditStore();
    let attempts = 0;
    const conflictResource = {
      kind: "wiki_page",
      path: "agents/panda/profile",
      locale: "en",
      latestUpdatedAt: "2026-07-18T20:00:00.000Z",
      content: "private latest content",
    };
    const dispatcher = new RuntimeCommandDispatcher({
      commands: [{
        ...createEchoCommand(),
        async execute() {
          attempts += 1;
          throw commandStaleVersionConflict({
            message: "The Wiki page changed after the supplied baseUpdatedAt.",
            resource: conflictResource,
            nextAction: {
              kind: "refresh_merge_write",
              command: "panda wiki read agents/panda/profile",
            },
          });
        },
      }],
      auditStore: audit.store,
    });

    const result = await dispatcher.execute({
      command: "test.echo",
      input: {content: "private stale content"},
      scope: {...scope, threadId: "thread-conflict"},
    });

    expect(attempts).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        details: {
          failureCode: "stale_version",
          retryable: false,
          requiresRefresh: true,
          resource: {
            kind: "wiki_page",
            path: "agents/panda/profile",
            locale: "en",
            latestUpdatedAt: "2026-07-18T20:00:00.000Z",
          },
          nextAction: {
            kind: "refresh_merge_write",
            command: "panda wiki read agents/panda/profile",
          },
          exitCode: 4,
        },
      },
    });
    expect(audit.updates[0]?.update.result).toEqual({
      command: "test.echo",
      ok: false,
      code: "conflict",
      failureCode: "stale_version",
      retryable: false,
      requiresRefresh: true,
      resource: {
        kind: "wiki_page",
        path: "agents/panda/profile",
        locale: "en",
        latestUpdatedAt: "2026-07-18T20:00:00.000Z",
      },
      nextAction: {
        kind: "refresh_merge_write",
        command: "panda wiki read agents/panda/profile",
      },
      exitCode: 4,
    });
    expect(JSON.stringify(audit.updates)).not.toContain("private stale content");
    expect(JSON.stringify(result)).not.toContain("private latest content");
    expect(JSON.stringify(audit.updates)).not.toContain("private latest content");
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

  it("persists hidden successful retry metadata on the existing command audit", async () => {
    const audit = createAuditStore();
    const command: RegisteredCommand = {
      ...createEchoCommand(),
      async execute(request) {
        return {
          ok: true,
          command: "test.echo",
          output: request.input,
          [COMMAND_AUDIT_METADATA]: {
            attemptCount: 2,
            totalBackoffMs: 1_500,
          },
        };
      },
    };
    const dispatcher = new RuntimeCommandDispatcher({commands: [command], auditStore: audit.store});

    const result = await dispatcher.execute({
      command: "test.echo",
      input: {query: "private-query"},
      scope: {...scope, threadId: "thread-retry"},
    });

    expect(result).toMatchObject({ok: true, output: {query: "private-query"}});
    expect(JSON.stringify(result)).not.toContain("attemptCount");
    expect(audit.jobs).toHaveLength(1);
    expect(audit.updates[0]?.update.result).toEqual({
      command: "test.echo",
      ok: true,
      attemptCount: 2,
      totalBackoffMs: 1_500,
    });
    expect(JSON.stringify(audit.updates)).not.toContain("private-query");
  });

  it("returns rate_limited and whitelists only safe retry audit metadata", async () => {
    const audit = createAuditStore();
    const command: RegisteredCommand = {
      ...createEchoCommand(),
      async execute() {
        const error = new Error("Brave Search remained rate limited after bounded retries.") as Error & {
          pandaCommandErrorCode: "rate_limited";
          pandaCommandErrorDetails: Record<string, unknown>;
        };
        error.pandaCommandErrorCode = "rate_limited";
        error.pandaCommandErrorDetails = {
          provider: "brave",
          status: 429,
          retryable: true,
          retryAfterMs: 8_000,
          attemptCount: 3,
          totalBackoffMs: 5_000,
          failureCode: "rate_limited",
          autoRetryExhausted: true,
          query: "private-query",
          url: "https://private.example/search",
          headers: {authorization: "secret"},
        };
        throw error;
      },
    };
    const dispatcher = new RuntimeCommandDispatcher({commands: [command], auditStore: audit.store});

    const result = await dispatcher.execute({
      command: "test.echo",
      input: {query: "private-input"},
      scope: {...scope, threadId: "thread-rate-limit"},
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "rate_limited",
        details: {
          provider: "brave",
          status: 429,
          retryable: true,
          retryAfterMs: 8_000,
          attemptCount: 3,
          autoRetryExhausted: true,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(audit.jobs).toHaveLength(1);
    expect(audit.updates[0]?.update.result).toEqual({
      command: "test.echo",
      ok: false,
      code: "rate_limited",
      attemptCount: 3,
      totalBackoffMs: 5_000,
      failureCode: "rate_limited",
      retryable: true,
      autoRetryExhausted: true,
    });
    expect(JSON.stringify(audit.updates)).not.toContain("private");
    expect(JSON.stringify(audit.updates)).not.toContain("secret");
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
        failureCode: "capability_missing",
        retryable: false,
      },
    });
  });
});
