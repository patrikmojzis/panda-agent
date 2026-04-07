import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  Agent,
  BashTool,
  RunContext,
  type JsonObject,
  type PandaSessionContext,
} from "../src/index.js";

function createAgent() {
  return new Agent({
    name: "test-agent",
    instructions: "Use tools",
    model: "gpt-4o-mini",
  });
}

function createRunContext(context: PandaSessionContext): RunContext<PandaSessionContext> {
  return new RunContext({
    agent: createAgent(),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
  });
}

function asObject(value: JsonObject | null): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

describe("BashTool", () => {
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
      const changeDirOutput = asObject(changeDir.output);

      expect(changeDir.isError).toBe(false);
      expect(changeDirOutput.finalCwd).toBe(expectedNested);
      expect(changeDirOutput.cwdChanged).toBe(true);
      expect(context.shell?.cwd).toBe(expectedNested);

      const pwd = await tool.run(
        { command: "pwd" },
        createRunContext(context),
      );
      const pwdOutput = asObject(pwd.output);

      expect(pwd.isError).toBe(false);
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
      const exportOutput = asObject(exportResult.output);

      expect(exportResult.isError).toBe(false);
      expect(exportOutput.noOutput).toBe(true);
      expect(exportOutput.noOutputExpected).toBe(true);
      expect(context.shell?.env.PANDA_TEST_VAR).toBe("hello world");

      const readResult = await tool.run(
        { command: 'printf %s "$PANDA_TEST_VAR"' },
        createRunContext(context),
      );
      const readOutput = asObject(readResult.output);

      expect(readResult.isError).toBe(false);
      expect(String(readOutput.stdout)).toBe("hello world");

      const unsetResult = await tool.run(
        { command: "unset PANDA_TEST_VAR" },
        createRunContext(context),
      );

      expect(unsetResult.isError).toBe(false);
      expect(context.shell?.env.PANDA_TEST_VAR).toBeUndefined();
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
      const output = asObject(result.output);

      expect(result.isError).toBe(false);
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

      const result = await tool.run(
        { command: "sleep 1", timeoutMs: 100 },
        createRunContext(context),
      );
      const output = asObject(result.output);

      expect(result.isError).toBe(true);
      expect(output.timedOut).toBe(true);
      expect(output.interrupted).toBe(true);
      expect(output.success).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
