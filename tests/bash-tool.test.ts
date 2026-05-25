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
import {ACTIVE_PANDA_RUN_ENV} from "../src/app/runtime/active-run-command-client.js";

function createAgent() {
  return new Agent({
    name: "test-agent",
    instructions: "Use tools",
  });
}

function createRunContext(
  context: DefaultAgentSessionContext,
  options: { signal?: AbortSignal; onToolProgress?: (progress: JsonObject) => void } = {},
): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: createAgent(),
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

async function createBackgroundHarness(workspace: string) {
  const store = new TestThreadRuntimeStore();
  const sessionId = "session-bg";
  await store.createThread({
    id: "thread-bg",
    sessionId,
    context: {
      sessionId,
      agentKey: "panda",
    },
  });
  const service = new BackgroundToolJobService({
    store,
  });
  const bash = new BashTool({
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

  it("injects active Panda run ids into command env without persisting them", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-active-run-env-"));
    try {
      const context: DefaultAgentSessionContext = {
        cwd: workspace,
        agentKey: "panda",
        sessionId: "session-1",
        threadId: "thread-1",
        runId: "run-1",
        shell: {
          cwd: workspace,
          env: {},
        },
      };
      const bash = new BashTool({outputDirectory: path.join(workspace, "tool-results")});

      const result = await bash.run({
        command: [
          `printf '%s|%s|%s|%s' "$${ACTIVE_PANDA_RUN_ENV.agentKey}" "$${ACTIVE_PANDA_RUN_ENV.sessionId}" "$${ACTIVE_PANDA_RUN_ENV.threadId}" "$${ACTIVE_PANDA_RUN_ENV.runId}"`,
          `export ${ACTIVE_PANDA_RUN_ENV.runId}=mutated`,
        ].join("; "),
      }, createRunContext(context));

      expect(asObject(result).stdout).toBe("panda|session-1|thread-1|run-1");
      expect(context.shell?.env[ACTIVE_PANDA_RUN_ENV.agentKey]).toBeUndefined();
      expect(context.shell?.env[ACTIVE_PANDA_RUN_ENV.sessionId]).toBeUndefined();
      expect(context.shell?.env[ACTIVE_PANDA_RUN_ENV.threadId]).toBeUndefined();
      expect(context.shell?.env[ACTIVE_PANDA_RUN_ENV.runId]).toBeUndefined();
    } finally {
      await rm(workspace, {recursive: true, force: true});
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
        context: {
          sessionId: "session-bg",
          agentKey: "panda",
        },
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

      const started = await bash.run(
        { command: "sleep 10", background: true },
        createRunContext(context),
      );
      const jobId = String(asObject(started).jobId);

      const cancelled = await cancel.run(
        { jobId },
        createRunContext(context),
      );
      const cancelledOutput = asObject(cancelled);

      expect(cancelledOutput.status).toBe("cancelled");

      const finalStatus = await status.run(
        { jobId },
        createRunContext(context),
      );
      expect(asObject(finalStatus).status).toBe("cancelled");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("persists large non-secret background output and avoids persisted files for secret-bearing jobs", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "runtime-bash-bg-output-"));
    try {
      const store = new TestThreadRuntimeStore();
      await store.createThread({
        id: "thread-bg",
        sessionId: "session-bg",
        context: {
          sessionId: "session-bg",
          agentKey: "panda",
        },
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
      )).rejects.toBeInstanceOf(ToolError);

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
