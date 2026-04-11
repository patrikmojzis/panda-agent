import {mkdir, mkdtemp, readFile, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {describe, expect, it} from "vitest";

import {
    Agent,
    BashTool,
    type JsonObject,
    type PandaSessionContext,
    RunContext,
    ToolError,
    type ToolResultMessage,
} from "../src/index.js";

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
        identityId: "alice-id",
        cwd: workspace,
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
        identityId: "alice-id",
        cwd: workspace,
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
