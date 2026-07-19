import {mkdir, mkdtemp, readFile, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {
    Agent,
    BackgroundJobCancelTool,
    BackgroundJobStatusTool,
    BackgroundJobWaitTool,
    BashTool,
    type DefaultAgentSessionContext,
    type JsonObject,
    RunContext,
    ToolError,
    type ToolResultMessage,
} from "../src/index.js";
import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import type {ThreadToolJobRecord} from "../src/domain/threads/runtime/types.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";
import type {BashExecutor, BashExecutorOptions} from "../src/integrations/shell/bash-executor.js";
import type {BashExecutionResult} from "../src/integrations/shell/bash-protocol.js";
import type {PandaCommandExecution} from "../src/panda/tools/bash-command-summary.js";

function createAgent() {
  return new Agent({
    name: "test-agent",
    instructions: "Use tools",
  });
}

function createRunContext(
  context: DefaultAgentSessionContext,
  options: {
    signal?: AbortSignal;
    toolCallId?: string;
    onToolProgress?: (progress: JsonObject) => void;
  } = {},
): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: createAgent(),
    toolCallId: options.toolCallId,
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
    signal: options.signal,
    onToolProgress: options.onToolProgress,
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}


class MemoryShellStateStore {
  readonly sessions = new Map<string, {cwd: string; env: Record<string, string>; updatedAt: number}>();
  private nextUpdatedAt = 1;

  async listShellSessions(input: {sessionId: string}) {
    const prefix = `${input.sessionId}:`;
    const latestByEnvironment = new Map<string, {cwd: string; env: Record<string, string>; updatedAt: number}>();

    for (const [key, session] of this.sessions.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      const executionEnvironmentId = key.slice(key.lastIndexOf(":") + 1);
      const existing = latestByEnvironment.get(executionEnvironmentId);
      if (!existing || session.updatedAt >= existing.updatedAt) {
        latestByEnvironment.set(executionEnvironmentId, session);
      }
    }

    return Object.fromEntries([...latestByEnvironment.entries()]
      .map(([executionEnvironmentId, session]) => [executionEnvironmentId, {cwd: session.cwd, env: {...session.env}}]));
  }

  async upsertShellSession(input: {sessionId: string; threadId: string; executionEnvironmentId: string; shellSession: {cwd: string; env: Record<string, string>}}) {
    const key = `${input.sessionId}:${input.threadId}:${input.executionEnvironmentId}`;
    const shellSession = {
      cwd: input.shellSession.cwd,
      env: {...input.shellSession.env},
      updatedAt: this.nextUpdatedAt++,
    };
    this.sessions.set(key, shellSession);
    return {
      sessionId: input.sessionId,
      threadId: input.threadId,
      executionEnvironmentId: input.executionEnvironmentId,
      shellSession: {
        cwd: shellSession.cwd,
        env: {...shellSession.env},
      },
      updatedAt: shellSession.updatedAt,
    };
  }

  read(sessionId: string, threadId: string, executionEnvironmentId = "default") {
    const session = this.sessions.get(`${sessionId}:${threadId}:${executionEnvironmentId}`);
    return session ? {cwd: session.cwd, env: {...session.env}} : undefined;
  }
}


function successfulBashResult(overrides: Partial<BashExecutionResult> = {}): BashExecutionResult {
  const stdout = overrides.stdout ?? "";
  const stderr = overrides.stderr ?? "";
  return {
    shell: "/bin/bash",
    finalCwd: overrides.finalCwd ?? "/tmp",
    durationMs: 1,
    timeoutMs: 15_000,
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    abortReason: null,
    interrupted: false,
    success: true,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutChars: stdout.length,
    stderrChars: stderr.length,
    stdoutPersisted: false,
    stderrPersisted: false,
    noOutput: stdout.length === 0 && stderr.length === 0,
    trackedEnvKeys: [],
    persistedEnvEntries: [],
    ...overrides,
  };
}

class RecordingBashExecutor implements BashExecutor {
  readonly calls: BashExecutorOptions[] = [];

  async execute(options: BashExecutorOptions): Promise<BashExecutionResult> {
    this.calls.push(options);
    return successfulBashResult({
      finalCwd: options.cwd,
      stdout: options.executionEnvironment?.alias ?? "default",
    });
  }
}

const NUL_PLACEHOLDER = "␀";

function expectNoJsonNul(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain("\\u0000");
  expect(serialized).not.toContain("\0");
}

const originalShell = process.env.SHELL;

beforeAll(() => {
  process.env.SHELL = "/bin/bash";
});

afterAll(() => {
  if (originalShell === undefined) {
    delete process.env.SHELL;
  } else {
    process.env.SHELL = originalShell;
  }
});

async function createBackgroundHarness(
  workspace: string,
  options: ConstructorParameters<typeof BashTool>[0] = {},
) {
  const store = new TestThreadRuntimeStore();
  const sessionId = "session-bg";
  await store.createThread({
    id: "thread-bg",
    sessionId,
  });
  const run = await store.createRun("thread-bg");
  const service = new BackgroundToolJobService({
    store,
  });
  const bash = new BashTool({
    ...options,
    outputDirectory: path.join(workspace, "tool-results"),
    jobService: service,
  });
  const status = new BackgroundJobStatusTool({
    service,
  });
  const wait = new BackgroundJobWaitTool({
    service,
  });
  const cancel = new BackgroundJobCancelTool({
    service,
  });
  const context: DefaultAgentSessionContext = {
    sessionId,
    agentKey: "panda",
    threadId: "thread-bg",
    runId: run.id,
    cwd: workspace,
    shell: {
      cwd: workspace,
      env: {},
    },
  };

  return {
    store,
    service,
    bash,
    status,
    wait,
    cancel,
    context,
  };
}

describe("BashTool", () => {
  it("hard-cuts foreground and background lifetime fields before launch", async () => {
    const tool = new BashTool();
    const context = createRunContext({cwd: "/tmp"});

    await expect(tool.run(
      {command: "sleep 1", background: true, timeoutMs: 1_000},
      context,
    )).rejects.toThrow("timeoutMs is foreground-only. For background jobs use maxRuntimeMs.");
    await expect(tool.run(
      {command: "sleep 1", maxRuntimeMs: 1_000},
      context,
    )).rejects.toThrow("maxRuntimeMs requires background=true.");
    await expect(tool.run(
      {command: "sleep 1", background: true, maxRuntimeMs: 21_600_001},
      context,
    )).rejects.toThrow("Too big: expected number to be <=21600000");
  });

  it("formats tool calls and results through the tool instance", () => {
    const tool = new BashTool();
    const result: ToolResultMessage<JsonObject> = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "{\"command\":\"pwd\"}" }],
      details: {
        stdout: "/tmp/workspace\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
      isError: false,
      timestamp: Date.now(),
    };

    expect(tool.formatCall({ command: "pwd" })).toBe("pwd");
    expect(tool.formatCall({ command: "ls", cwd: "/workspace/shared" })).toBe("[cwd /workspace/shared] ls");
    expect(tool.formatResult(result)).toBe("exit 0\n/tmp/workspace");
  });

  it("formats bash failures honestly instead of pretending they succeeded", () => {
    const tool = new BashTool();
    const result: ToolResultMessage<JsonObject> = {
      role: "toolResult",
      toolCallId: "call_2",
      toolName: "bash",
      content: [{ type: "text", text: "permission denied" }],
      details: {
        stderr: "permission denied",
        exitCode: 1,
        timedOut: false,
      },
      isError: true,
      timestamp: Date.now(),
    };

    expect(tool.formatResult(result)).toBe("exit 1\npermission denied");
  });

  it("formats background bash spawns as job updates instead of failures", () => {
    const tool = new BashTool();
    const result: ToolResultMessage<JsonObject> = {
      role: "toolResult",
      toolCallId: "call_3",
      toolName: "bash",
      content: [{ type: "text", text: "{\"jobId\":\"job-1\"}" }],
      details: {
        jobId: "job-1",
        status: "running",
        stdout: "",
        stderr: "",
        sessionStateIsolated: true,
      },
      isError: false,
      timestamp: Date.now(),
    };

    expect(tool.formatResult(result)).toBe("running\njob job-1");
  });

  it("routes foreground bash to an explicit session target", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-target-route-"));
    try {
      const executor = new RecordingBashExecutor();
      const tool = new BashTool({executor});
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-target",
        threadId: "thread-target",
        cwd: workspace,
        executionEnvironment: {
          id: "env-default",
          agentKey: "panda",
          kind: "local",
          state: "ready",
          executionMode: "local",
          initialCwd: workspace,
          credentialPolicy: {mode: "all_agent"},
          skillPolicy: {mode: "all_agent"},
          toolPolicy: {},
          source: "fallback",
        },
        resolveExecutionTarget: async (target) => {
          if (target !== "vps") throw new Error("unknown target");
          return {
            id: "env-vps",
            agentKey: "panda",
            kind: "persistent_agent_runner",
            state: "ready",
            executionMode: "remote",
            runnerUrl: "http://vps:8080",
            initialCwd: "/srv/panda",
            alias: "vps",
            credentialPolicy: {mode: "none"},
            skillPolicy: {mode: "none"},
            toolPolicy: {allowedTools: ["bash"]},
            source: "binding",
          };
        },
      };

      const result = await tool.run({command: "pwd", target: " VPS "}, createRunContext(context));

      expect(asObject(result).stdout).toBe("vps");
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.executionEnvironment).toMatchObject({
        id: "env-vps",
        alias: "vps",
        runnerUrl: "http://vps:8080",
      });
      expect(executor.calls[0]?.run.context?.executionEnvironment?.id).toBe("env-vps");
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("refreshes command access before executing bash in a disposable environment", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-command-refresh-"));
    try {
      const refreshCalls: Array<Parameters<NonNullable<DefaultAgentSessionContext["refreshCommandAccess"]>>[0]> = [];
      const executor: BashExecutor = {
        async execute(options) {
          expect(refreshCalls).toHaveLength(1);
          expect(options.env).toMatchObject({
            PANDA_COMMAND_URL: "http://panda-core:8096",
            PANDA_COMMAND_TOKEN: "fresh-token",
          });
          return successfulBashResult({
            finalCwd: options.cwd,
            stdout: "ok",
          });
        },
      };
      const tool = new BashTool({executor});
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-refresh",
        threadId: "thread-refresh",
        runId: "run-refresh",
        cwd: workspace,
        currentInput: {
          messageId: "message-current",
          source: "tui",
          identityId: "identity-current",
        },
        executionEnvironment: {
          id: "env-disposable",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          executionMode: "remote",
          runnerUrl: "http://runner:8080",
          initialCwd: "/workspace",
          credentialPolicy: {mode: "none"},
          skillPolicy: {mode: "none"},
          toolPolicy: {},
          source: "binding",
        },
        refreshCommandAccess: async (input) => {
          refreshCalls.push(input);
          return {
            refreshed: true,
            commandAccess: {
              url: "http://panda-core:8096",
              token: "fresh-token",
            },
          };
        },
      };

      await tool.run({
        command: "pwd",
        env: {
          PANDA_COMMAND_URL: "http://stale.invalid",
          PANDA_COMMAND_TOKEN: "stale-token",
        },
      }, createRunContext(context, {toolCallId: "bash-call-refresh"}));

      expect(refreshCalls).toEqual([{
        executionEnvironment: expect.objectContaining({
          id: "env-disposable",
        }),
        currentInput: {
          messageId: "message-current",
          source: "tui",
          identityId: "identity-current",
        },
        runId: "run-refresh",
        parentToolCallId: "bash-call-refresh",
      }]);
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("reports completed Panda commands when a later command or shell step fails", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-partial-command-"));
    try {
      const reads: Array<{threadId: string; runId: string; parentToolCallId: string}> = [];
      const tool = new BashTool({
        executor: {
          async execute(options) {
            return successfulBashResult({
              finalCwd: options.cwd,
              success: false,
              exitCode: 1,
              stderr: "later shell step failed",
            });
          },
        },
        commandExecutionReader: async (input) => {
          reads.push(input);
          return [
            {
              ordinal: 1,
              command: "schedule.create",
              status: "completed",
            },
            {
              ordinal: 2,
              command: "a2a.history",
              status: "failed",
              code: "invalid_input",
            },
          ];
        },
      });
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-partial",
        threadId: "thread-partial",
        runId: "run-partial",
        cwd: workspace,
      };

      const error = await tool.run(
        {command: "panda schedule create ... && panda a2a history ..."},
        createRunContext(context, {toolCallId: "bash-call-partial"}),
      ).then(() => undefined, (caught) => caught);

      expect(error).toBeInstanceOf(ToolError);
      expect(asObject((error as ToolError).details)).toMatchObject({
        exitCode: 1,
        partialExecution: true,
        pandaCommands: [
          {ordinal: 1, command: "schedule.create", status: "completed"},
          {ordinal: 2, command: "a2a.history", status: "failed", code: "invalid_input"},
        ],
        remainingShellSteps: "unknown",
        warning: "Earlier Panda commands completed and were not rolled back.",
      });
      expect(reads).toEqual([{
        threadId: "thread-partial",
        runId: "run-partial",
        parentToolCallId: "bash-call-partial",
      }]);
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("surfaces one completed Panda mutation before an unrelated shell failure", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-partial-shell-"));
    try {
      const tool = new BashTool({
        executor: {
          async execute(options) {
            return successfulBashResult({
              finalCwd: options.cwd,
              success: false,
              exitCode: 7,
              stderr: "unrelated command failed",
            });
          },
        },
        commandExecutionReader: async () => [{
          ordinal: 1,
          command: "schedule.create",
          status: "completed",
        }],
      });

      const error = await tool.run(
        {command: "panda schedule create ... && false"},
        createRunContext({
          agentKey: "panda",
          sessionId: "session-shell-failure",
          threadId: "thread-shell-failure",
          runId: "run-shell-failure",
          cwd: workspace,
        }, {toolCallId: "bash-call-shell-failure"}),
      ).then(() => undefined, (caught) => caught);

      expect(asObject((error as ToolError).details)).toMatchObject({
        partialExecution: true,
        pandaCommands: [{ordinal: 1, command: "schedule.create", status: "completed"}],
        remainingShellSteps: "unknown",
      });
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("keeps one successful Panda command compact and orders multiple successful commands", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-command-summary-"));
    try {
      let commands: PandaCommandExecution[] = [{
        ordinal: 1,
        command: "watch.list",
        status: "completed" as const,
      }];
      const tool = new BashTool({
        executor: new RecordingBashExecutor(),
        commandExecutionReader: async () => commands,
      });
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-summary",
        threadId: "thread-summary",
        runId: "run-summary",
        cwd: workspace,
      };

      const single = asObject(await tool.run(
        {command: "panda watch list"},
        createRunContext(context, {toolCallId: "bash-call-single"}),
      ));
      expect(single).not.toHaveProperty("pandaCommands");
      expect(single).not.toHaveProperty("partialExecution");

      commands = [
        {ordinal: 2, command: "watch.show", status: "completed"},
        {ordinal: 1, command: "watch.list", status: "completed"},
      ];
      const multiple = asObject(await tool.run(
        {command: "panda watch list; panda watch show ..."},
        createRunContext(context, {toolCallId: "bash-call-multiple"}),
      ));
      expect(multiple).toMatchObject({
        partialExecution: false,
        pandaCommands: [
          {ordinal: 1, command: "watch.list", status: "completed"},
          {ordinal: 2, command: "watch.show", status: "completed"},
        ],
        remainingShellSteps: "unknown",
      });
      expect(multiple).not.toHaveProperty("warning");

      commands = [
        {ordinal: 1, command: "watch.show", status: "failed", code: "invalid_input"},
        {ordinal: 2, command: "watch.list", status: "completed"},
      ];
      const continued = asObject(await tool.run(
        {command: "panda watch show ...; panda watch list"},
        createRunContext(context, {toolCallId: "bash-call-continued"}),
      ));
      expect(continued).toMatchObject({
        partialExecution: true,
        pandaCommands: [
          {ordinal: 1, command: "watch.show", status: "failed", code: "invalid_input"},
          {ordinal: 2, command: "watch.list", status: "completed"},
        ],
        warning: "Earlier Panda commands completed and were not rolled back.",
      });
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("denies bash when the selected target has no allowlist", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-target-denied-"));
    try {
      const executor = new RecordingBashExecutor();
      const tool = new BashTool({executor});
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-target-denied",
        threadId: "thread-target-denied",
        cwd: workspace,
        executionEnvironment: {
          id: "env-default",
          agentKey: "panda",
          kind: "local",
          state: "ready",
          executionMode: "local",
          initialCwd: workspace,
          credentialPolicy: {mode: "all_agent"},
          skillPolicy: {mode: "all_agent"},
          toolPolicy: {},
          source: "fallback",
        },
        resolveExecutionTarget: async (target) => {
          if (target !== "vps") throw new Error("unknown target");
          return {
            id: "env-vps",
            agentKey: "panda",
            kind: "persistent_agent_runner",
            state: "ready",
            executionMode: "remote",
            runnerUrl: "http://vps:8080",
            initialCwd: "/srv/panda",
            alias: "vps",
            credentialPolicy: {mode: "none"},
            skillPolicy: {mode: "none"},
            toolPolicy: {},
            source: "binding",
          };
        },
      };

      await expect(tool.run({command: "pwd", target: "vps"}, createRunContext(context)))
        .rejects.toThrow("Tool bash is not allowed in execution target vps.");
      expect(executor.calls).toHaveLength(0);
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("keeps target shell cwd and env isolated by execution environment id", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-target-isolation-"));
    try {
      await mkdir(path.join(workspace, "default"));
      await mkdir(path.join(workspace, "vps"));
      const defaultCwd = await realpath(path.join(workspace, "default"));
      const vpsCwd = await realpath(path.join(workspace, "vps"));
      const tool = new BashTool({outputDirectory: path.join(workspace, "tool-results")});
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-target-isolation",
        threadId: "thread-target-isolation",
        cwd: workspace,
        executionEnvironment: {
          id: "env-default",
          agentKey: "panda",
          kind: "local",
          state: "ready",
          executionMode: "local",
          initialCwd: workspace,
          credentialPolicy: {mode: "all_agent"},
          skillPolicy: {mode: "all_agent"},
          toolPolicy: {},
          source: "binding",
        },
        resolveExecutionTarget: async (target) => {
          if (target !== "vps") throw new Error("unknown target");
          return {
            id: "env-vps",
            agentKey: "panda",
            kind: "local",
            state: "ready",
            executionMode: "local",
            initialCwd: workspace,
            alias: "vps",
            credentialPolicy: {mode: "all_agent"},
            skillPolicy: {mode: "all_agent"},
            toolPolicy: {allowedTools: ["bash"]},
            source: "binding",
          };
        },
      };

      await tool.run({command: 'cd default && export TARGET_MARKER="default"'}, createRunContext(context));
      await tool.run({command: 'cd vps && export TARGET_MARKER="vps"', target: "vps"}, createRunContext(context));

      const defaultResult = await tool.run({command: 'printf "%s:%s" "$PWD" "$TARGET_MARKER"'}, createRunContext(context));
      const vpsResult = await tool.run({command: 'printf "%s:%s" "$PWD" "$TARGET_MARKER"', target: "vps"}, createRunContext(context));

      expect(asObject(defaultResult).stdout).toBe(`${defaultCwd}:default`);
      expect(asObject(vpsResult).stdout).toBe(`${vpsCwd}:vps`);
      expect(context.shellSessions?.["env-default"]?.cwd).toBe(defaultCwd);
      expect(context.shellSessions?.["env-vps"]?.cwd).toBe(vpsCwd);
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("starts background bash on the selected target without changing job tool schemas", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-target-background-"));
    try {
      const targetCwd = await realpath(workspace);
      const {service, wait, context} = await createBackgroundHarness("/");
      const bash = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        jobService: service,
      });
      context.cwd = "/";
      context.resolveExecutionTarget = async (target) => {
        if (target !== "vps") throw new Error("unknown target");
        return {
          id: "env-vps",
          agentKey: "panda",
          kind: "local",
          state: "ready",
          executionMode: "local",
          initialCwd: targetCwd,
          alias: "vps",
          credentialPolicy: {mode: "all_agent"},
          skillPolicy: {mode: "all_agent"},
          toolPolicy: {allowedTools: ["bash"]},
          source: "binding",
        };
      };

      const jobResult = await bash.run(
        {command: "pwd", background: true, target: "vps"},
        createRunContext(context),
      );
      const waited = await wait.run({jobId: String(asObject(jobResult).jobId), timeoutMs: 5000}, createRunContext(context));

      expect(asObject(waited).stdout).toBe(`${targetCwd}\n`);
      expect(Object.keys(BackgroundJobStatusTool.schema.shape)).not.toContain("target");
      expect(Object.keys(BackgroundJobWaitTool.schema.shape)).not.toContain("target");
      expect(Object.keys(BackgroundJobCancelTool.schema.shape)).not.toContain("target");
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("fails an unknown explicit bash target before invoking an executor", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-target-missing-"));
    try {
      const executor = new RecordingBashExecutor();
      const tool = new BashTool({executor});
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-target-missing",
        threadId: "thread-target-missing",
        cwd: workspace,
        resolveExecutionTarget: async () => {
          throw new Error("not bound");
        },
      };

      await expect(tool.run({command: "pwd", target: "missing"}, createRunContext(context)))
        .rejects.toThrow("Execution target missing is unavailable.");
      expect(executor.calls).toHaveLength(0);
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("persists cwd changes across calls in the same shell session", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-cwd-"));
    try {
      await mkdir(path.join(workspace, "nested"));
      const expectedNested = await realpath(path.join(workspace, "nested"));

      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });

      const changeDir = await tool.run(
        { command: "cd nested" },
        createRunContext(context),
      );
      const changeDirOutput = asObject(changeDir);

      expect(changeDirOutput.finalCwd).toBe(expectedNested);
      expect(changeDirOutput.cwdChanged).toBe(true);
      expect(context.shell?.cwd).toBe(expectedNested);

      const pwd = await tool.run(
        { command: "pwd" },
        createRunContext(context),
      );
      const pwdOutput = asObject(pwd);

      expect(String(pwdOutput.stdout).trim()).toBe(expectedNested);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("persists simple exported env vars across calls and supports unset", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-env-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });

      const exportResult = await tool.run(
        { command: 'export RUNTIME_TEST_VAR="hello world"' },
        createRunContext(context),
      );
      const exportOutput = asObject(exportResult);

      expect(exportOutput.noOutput).toBe(true);
      expect(context.shell?.env.RUNTIME_TEST_VAR).toBe("hello world");

      const readResult = await tool.run(
        { command: 'printf %s "$RUNTIME_TEST_VAR"' },
        createRunContext(context),
      );
      const readOutput = asObject(readResult);

      expect(String(readOutput.stdout)).toBe("hello world");

      const unsetResult = await tool.run(
        { command: "unset RUNTIME_TEST_VAR" },
        createRunContext(context),
      );

      expect(asObject(unsetResult).noOutput).toBe(true);
      expect(context.shell?.env.RUNTIME_TEST_VAR).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("persists sanitized foreground shell state across fresh run contexts", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-durable-state-"));
    try {
      await mkdir(path.join(workspace, "nested"));
      const expectedNested = await realpath(path.join(workspace, "nested"));
      const shellStateStore = new MemoryShellStateStore();
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        shellStateStore,
      });
      const firstContext: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-shell",
        threadId: "thread-shell",
        cwd: workspace,
      };

      await tool.run(
        {command: 'cd nested && export RUNTIME_TEST_VAR="kept"'},
        createRunContext(firstContext),
      );

      expect(shellStateStore.read("session-shell", "thread-shell")?.cwd).toBe(expectedNested);
      expect(shellStateStore.read("session-shell", "thread-shell")?.env.RUNTIME_TEST_VAR).toBe("kept");

      const secondContext: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-shell",
        threadId: "thread-shell",
        cwd: workspace,
        shellSessions: await shellStateStore.listShellSessions({
          sessionId: "session-shell",
        }),
      };
      const result = await tool.run(
        {command: 'printf "%s:%s" "$PWD" "$RUNTIME_TEST_VAR"'},
        createRunContext(secondContext),
      );

      expect(asObject(result).stdout).toBe(`${expectedNested}:kept`);

      await tool.run(
        {command: "unset RUNTIME_TEST_VAR"},
        createRunContext(secondContext),
      );
      expect(shellStateStore.read("session-shell", "thread-shell")?.env.RUNTIME_TEST_VAR).toBeUndefined();
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("keeps durable shell state isolated by execution environment id", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-durable-envs-"));
    try {
      await mkdir(path.join(workspace, "one"));
      await mkdir(path.join(workspace, "two"));
      const oneCwd = await realpath(path.join(workspace, "one"));
      const twoCwd = await realpath(path.join(workspace, "two"));
      const shellStateStore = new MemoryShellStateStore();
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        shellStateStore,
      });
      const baseContext: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-shell-envs",
        threadId: "thread-shell-envs",
        cwd: workspace,
        executionEnvironment: {
          id: "env-one",
          agentKey: "panda",
          kind: "local",
          state: "ready",
          executionMode: "local",
          initialCwd: workspace,
          credentialPolicy: {mode: "all_agent"},
          toolPolicy: {},
          source: "binding",
        },
      };

      await tool.run({command: 'cd one && export ENV_MARKER="one"'}, createRunContext(baseContext));
      await tool.run({command: 'cd two && export ENV_MARKER="two"'}, createRunContext({
        ...baseContext,
        executionEnvironment: {...baseContext.executionEnvironment!, id: "env-two", initialCwd: workspace},
        shellSessions: await shellStateStore.listShellSessions({sessionId: "session-shell-envs"}),
      }));

      expect(shellStateStore.read("session-shell-envs", "thread-shell-envs", "env-one")?.cwd).toBe(oneCwd);
      expect(shellStateStore.read("session-shell-envs", "thread-shell-envs", "env-one")?.env.ENV_MARKER).toBe("one");
      expect(shellStateStore.read("session-shell-envs", "thread-shell-envs", "env-two")?.cwd).toBe(twoCwd);
      expect(shellStateStore.read("session-shell-envs", "thread-shell-envs", "env-two")?.env.ENV_MARKER).toBe("two");
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("does not write background bash changes to durable shell state", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-durable-background-"));
    try {
      await mkdir(path.join(workspace, "nested"));
      const shellStateStore = new MemoryShellStateStore();
      const {service, wait, context} = await createBackgroundHarness(workspace);
      const bash = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        jobService: service,
        shellStateStore,
      });
      context.sessionId = "session-bg-durable";
      context.threadId = "thread-bg";

      const jobResult = await bash.run(
        {command: 'cd nested && export BG_DURABLE="nope" && printf done', background: true},
        createRunContext(context),
      );
      await wait.run({jobId: String(asObject(jobResult).jobId), timeoutMs: 5000}, createRunContext(context));

      expect(shellStateStore.read("session-bg-durable", "thread-bg")).toBeUndefined();
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("filters credentials, per-call env, reserved keys, and session secrets from durable shell state", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-durable-filter-"));
    try {
      const shellStateStore = new MemoryShellStateStore();
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-filter",
        threadId: "thread-filter",
        cwd: workspace,
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        shellStateStore,
        credentialResolver: {
          resolveEnvironment: async () => ({CREDENTIAL_VALUE: "credential-secret"}),
        },
      });

      await tool.run(
        {
          command: [
            'export SAFE_PUBLIC="kept"',
            'export FROM_CALL="$CALL_VALUE"',
            'export FROM_CREDENTIAL="$CREDENTIAL_VALUE"',
            'export API_TOKEN="secret-ish"',
            'export PANDA_INTERNAL_STATE="runtime"',
          ].join(" && "),
          env: {CALL_VALUE: "call-value"},
        },
        createRunContext(context),
      );

      expect(shellStateStore.read("session-filter", "thread-filter")?.env).toEqual({
        SAFE_PUBLIC: "kept",
      });
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("carries durable shell state into a replacement thread without crossing execution environments", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-durable-thread-"));
    try {
      await mkdir(path.join(workspace, "nested"));
      const expectedNested = await realpath(path.join(workspace, "nested"));
      const workspaceCwd = await realpath(workspace);
      const shellStateStore = new MemoryShellStateStore();
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        shellStateStore,
      });

      await tool.run(
        {command: 'cd nested && export OLD_THREAD_ONLY="old"'},
        createRunContext({agentKey: "panda", sessionId: "session-reset", threadId: "thread-old", cwd: workspace}),
      );

      const replacementContext: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-reset",
        threadId: "thread-new",
        cwd: workspace,
        shellSessions: await shellStateStore.listShellSessions({sessionId: "session-reset"}),
      };
      const replacementResult = await tool.run(
        {command: 'printf "%s:%s" "$PWD" "$OLD_THREAD_ONLY"'},
        createRunContext(replacementContext),
      );

      expect(asObject(replacementResult).stdout).toBe(`${expectedNested}:old`);
      expect(shellStateStore.read("session-reset", "thread-new")?.cwd).toBe(expectedNested);
      expect(shellStateStore.read("session-reset", "thread-new")?.env.OLD_THREAD_ONLY).toBe("old");

      const runnerResult = await tool.run(
        {command: 'printf "%s:%s" "$PWD" "${OLD_THREAD_ONLY:-missing}"'},
        createRunContext({
          ...replacementContext,
          executionEnvironment: {
            id: "env-runner",
            agentKey: "panda",
            kind: "local",
            state: "ready",
            executionMode: "local",
            initialCwd: workspace,
            credentialPolicy: {mode: "all_agent"},
            toolPolicy: {},
            source: "binding",
          },
          shellSessions: await shellStateStore.listShellSessions({sessionId: "session-reset"}),
        }),
      );

      expect(asObject(runnerResult).stdout).toBe(`${workspaceCwd}:missing`);
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("injects resolved credentials before session env and per-call env", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-credentials-"));
    try {
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        cwd: workspace,
        currentInput: {
          source: "tui",
          identityId: "alice-id",
        },
        shell: {
          cwd: workspace,
          env: {
            SHARED_KEY: "session",
            SESSION_ONLY: "session-only",
          },
        },
      };
      const tool = new BashTool({
        env: {
          HOST_ONLY: "host-only",
          SHARED_KEY: "host",
          SHELL: "/bin/bash",
        },
        outputDirectory: path.join(workspace, "tool-results"),
        credentialResolver: {
          resolveEnvironment: async () => ({
            CREDENTIAL_ONLY: "credential-only",
            SHARED_KEY: "credential-value",
          }),
        },
      });

      const result = await tool.run(
        {
          command: [
            'test "${HOST_ONLY:-missing}" = "host-only"',
            'test "${CREDENTIAL_ONLY:-missing}" = "credential-only"',
            'test "${SESSION_ONLY:-missing}" = "session-only"',
            'test "${SHARED_KEY:-missing}" = "call"',
            "printf ok",
          ].join(" && "),
          env: {
            SHARED_KEY: "call",
          },
        },
        createRunContext(context),
      );
      const output = asObject(result);

      expect(String(output.stdout)).toBe("ok");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("filters resolved credentials through the execution environment allowlist", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-credential-allowlist-"));
    try {
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-worker",
        threadId: "thread-worker",
        cwd: workspace,
        executionEnvironment: {
          id: "env-worker",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          executionMode: "local",
          initialCwd: workspace,
          credentialPolicy: {
            mode: "allowlist",
            envKeys: ["ALLOWED_SECRET"],
          },
          toolPolicy: {},
          source: "binding",
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        credentialResolver: {
          resolveEnvironment: async () => ({
            ALLOWED_SECRET: "allowed-secret-value",
            DENIED_SECRET: "denied-secret-value",
          }),
        },
      });

      const result = await tool.run(
        {
          command: [
            'test "${ALLOWED_SECRET:-missing}" = "allowed-secret-value"',
            'test "${DENIED_SECRET:-missing}" = "missing"',
            "printf ok",
          ].join(" && "),
        },
        createRunContext(context),
      );
      const output = asObject(result);

      expect(output.stdout).toBe("ok");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects bash when the execution environment policy disables it", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-tool-policy-"));
    try {
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-worker",
        threadId: "thread-worker",
        cwd: workspace,
        executionEnvironment: {
          id: "env-worker",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          executionMode: "local",
          initialCwd: workspace,
          credentialPolicy: {mode: "none"},
          toolPolicy: {bash: {allowed: false}},
          source: "binding",
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });

      await expect(tool.run(
        {command: "printf should-not-run"},
        createRunContext(context),
      )).rejects.toThrow("Bash is not allowed in this execution environment.");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not migrate legacy shell env into bound disposable environments", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-legacy-shell-env-"));
    try {
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-worker",
        threadId: "thread-worker",
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {
            LEGACY_SECRET: "leaked",
          },
          secretEnvKeys: ["LEGACY_SECRET"],
        },
        executionEnvironment: {
          id: "env-worker",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          executionMode: "local",
          initialCwd: workspace,
          credentialPolicy: {mode: "allowlist", envKeys: []},
          toolPolicy: {},
          source: "binding",
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });

      const result = await tool.run(
        {command: 'printf "${LEGACY_SECRET:-missing}"'},
        createRunContext(context),
      );

      expect(asObject(result).stdout).toBe("missing");
      expect(context.shellSessions?.["env-worker"]?.env.LEGACY_SECRET).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("persists non-secret shell env in constrained disposable environments", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-disposable-shell-env-"));
    try {
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-worker",
        threadId: "thread-worker",
        cwd: workspace,
        executionEnvironment: {
          id: "env-worker",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          executionMode: "local",
          initialCwd: workspace,
          credentialPolicy: {mode: "allowlist", envKeys: []},
          skillPolicy: {mode: "allowlist", skillKeys: []},
          toolPolicy: {},
          source: "binding",
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });

      await tool.run(
        {command: 'export WORKER_TMP_MARKER="kept"'},
        createRunContext(context),
      );
      const result = await tool.run(
        {command: 'printf "%s" "${WORKER_TMP_MARKER:-missing}"'},
        createRunContext(context),
      );

      expect(asObject(result).stdout).toBe("kept");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps shell cwd and env isolated per execution environment", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-env-sessions-"));
    try {
      await mkdir(path.join(workspace, "one"));
      await mkdir(path.join(workspace, "two"));
      const firstCwd = await realpath(path.join(workspace, "one"));
      const secondCwd = await realpath(path.join(workspace, "two"));
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        sessionId: "session-worker",
        threadId: "thread-worker",
        cwd: workspace,
        executionEnvironment: {
          id: "env-one",
          agentKey: "panda",
          kind: "local",
          state: "ready",
          executionMode: "local",
          initialCwd: workspace,
          credentialPolicy: {mode: "all_agent"},
          toolPolicy: {},
          source: "binding",
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });

      await tool.run(
        {command: 'cd one && export ENV_MARKER="one"'},
        createRunContext(context),
      );
      expect(context.shellSessions?.["env-one"]?.cwd).toBe(firstCwd);
      expect(context.shellSessions?.["env-one"]?.env.ENV_MARKER).toBe("one");

      context.executionEnvironment = {
        id: "env-two",
        agentKey: "panda",
        kind: "local",
        state: "ready",
        executionMode: "local",
        initialCwd: secondCwd,
        credentialPolicy: {mode: "all_agent"},
        toolPolicy: {},
        source: "binding",
      };
      const second = await tool.run(
        {command: 'test "${ENV_MARKER:-missing}" = "missing" && pwd'},
        createRunContext(context),
      );
      expect(String(asObject(second).stdout).trim()).toBe(secondCwd);
      expect(context.shellSessions?.["env-two"]?.env.ENV_MARKER).toBeUndefined();

      context.executionEnvironment = {
        id: "env-one",
        agentKey: "panda",
        kind: "local",
        state: "ready",
        executionMode: "local",
        initialCwd: workspace,
        credentialPolicy: {mode: "all_agent"},
        toolPolicy: {},
        source: "binding",
      };
      const first = await tool.run(
        {command: 'printf "%s:%s" "$PWD" "$ENV_MARKER"'},
        createRunContext(context),
      );

      expect(asObject(first).stdout).toBe(`${firstCwd}:one`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps neutral common per-call env values observable and persistable", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-neutral-env-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        maxOutputChars: 80,
        persistOutputThresholdChars: 8,
      });

      const result = await tool.run(
        {
          command: "printf 'test contest latest call'",
          env: {
            NODE_ENV: "test",
            CALL_MARKER: "call",
            LANG: "C.UTF-8",
            TZ: "UTC",
          },
        },
        createRunContext(context),
      );
      const output = asObject(result);

      expect(output.stdout).toBe("test contest latest call");
      expect(String(output.stdout)).not.toContain("[redacted]");
      expect(output.appliedEnvKeys).toEqual(["NODE_ENV", "CALL_MARKER", "LANG", "TZ"]);
      expect(output.stdoutPersisted).toBe(true);
      await expect(readFile(String(output.stdoutPath), "utf8")).resolves.toBe("test contest latest call");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps random-looking non-secret env values ordinary", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-random-env-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });
      const marker = "Aa0!Bb1@Cc2#Dd3$Ee4%Ff5^";

      const first = await tool.run(
        {
          command: 'export SAVED_RANDOM="$RANDOM_VALUE" && printf "%s" "$RANDOM_VALUE"',
          env: {
            RANDOM_VALUE: marker,
          },
        },
        createRunContext(context),
      );
      const firstOutput = asObject(first);

      expect(firstOutput.stdout).toBe(marker);
      expect(firstOutput.appliedEnvKeys).toEqual(["RANDOM_VALUE"]);
      expect(firstOutput.trackedEnvKeys).toEqual(["SAVED_RANDOM"]);
      expect(context.shell?.env.SAVED_RANDOM).toBe(marker);
      expect(context.shell?.secretEnvKeys ?? []).not.toContain("SAVED_RANDOM");

      const second = await tool.run(
        { command: 'printf "%s" "$SAVED_RANDOM"' },
        createRunContext(context),
      );

      expect(asObject(second).stdout).toBe(marker);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts explicit short secret values without hiding unrelated output", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-short-secret-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        maxOutputChars: 80,
        persistOutputThresholdChars: 1,
      });

      const secretResult = await tool.run(
        {
          command: 'export SAVED_SECRET="$CALL_SECRET" && printf "%s" "$CALL_SECRET"',
          env: {
            CALL_SECRET: "test",
          },
        },
        createRunContext(context),
      );
      const unrelatedResult = await tool.run(
        {
          command: "printf unrelated",
        },
        createRunContext(context),
      );
      const secretOutput = asObject(secretResult);
      const unrelatedOutput = asObject(unrelatedResult);

      expect(secretOutput.stdout).toBe("[redacted]");
      expect(unrelatedOutput.stdout).toBe("unrelated");
      expect(secretOutput.appliedEnvKeys).toEqual(["CALL_SECRET"]);
      expect(secretOutput.trackedEnvKeys).toEqual(["SAVED_SECRET"]);
      expect(secretOutput.sessionEnvKeys).toEqual(["SAVED_SECRET"]);
      expect(secretOutput.sessionEnvChanged).toBe(true);
      expect(unrelatedOutput.appliedEnvKeys).toEqual([]);
      expect(unrelatedOutput.trackedEnvKeys).toEqual([]);
      expect(JSON.stringify(secretOutput)).not.toContain("test");
      expect(JSON.stringify(unrelatedOutput)).not.toContain("test");
      expect(JSON.stringify(unrelatedOutput)).toContain("unrelated");
      expect(secretOutput.stdoutPersisted).toBe(false);
      expect(unrelatedOutput.stdoutPersisted).toBe(false);
      expect(secretOutput.stdoutPath).toBeUndefined();
      expect(unrelatedOutput.stdoutPath).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps neutral foreground bash progress observable", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-progress-neutral-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const progress: JsonObject[] = [];
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        progressIntervalMs: 10,
      });

      const result = await tool.run(
        {
          command: 'printf "test contest latest call"; sleep 0.1',
          env: {
            NODE_ENV: "test",
            CALL_MARKER: "call",
          },
        },
        createRunContext(context, {onToolProgress: (entry) => progress.push(entry)}),
      );
      const output = asObject(result);

      expect(output.stdout).toBe("test contest latest call");
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.some((entry) => entry.stdoutTail === "test contest latest call")).toBe(true);
      expect(JSON.stringify(progress)).not.toContain("[redacted]");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts foreground bash progress tails for explicit source secrets", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-progress-redaction-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const progress: JsonObject[] = [];
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        progressIntervalMs: 10,
      });

      const result = await tool.run(
        {
          command: 'printf "%s" "$CALL_SECRET"; printf "%s" "$CALL_SECRET" >&2; sleep 0.1',
          env: {
            CALL_SECRET: "call-secret-value",
          },
        },
        createRunContext(context, {onToolProgress: (entry) => progress.push(entry)}),
      );
      const output = asObject(result);

      expect(output.stdout).toBe("[redacted]");
      expect(output.stderr).toBe("[redacted]");
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.some((entry) => entry.stdoutTail === "[redacted]" && entry.stderrTail === "[redacted]")).toBe(true);
      expect(JSON.stringify(progress)).not.toContain("call-secret-value");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts explicit short secrets in foreground progress without hiding unrelated output", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-progress-short-secret-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const progress: JsonObject[] = [];
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        progressIntervalMs: 10,
      });

      const result = await tool.run(
        {
          command: 'export SAVED_SECRET="$CALL_SECRET"; printf "%s:unrelated" "$CALL_SECRET"; printf "error:%s" "$CALL_SECRET" >&2; sleep 0.1',
          env: {
            CALL_SECRET: "test",
          },
        },
        createRunContext(context, {onToolProgress: (entry) => progress.push(entry)}),
      );
      const output = asObject(result);

      expect(output.stdout).toBe("[redacted]:unrelated");
      expect(output.stderr).toBe("error:[redacted]");
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.some((entry) =>
        entry.stdoutTail === "[redacted]:unrelated"
        && entry.stderrTail === "error:[redacted]",
      )).toBe(true);
      const serialized = JSON.stringify(progress);
      expect(serialized).not.toContain("test");
      expect(serialized).toContain("unrelated");
      expect(serialized).toContain("error");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts credential and per-call env values from bash output", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-redaction-"));
    try {
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        cwd: workspace,
        currentInput: {
          source: "tui",
          identityId: "alice-id",
        },
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        credentialResolver: {
          resolveEnvironment: async () => ({
            OPENAI_API_KEY: "stored-secret-123",
          }),
        },
      });

      const result = await tool.run(
        {
          command: 'printf "%s|%s" "${OPENAI_API_KEY:-missing}" "${CALL_SECRET:-missing}"',
          env: {
            CALL_SECRET: "call-secret-value",
          },
        },
        createRunContext(context),
      );
      const output = asObject(result);

      expect(String(output.stdout)).toBe("[redacted]|[redacted]");
      expect(JSON.stringify(output)).not.toContain("stored-secret-123");
      expect(JSON.stringify(output)).not.toContain("call-secret-value");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts secret values persisted into the shell session across later calls", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-session-secret-"));
    try {
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        cwd: workspace,
        currentInput: {
          source: "tui",
          identityId: "alice-id",
        },
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });

      await tool.run(
        {
          command: 'export SAVED_SECRET="$CALL_SECRET"',
          env: {
            CALL_SECRET: "call-secret-value",
          },
        },
        createRunContext(context),
      );

      expect(context.shell?.env.SAVED_SECRET).toBe("call-secret-value");
      expect(context.shell?.secretEnvKeys).toEqual(["SAVED_SECRET"]);

      const result = await tool.run(
        {
          command: 'printf %s "$SAVED_SECRET"',
        },
        createRunContext(context),
      );
      const output = asObject(result);

      expect(String(output.stdout)).toBe("[redacted]");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not mark neutral exported values as session secrets", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-neutral-session-env-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });

      await tool.run(
        {
          command: 'export WORKER_TMP_MARKER="$CALL_MARKER"',
          env: {
            CALL_MARKER: "call",
          },
        },
        createRunContext(context),
      );

      expect(context.shell?.env.WORKER_TMP_MARKER).toBe("call");
      expect(context.shell?.secretEnvKeys ?? []).not.toContain("WORKER_TMP_MARKER");

      const result = await tool.run(
        { command: 'printf "%s" "$WORKER_TMP_MARKER"' },
        createRunContext(context),
      );

      expect(asObject(result).stdout).toBe("call");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns short stdout previews unchanged without a truncation marker", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-output-short-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        maxOutputChars: 80,
      });

      const result = await tool.run(
        { command: "printf 'short output'" },
        createRunContext(context),
      );
      const output = asObject(result);

      expect(output.stdout).toBe("short output");
      expect(output.stdoutTruncated).toBe(false);
      expect(output.stdoutChars).toBe("short output".length);
      expect(String(output.stdout)).not.toContain("chars truncated");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("persists large stdout to disk while returning a head/tail truncated preview", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-output-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        maxOutputChars: 80,
        persistOutputThresholdChars: 80,
      });
      const fullOutput = `HEAD-${"M".repeat(200)}-TAIL`;

      const result = await tool.run(
        { command: "node -e \"process.stdout.write('HEAD-' + 'M'.repeat(200) + '-TAIL')\"" },
        createRunContext(context),
      );
      const output = asObject(result);
      const stdout = String(output.stdout);

      expect(output.stdoutTruncated).toBe(true);
      expect(output.stdoutChars).toBe(fullOutput.length);
      expect(stdout.length).toBeLessThanOrEqual(80);
      expect(stdout).toMatch(/^HEAD-/);
      expect(stdout).toMatch(/\n\n…\d+ chars truncated…\n\n/);
      expect(stdout.endsWith("-TAIL")).toBe(true);
      expect(stdout).not.toBe(fullOutput);
      expect(output.stdoutPersisted).toBe(true);
      expect(typeof output.stdoutPath).toBe("string");
      await expect(readFile(String(output.stdoutPath), "utf8")).resolves.toBe(fullOutput);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts source secret prefixes split by the head truncation marker", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-secret-head-boundary-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        maxOutputChars: 80,
        persistOutputThresholdChars: 80,
      });
      const secret = "sk-1234567890abcdef1234567890abcdef";

      const result = await tool.run(
        {
          command: "node -e \"process.stdout.write(process.env.CALL_SECRET + 'M'.repeat(200) + 'TAIL')\"",
          env: {
            CALL_SECRET: secret,
          },
        },
        createRunContext(context),
      );
      const output = asObject(result);
      const stdout = String(output.stdout);

      expect(output.stdoutTruncated).toBe(true);
      expect(output.stdoutPersisted).toBe(false);
      expect(output.stdoutPath).toBeUndefined();
      expect(stdout).toContain("[redacted]");
      expect(stdout).toMatch(/\n\n…\d+ chars truncated…\n\n/);
      expect(stdout.endsWith("TAIL")).toBe(true);
      expect(stdout).not.toContain(secret);
      expect(stdout).not.toContain(secret.slice(0, 6));
      expect(stdout).not.toContain(secret.slice(0, 22));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts source secret suffixes split by the tail truncation marker", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-secret-tail-boundary-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        maxOutputChars: 80,
        persistOutputThresholdChars: 80,
      });
      const secret = "ABCDEFGHIJKL";
      const tailPadding = "Z".repeat(27);

      const result = await tool.run(
        {
          command: "node -e \"process.stdout.write('HEAD-' + 'M'.repeat(200) + process.env.CALL_SECRET + 'Z'.repeat(27))\"",
          env: {
            CALL_SECRET: secret,
          },
        },
        createRunContext(context),
      );
      const output = asObject(result);
      const stdout = String(output.stdout);

      expect(output.stdoutTruncated).toBe(true);
      expect(output.stdoutPersisted).toBe(false);
      expect(output.stdoutPath).toBeUndefined();
      expect(stdout).toContain("[redacted]");
      expect(stdout).toMatch(/\n\n…\d+ chars truncated…\n\n/);
      expect(stdout.endsWith(tailPadding)).toBe(true);
      expect(stdout).not.toContain(secret);
      expect(stdout).not.toContain(secret.slice(-6));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("sanitizes NUL bytes in foreground stdout and stderr previews before persistence", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-nul-output-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });

      const result = await tool.run(
        { command: "printf 'hello\\0stdout'; printf 'warn\\0stderr' >&2" },
        createRunContext(context),
      );
      const output = asObject(result);

      expect(output.stdout).toBe(`hello${NUL_PLACEHOLDER}stdout`);
      expect(output.stderr).toBe(`warn${NUL_PLACEHOLDER}stderr`);
      expect(output.stdoutChars).toBe("hello\0stdout".length);
      expect(output.stderrChars).toBe("warn\0stderr".length);
      expectNoJsonNul(output);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("sanitizes NUL bytes in bash error details before persistence", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-nul-error-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });

      try {
        await tool.run(
          { command: "printf 'bad\\0out'; printf 'bad\\0err' >&2; exit 7" },
          createRunContext(context),
        );
        throw new Error("Expected bash command to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(ToolError);
        const details = asObject((error as ToolError).details);
        expect(details.stdout).toBe(`bad${NUL_PLACEHOLDER}out`);
        expect(details.stderr).toBe(`bad${NUL_PLACEHOLDER}err`);
        expect(details.exitCode).toBe(7);
        expectNoJsonNul(details);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not persist large output files for secret-bearing bash calls", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-secret-output-"));
    try {
      const context: DefaultAgentSessionContext = {
        agentKey: "panda",
        cwd: workspace,
        currentInput: {
          source: "tui",
          identityId: "alice-id",
        },
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        maxOutputChars: 8,
        persistOutputThresholdChars: 8,
      });

      const result = await tool.run(
        {
          command: 'printf "%s%s%s%s" "$CALL_SECRET" "$CALL_SECRET" "$CALL_SECRET" "$CALL_SECRET"',
          env: {
            CALL_SECRET: "secret-1",
          },
        },
        createRunContext(context),
      );
      const output = asObject(result);

      expect(output.stdoutTruncated).toBe(true);
      expect(output.stdoutPersisted).toBe(false);
      expect(output).not.toHaveProperty("stdoutPath");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("starts a background bash job and returns a running handle immediately", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-start-"));
    try {
      const {bash, wait, context, store} = await createBackgroundHarness(workspace);

      const started = await bash.run(
        { command: "sleep 0.2 && printf hello", background: true },
        createRunContext(context),
      );
      const startedOutput = asObject(started);

      expect(startedOutput.status).toBe("running");
      expect(typeof startedOutput.jobId).toBe("string");
      expect(startedOutput.sessionStateIsolated).toBe(true);
      expect(startedOutput.mode).toBe("local");
      expect(startedOutput.maxRuntimeMs).toBe(1_800_000);
      expect(startedOutput.expiresAt).toBe(Number(startedOutput.startedAt) + 1_800_000);
      expect(context.shell?.cwd).toBe(workspace);

      const jobId = String(startedOutput.jobId);
      expect((await store.getToolJob(jobId)).status).toBe("running");

      const finished = await wait.run(
        { jobId, timeoutMs: 1_000 },
        createRunContext(context),
      );
      const finishedOutput = asObject(finished);

      expect(finishedOutput.status).toBe("completed");
      expect(String(finishedOutput.stdout)).toBe("hello");
      expect(finishedOutput.sessionStateIsolated).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("exposes the final Panda command summary through background wait and status", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-command-summary-"));
    try {
      const {bash, wait, status, context} = await createBackgroundHarness(workspace, {
        commandExecutionReader: async () => [
          {ordinal: 2, command: "watch.show", status: "completed"},
          {ordinal: 1, command: "watch.list", status: "completed"},
        ],
      });
      const started = asObject(await bash.run(
        {command: "printf done", background: true},
        createRunContext(context, {toolCallId: "bash-call-background-summary"}),
      ));
      const jobId = String(started.jobId);

      const finished = asObject(await wait.run(
        {jobId, timeoutMs: 1_000},
        createRunContext(context),
      ));
      expect(finished).toMatchObject({
        status: "completed",
        partialExecution: false,
        pandaCommands: [
          {ordinal: 1, command: "watch.list", status: "completed"},
          {ordinal: 2, command: "watch.show", status: "completed"},
        ],
        remainingShellSteps: "unknown",
      });

      await expect(status.run(
        {jobId},
        createRunContext(context),
      )).resolves.toMatchObject({
        pandaCommands: [
          {ordinal: 1, command: "watch.list"},
          {ordinal: 2, command: "watch.show"},
        ],
      });
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("defaults background job waits to five minutes", async () => {
    class CapturingJobService extends BackgroundToolJobService {
      capturedTimeoutMs?: number;

      constructor() {
        super({ store: new TestThreadRuntimeStore() });
      }

      override async wait(threadId: string, jobId: string, timeoutMs?: number): Promise<ThreadToolJobRecord> {
        this.capturedTimeoutMs = timeoutMs;
        return {
          id: jobId,
          threadId,
          kind: "spawn_subagent",
          status: "running",
          summary: "captured wait default",
          startedAt: 0,
        };
      }
    }

    const service = new CapturingJobService();
    const wait = new BackgroundJobWaitTool({ service });

    await wait.run(
      { jobId: "job-default" },
      createRunContext({
        sessionId: "session-bg",
        agentKey: "panda",
        threadId: "thread-bg",
      }),
    );

    expect(service.capturedTimeoutMs).toBe(300_000);
  });

  it("does not leave a durable job behind when local background spawn fails", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-start-fail-"));
    try {
      const store = new TestThreadRuntimeStore();
      await store.createThread({
        id: "thread-bg",
        sessionId: "session-bg",
      });
      const service = new BackgroundToolJobService({store});
      const bash = new BashTool({
        shell: path.join(workspace, "missing-shell"),
        outputDirectory: path.join(workspace, "tool-results"),
        jobService: service,
      });
      const context: DefaultAgentSessionContext = {
        sessionId: "session-bg",
        agentKey: "panda",
        threadId: "thread-bg",
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };

      await expect(bash.run(
        { command: "printf nope", background: true },
        createRunContext(context),
      )).rejects.toBeInstanceOf(Error);

      await expect(store.listToolJobs("thread-bg")).resolves.toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps background cwd and env isolated from the shared shell session", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-isolated-"));
    try {
      await mkdir(path.join(workspace, "nested"));
      const expectedNested = await realpath(path.join(workspace, "nested"));
      const {bash, wait, context} = await createBackgroundHarness(workspace);

      const started = await bash.run(
        {
          command: 'cd nested && export BG_ONLY="$CALL_SECRET" && printf done',
          env: {
            CALL_SECRET: "call-secret-value",
          },
          background: true,
        },
        createRunContext(context),
      );
      const jobId = String(asObject(started).jobId);

      expect(context.shell?.cwd).toBe(workspace);
      expect(context.shell?.env.BG_ONLY).toBeUndefined();

      const finished = await wait.run(
        { jobId, timeoutMs: 1_000 },
        createRunContext(context),
      );
      const output = asObject(finished);

      expect(output.status).toBe("completed");
      expect(output.finalCwd).toBe(expectedNested);
      expect(output.trackedEnvKeys).toEqual(["BG_ONLY"]);
      expect(context.shell?.cwd).toBe(workspace);
      expect(context.shell?.env.BG_ONLY).toBeUndefined();
      expect(JSON.stringify(output)).not.toContain("call-secret");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts explicit short source secret output for background jobs without hiding unrelated output", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-short-secret-"));
    try {
      const {bash, status, wait, context} = await createBackgroundHarness(workspace);

      const first = await bash.run(
        {
          command: 'export BG_ONLY="$CALL_SECRET" && sleep 0.05 && printf "%s" "$CALL_SECRET"',
          env: {
            CALL_SECRET: "test",
          },
          background: true,
        },
        createRunContext(context),
      );
      const second = await bash.run(
        {
          command: "printf unrelated",
          env: {
            CALL_SECRET: "test",
          },
          background: true,
        },
        createRunContext(context),
      );

      const firstStarted = asObject(first);
      const firstJobId = String(firstStarted.jobId);
      const firstStatus = asObject(await status.run(
        { jobId: firstJobId },
        createRunContext(context),
      ));
      const firstOutput = asObject(await wait.run(
        { jobId: firstJobId, timeoutMs: 1_000 },
        createRunContext(context),
      ));
      const secondOutput = asObject(await wait.run(
        { jobId: String(asObject(second).jobId), timeoutMs: 1_000 },
        createRunContext(context),
      ));

      expect(firstOutput.stdout).toBe("[redacted]");
      expect(secondOutput.stdout).toBe("unrelated");
      expect(firstStarted.trackedEnvKeys).toEqual(["BG_ONLY"]);
      expect(firstStatus.trackedEnvKeys).toEqual(["BG_ONLY"]);
      expect(firstOutput.trackedEnvKeys).toEqual(["BG_ONLY"]);
      expect(secondOutput.trackedEnvKeys).toEqual([]);
      for (const output of [firstStarted, firstStatus, firstOutput, secondOutput]) {
        expect(JSON.stringify(output)).not.toContain("test");
      }
      expect(JSON.stringify(firstOutput)).toContain("BG_ONLY");
      expect(JSON.stringify(secondOutput)).toContain("unrelated");
      expect(firstOutput.stdoutPersisted).toBe(false);
      expect(secondOutput.stdoutPersisted).toBe(false);
      expect(firstOutput.stdoutPath).toBeUndefined();
      expect(secondOutput.stdoutPath).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs multiple background jobs concurrently while foreground bash keeps mutating the shared session", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-concurrent-"));
    try {
      await mkdir(path.join(workspace, "nested"));
      const expectedNested = await realpath(path.join(workspace, "nested"));
      const {bash, status, wait, context} = await createBackgroundHarness(workspace);

      const first = await bash.run(
        { command: "sleep 0.5 && printf first", background: true },
        createRunContext(context),
      );
      const second = await bash.run(
        { command: "sleep 0.5 && printf second", background: true },
        createRunContext(context),
      );

      const firstJobId = String(asObject(first).jobId);
      const secondJobId = String(asObject(second).jobId);

      const firstStillRunning = await status.run(
        { jobId: firstJobId },
        createRunContext(context),
      );
      const secondStillRunning = await status.run(
        { jobId: secondJobId },
        createRunContext(context),
      );
      expect(asObject(firstStillRunning).status).toBe("running");
      expect(asObject(secondStillRunning).status).toBe("running");

      await bash.run(
        { command: 'cd nested && export FG_ONLY="ok"' },
        createRunContext(context),
      );
      expect(context.shell?.cwd).toBe(expectedNested);
      expect(context.shell?.env.FG_ONLY).toBe("ok");

      const firstFinished = await wait.run(
        { jobId: firstJobId, timeoutMs: 1_000 },
        createRunContext(context),
      );
      const secondFinished = await wait.run(
        { jobId: secondJobId, timeoutMs: 1_000 },
        createRunContext(context),
      );

      expect(asObject(firstFinished).stdout).toBe("first");
      expect(asObject(secondFinished).stdout).toBe("second");
      expect(context.shell?.cwd).toBe(expectedNested);
      expect(context.shell?.env.FG_ONLY).toBe("ok");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("cancels background jobs explicitly", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-cancel-"));
    try {
      const {bash, cancel, status, context} = await createBackgroundHarness(workspace);
      const descendantMarker = path.join(workspace, "cancelled-descendant-ran");

      const started = await bash.run(
        { command: `(sleep 0.3; touch ${JSON.stringify(descendantMarker)}) & wait`, background: true, maxRuntimeMs: 21_600_000 },
        createRunContext(context),
      );
      const jobId = String(asObject(started).jobId);
      expect(asObject(started).maxRuntimeMs).toBe(21_600_000);

      const cancelled = await cancel.run(
        { jobId },
        createRunContext(context),
      );
      const cancelledOutput = asObject(cancelled);

      expect(cancelledOutput.status).toBe("cancelled");
      await new Promise((resolve) => setTimeout(resolve, 400));
      await expect(readFile(descendantMarker)).rejects.toBeDefined();

      const finalStatus = await status.run(
        { jobId },
        createRunContext(context),
      );
      expect(asObject(finalStatus).status).toBe("cancelled");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps background lifetime separate from the foreground timeout", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-lifetime-separate-"));
    try {
      const {bash, wait, context} = await createBackgroundHarness(workspace, {
        defaultForegroundTimeoutMs: 100,
        defaultBackgroundMaxRuntimeMs: 1_000,
      });
      const started = asObject(await bash.run(
        {command: "sleep 0.2 && printf alive", background: true},
        createRunContext(context),
      ));
      const finished = asObject(await wait.run(
        {jobId: String(started.jobId), timeoutMs: 1_000},
        createRunContext(context),
      ));

      expect(finished.status).toBe("completed");
      expect(finished.stdout).toBe("alive");
      expect(finished.maxRuntimeMs).toBe(1_000);
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("marks background maximum-runtime expiry as failed and kills descendants", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-max-runtime-"));
    try {
      const {bash, wait, context} = await createBackgroundHarness(workspace);
      const descendantMarker = path.join(workspace, "expired-descendant-ran");
      const started = asObject(await bash.run(
        {command: `(sleep 0.3; touch ${JSON.stringify(descendantMarker)}) & wait`, background: true, maxRuntimeMs: 100},
        createRunContext(context),
      ));
      const finished = asObject(await wait.run(
        {jobId: String(started.jobId), timeoutMs: 2_000},
        createRunContext(context),
      ));

      expect(finished).toMatchObject({
        status: "failed",
        timedOut: true,
        maxRuntimeMs: 100,
        error: "Background command exceeded 100ms and its process group was terminated.",
        reason: "Background process maximum runtime expired.",
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(readFile(descendantMarker)).rejects.toBeDefined();
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("returns a running wait snapshot without cancelling the background process", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-wait-snapshot-"));
    try {
      const {bash, wait, cancel, context} = await createBackgroundHarness(workspace);
      const started = asObject(await bash.run(
        {command: "sleep 10", background: true},
        createRunContext(context),
      ));
      const snapshot = asObject(await wait.run(
        {jobId: String(started.jobId), timeoutMs: 0},
        createRunContext(context),
      ));

      expect(snapshot.status).toBe("running");
      expect(snapshot.maxRuntimeMs).toBe(1_800_000);
      await expect(cancel.run(
        {jobId: String(started.jobId)},
        createRunContext(context),
      )).resolves.toMatchObject({status: "cancelled"});
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("persists large non-secret background output and avoids persisted files for secret-bearing jobs", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-output-"));
    try {
      const store = new TestThreadRuntimeStore();
      await store.createThread({
        id: "thread-bg",
        sessionId: "session-bg",
      });
      const service = new BackgroundToolJobService({ store });
      const bash = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        maxOutputChars: 80,
        persistOutputThresholdChars: 80,
        jobService: service,
      });
      const wait = new BackgroundJobWaitTool({ service });
      const context: DefaultAgentSessionContext = {
        sessionId: "session-bg",
        agentKey: "panda",
        threadId: "thread-bg",
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };

      const fullOutput = `BG-${"N".repeat(200)}-DONE`;
      const large = await bash.run(
        { command: "node -e \"process.stdout.write('BG-' + 'N'.repeat(200) + '-DONE')\"", background: true },
        createRunContext(context),
      );
      const largeOutput = asObject(await wait.run(
        { jobId: String(asObject(large).jobId), timeoutMs: 1_000 },
        createRunContext(context),
      ));
      const stdout = String(largeOutput.stdout);

      expect(largeOutput.stdoutTruncated).toBe(true);
      expect(largeOutput.stdoutChars).toBe(fullOutput.length);
      expect(stdout.length).toBeLessThanOrEqual(80);
      expect(stdout).toMatch(/^BG-/);
      expect(stdout).toMatch(/\n\n…\d+ chars truncated…\n\n/);
      expect(stdout.endsWith("-DONE")).toBe(true);
      expect(largeOutput.stdoutPersisted).toBe(true);
      await expect(readFile(String(largeOutput.stdoutPath), "utf8")).resolves.toBe(fullOutput);

      const secret = await bash.run(
        {
          command: 'for i in {1..24}; do printf "%s" "$CALL_SECRET"; done',
          env: {
            CALL_SECRET: "secret-1",
          },
          background: true,
        },
        createRunContext(context),
      );
      const secretOutput = asObject(await wait.run(
        { jobId: String(asObject(secret).jobId), timeoutMs: 1_000 },
        createRunContext(context),
      ));

      expect(secretOutput.stdoutTruncated).toBe(true);
      expect(secretOutput.stdoutPersisted).toBe(false);
      expect(secretOutput.stdoutPath).toBeUndefined();
      expect(String(secretOutput.stdout)).toContain("[redacted]");
      expect(String(secretOutput.stdout)).not.toContain("secret");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("sanitizes NUL bytes in persisted background bash previews", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-nul-output-"));
    try {
      const {bash, wait, context, store} = await createBackgroundHarness(workspace);

      const started = await bash.run(
        { command: "printf 'bg\\0out'; printf 'bg\\0err' >&2", background: true },
        createRunContext(context),
      );
      const jobId = String(asObject(started).jobId);
      const finished = await wait.run(
        { jobId, timeoutMs: 1_000 },
        createRunContext(context),
      );
      const output = asObject(finished);

      expect(output.status).toBe("completed");
      expect(output.stdout).toBe(`bg${NUL_PLACEHOLDER}out`);
      expect(output.stderr).toBe(`bg${NUL_PLACEHOLDER}err`);
      expectNoJsonNul(output);

      const stored = await store.getToolJob(jobId);
      expectNoJsonNul(stored.result);
      expectNoJsonNul(stored.progress);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("marks timed out commands as interrupted errors", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-timeout-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });

      await expect(tool.run(
        { command: "sleep 1", timeoutMs: 100 },
        createRunContext(context),
      )).rejects.toThrow(
        "Foreground command exceeded 100ms and its process group was terminated.\nFor servers, watchers, tailers, or other non-terminating processes, use background=true with maxRuntimeMs, verify readiness separately, and cancel the job when finished.",
      );

      try {
        await tool.run(
          { command: "sleep 1", timeoutMs: 100 },
          createRunContext(context),
        );
      } catch (error) {
        expect(error).toBeInstanceOf(ToolError);
        const output = asObject((error as ToolError).details);
        expect(output.timedOut).toBe(true);
        expect(output.interrupted).toBe(true);
        expect(output.success).toBe(false);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("terminates the foreground process group on timeout", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-foreground-process-group-"));
    try {
      const tool = new BashTool({outputDirectory: path.join(workspace, "tool-results")});
      const descendantMarker = path.join(workspace, "foreground-descendant-ran");
      try {
        await tool.run(
          {command: `(sleep 0.3; touch ${JSON.stringify(descendantMarker)}) & wait`, timeoutMs: 100},
          createRunContext({cwd: workspace, shell: {cwd: workspace, env: {}}}),
        );
      } catch (error) {
        expect(error).toBeInstanceOf(ToolError);
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(readFile(descendantMarker)).rejects.toBeDefined();
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  });

  it("aborts spawned commands when the run signal is cancelled", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-abort-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const tool = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
      });
      const controller = new AbortController();
      const promise = tool.run(
        { command: "sleep 5" },
        createRunContext(context, { signal: controller.signal }),
      );

      setTimeout(() => {
        controller.abort(new Error("Stop now"));
      }, 100).unref();

      await expect(promise).rejects.toBeInstanceOf(ToolError);

      try {
        await promise;
      } catch (error) {
        expect(error).toBeInstanceOf(ToolError);
        const output = asObject((error as ToolError).details);
        expect(output.aborted).toBe(true);
        expect(output.interrupted).toBe(true);
        expect(output.success).toBe(false);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
