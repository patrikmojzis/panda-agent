import {mkdir, mkdtemp, readFile, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {describe, expect, it} from "vitest";

import {
    Agent,
    BashJobCancelTool,
    BashJobStatusTool,
    BashJobWaitTool,
    BashTool,
    type JsonObject,
    type PandaSessionContext,
    RunContext,
    ToolError,
    type ToolResultMessage,
} from "../src/index.js";
import {BashJobService} from "../src/integrations/shell/bash-job-service.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

function createAgent() {
  return new Agent({
    name: "test-agent",
    instructions: "Use tools",
  });
}

function createRunContext(
  context: PandaSessionContext,
  options: { signal?: AbortSignal } = {},
): RunContext<PandaSessionContext> {
  return new RunContext({
    agent: createAgent(),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
    signal: options.signal,
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

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
  const service = new BashJobService({
    store,
  });
  const bash = new BashTool({
    outputDirectory: path.join(workspace, "tool-results"),
    jobService: service,
  });
  const status = new BashJobStatusTool({
    service,
  });
  const wait = new BashJobWaitTool({
    service,
  });
  const cancel = new BashJobCancelTool({
    service,
  });
  const context: PandaSessionContext = {
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
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-cwd-"));
    try {
      await mkdir(path.join(workspace, "nested"));
      const expectedNested = await realpath(path.join(workspace, "nested"));

      const context: PandaSessionContext = {
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
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-env-"));
    try {
      const context: PandaSessionContext = {
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
        { command: 'export PANDA_TEST_VAR="hello world"' },
        createRunContext(context),
      );
      const exportOutput = asObject(exportResult);

      expect(exportOutput.noOutput).toBe(true);
      expect(context.shell?.env.PANDA_TEST_VAR).toBe("hello world");

      const readResult = await tool.run(
        { command: 'printf %s "$PANDA_TEST_VAR"' },
        createRunContext(context),
      );
      const readOutput = asObject(readResult);

      expect(String(readOutput.stdout)).toBe("hello world");

      const unsetResult = await tool.run(
        { command: "unset PANDA_TEST_VAR" },
        createRunContext(context),
      );

      expect(asObject(unsetResult).noOutput).toBe(true);
      expect(context.shell?.env.PANDA_TEST_VAR).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("injects resolved credentials before session env and per-call env", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-credentials-"));
    try {
      const context: PandaSessionContext = {
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
        },
        outputDirectory: path.join(workspace, "tool-results"),
        credentialResolver: {
          resolveEnvironment: async () => ({
            CREDENTIAL_ONLY: "credential-only",
            SHARED_KEY: "credential",
          }),
        } as any,
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

  it("redacts credential and per-call env values from bash output", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-redaction-"));
    try {
      const context: PandaSessionContext = {
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
            OPENAI_API_KEY: "stored-secret",
          }),
        } as any,
      });

      const result = await tool.run(
        {
          command: 'printf "%s|%s" "${OPENAI_API_KEY:-missing}" "${CALL_SECRET:-missing}"',
          env: {
            CALL_SECRET: "call-secret",
          },
        },
        createRunContext(context),
      );
      const output = asObject(result);

      expect(String(output.stdout)).toBe("[redacted]|[redacted]");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("redacts secret values persisted into the shell session across later calls", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-session-secret-"));
    try {
      const context: PandaSessionContext = {
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
            CALL_SECRET: "call-secret",
          },
        },
        createRunContext(context),
      );

      expect(context.shell?.env.SAVED_SECRET).toBe("call-secret");
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

  it("persists large stdout to disk while returning a truncated preview", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-output-"));
    try {
      const context: PandaSessionContext = {
        cwd: workspace,
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
        { command: "printf '0123456789ABCDEF'" },
        createRunContext(context),
      );
      const output = asObject(result);

      expect(output.stdoutTruncated).toBe(true);
      expect(output.stdoutPersisted).toBe(true);
      expect(typeof output.stdoutPath).toBe("string");
      await expect(readFile(String(output.stdoutPath), "utf8")).resolves.toBe("0123456789ABCDEF");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not persist large output files for secret-bearing bash calls", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-secret-output-"));
    try {
      const context: PandaSessionContext = {
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
            CALL_SECRET: "secret",
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
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-bg-start-"));
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
      expect((await store.getBashJob(jobId)).status).toBe("running");

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

  it("does not leave a durable job behind when local background spawn fails", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-bg-start-fail-"));
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
      const service = new BashJobService({
        store,
        shell: path.join(workspace, "missing-shell"),
      });
      const bash = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        jobService: service,
      });
      const context: PandaSessionContext = {
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

      await expect(store.listBashJobs("thread-bg")).resolves.toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps background cwd and env isolated from the shared shell session", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-bg-isolated-"));
    try {
      await mkdir(path.join(workspace, "nested"));
      const expectedNested = await realpath(path.join(workspace, "nested"));
      const {bash, wait, context} = await createBackgroundHarness(workspace);

      const started = await bash.run(
        {
          command: 'cd nested && export BG_ONLY="$CALL_SECRET" && printf done',
          env: {
            CALL_SECRET: "call-secret",
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

  it("runs multiple background jobs concurrently while foreground bash keeps mutating the shared session", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-bg-concurrent-"));
    try {
      await mkdir(path.join(workspace, "nested"));
      const expectedNested = await realpath(path.join(workspace, "nested"));
      const {bash, status, wait, context} = await createBackgroundHarness(workspace);

      const startedAt = Date.now();
      const first = await bash.run(
        { command: "sleep 0.25 && printf first", background: true },
        createRunContext(context),
      );
      const second = await bash.run(
        { command: "sleep 0.25 && printf second", background: true },
        createRunContext(context),
      );

      const firstJobId = String(asObject(first).jobId);
      const secondJobId = String(asObject(second).jobId);

      const stillRunning = await status.run(
        { jobId: firstJobId },
        createRunContext(context),
      );
      expect(asObject(stillRunning).status).toBe("running");

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
      expect(Date.now() - startedAt).toBeLessThan(450);
      expect(context.shell?.cwd).toBe(expectedNested);
      expect(context.shell?.env.FG_ONLY).toBe("ok");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("cancels background jobs explicitly", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-bg-cancel-"));
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
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-bg-output-"));
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
      const service = new BashJobService({ store });
      const bash = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        maxOutputChars: 8,
        persistOutputThresholdChars: 8,
        jobService: service,
      });
      const wait = new BashJobWaitTool({ service });
      const context: PandaSessionContext = {
        sessionId: "session-bg",
        agentKey: "panda",
        threadId: "thread-bg",
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };

      const large = await bash.run(
        { command: "printf '0123456789ABCDEF'", background: true },
        createRunContext(context),
      );
      const largeOutput = asObject(await wait.run(
        { jobId: String(asObject(large).jobId), timeoutMs: 1_000 },
        createRunContext(context),
      ));

      expect(largeOutput.stdoutTruncated).toBe(true);
      expect(largeOutput.stdoutPersisted).toBe(true);
      await expect(readFile(String(largeOutput.stdoutPath), "utf8")).resolves.toBe("0123456789ABCDEF");

      const secret = await bash.run(
        {
          command: 'printf "%s%s%s%s" "$CALL_SECRET" "$CALL_SECRET" "$CALL_SECRET" "$CALL_SECRET"',
          env: {
            CALL_SECRET: "secret",
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

  it("marks timed out commands as interrupted errors", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-timeout-"));
    try {
      const context: PandaSessionContext = {
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
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-bash-abort-"));
    try {
      const context: PandaSessionContext = {
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
