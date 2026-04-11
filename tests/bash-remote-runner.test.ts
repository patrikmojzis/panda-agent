import {mkdir, mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {Agent, BashTool, type PandaSessionContext, RunContext, ToolError,} from "../src/index.js";
import {RemoteShellExecutor, resolveRunnerUrl,} from "../src/integrations/shell/bash-executor.js";
import {type PandaBashRunner, startPandaBashRunner,} from "../src/integrations/shell/bash-runner.js";
import {
    PANDA_RUNNER_AGENT_KEY_HEADER,
    PANDA_RUNNER_EXPECTED_PATH_HEADER,
    PANDA_RUNNER_PATH_SCOPED_HEADER,
} from "../src/integrations/shell/bash-protocol.js";

function createAgent() {
  return new Agent({
    name: "remote-bash-test-agent",
    instructions: "Use tools.",
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

describe("remote bash runner", () => {
  const runners: PandaBashRunner[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    while (runners.length > 0) {
      await runners.pop()?.close();
    }

    while (directories.length > 0) {
      await rm(directories.pop() ?? "", { recursive: true, force: true });
    }
  });

  async function createRunner(agentKey: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<PandaBashRunner> {
    const runner = await startPandaBashRunner({
      agentKey,
      host: "127.0.0.1",
      port: 0,
      env: options.env,
    });
    runners.push(runner);
    return runner;
  }

  async function createWorkspace(prefix: string): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  }

  it("persists cwd changes across remote calls", async () => {
    const projectRoot = await createWorkspace("panda-remote-project-");
    await mkdir(path.join(projectRoot, "nested"));
    const runner = await createRunner("panda");
    const expectedNested = await realpath(path.join(projectRoot, "nested"));
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });
    const context: PandaSessionContext = {
      agentKey: "panda",
      cwd: projectRoot,
      shell: {
        cwd: projectRoot,
        env: {},
      },
    };

    const changeDir = await tool.run(
      { command: "cd nested" },
      createRunContext(context),
    );
    expect(asObject(changeDir).finalCwd).toBe(expectedNested);
    expect(context.shell?.cwd).toBe(expectedNested);

    const pwd = await tool.run(
      { command: "pwd" },
      createRunContext(context),
    );
    expect(String(asObject(pwd).stdout).trim()).toBe(expectedNested);
  });

  it("does not inherit host or session env in remote bash", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
        OPENAI_API_KEY: "sk-secret",
        HOST_MARKER: "host",
      },
    });
    const context: PandaSessionContext = {
      agentKey: "panda",
      cwd: agentHome,
      shell: {
        cwd: agentHome,
        env: {
          SESSION_MARKER: "session",
        },
      },
    };

    const result = await tool.run(
      {
        command: 'printf "%s|%s|%s|%s" "${HOST_MARKER:-missing}" "${SESSION_MARKER:-missing}" "${CALL_MARKER:-missing}" "${OPENAI_API_KEY:-missing}"',
      },
      createRunContext(context),
    );

    expect(String(asObject(result).stdout)).toBe("missing|missing|missing|missing");
  });

  it("does not inherit runner process env in remote bash", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda", {
      env: {
        ...process.env,
        RUNNER_MARKER: "runner",
      },
    });
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });

    const result = await tool.run(
      {
        command: 'printf "%s" "${RUNNER_MARKER:-missing}"',
      },
      createRunContext({
        agentKey: "panda",
        cwd: agentHome,
        shell: {
          cwd: agentHome,
          env: {},
        },
      }),
    );

    expect(String(asObject(result).stdout)).toBe("missing");
  });

  it("rejects env overrides in remote mode", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });

    await expect(tool.run(
      {
        command: "pwd",
        env: {
          OPENAI_API_KEY: "sk-test",
        },
      },
      createRunContext({
        agentKey: "panda",
        cwd: agentHome,
        shell: {
          cwd: agentHome,
          env: {},
        },
      }),
    )).rejects.toThrow("Remote bash does not accept env overrides.");
  });

  it("rejects env payloads at the runner", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");

    const response = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/exec`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PANDA_RUNNER_AGENT_KEY_HEADER]: "panda",
        [PANDA_RUNNER_PATH_SCOPED_HEADER]: "1",
        [PANDA_RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        requestId: "request-strip-env",
        command: 'printf "%s|%s" "${OPENAI_API_KEY:-missing}" "${SAFE_MARKER:-missing}"',
        cwd: agentHome,
        timeoutMs: 1_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
        env: {
          SAFE_MARKER: "hello",
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Runner env overrides are not supported.",
    });
  });

  it("does not persist exported env across remote calls", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });
    const context: PandaSessionContext = {
      agentKey: "panda",
      cwd: agentHome,
      shell: {
        cwd: agentHome,
        env: {},
      },
    };

    await tool.run(
      { command: "export OPENAI_API_KEY=sk-ephemeral" },
      createRunContext(context),
    );

    const result = await tool.run(
      { command: 'printf "%s" "${OPENAI_API_KEY:-missing}"' },
      createRunContext(context),
    );

    expect(String(asObject(result).stdout)).toBe("missing");
    expect(context.shell?.env).toEqual({});
  });

  it("accepts any cwd that exists inside the runner container", async () => {
    const outsider = await createWorkspace("panda-outsider-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });
    const context: PandaSessionContext = {
      agentKey: "panda",
      cwd: outsider,
      shell: {
        cwd: outsider,
        env: {},
      },
    };

    const result = await tool.run(
      { command: "pwd" },
      createRunContext(context),
    );

    expect(String(asObject(result).stdout).trim()).toBe(await realpath(outsider));
    expect(context.shell?.cwd).toBe(await realpath(outsider));
  });

  it("routes runner urls by agent key", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      shell: "/bin/zsh",
      finalCwd: "/workspace",
      durationMs: 1,
      timeoutMs: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      abortReason: null,
      interrupted: false,
      success: true,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutChars: 0,
      stderrChars: 0,
      stdoutPersisted: false,
      stderrPersisted: false,
      noOutput: true,
      trackedEnvKeys: [],
      persistedEnvEntries: [],
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }));
    const executor = new RemoteShellExecutor({
      fetchImpl: fetchImpl as typeof fetch,
      runnerUrlTemplate: "http://runner-{agentKey}:8080/base/{agentKey}",
    });

    await executor.execute({
      command: "pwd",
      cwd: "/workspace",
      timeoutMs: 1_000,
      trackedEnvKeys: [],
      progressIntervalMs: 250,
      progressTailChars: 1_200,
      maxOutputChars: 8_000,
      persistOutputThresholdChars: 8_000,
      outputDirectory: "/tmp",
      env: {
        CALL_MARKER: "hello",
      },
      run: createRunContext({
        agentKey: "work",
        cwd: "/workspace",
        shell: {
          cwd: "/workspace",
          env: {},
        },
      }),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://runner-work:8080/base/work/exec");
    expect(resolveRunnerUrl("http://runner-{agentKey}:8080/base", "work")).toBe("http://runner-work:8080/base");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).not.toHaveProperty("env");
  });

  it("supports a single runner url without an agent key placeholder", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}`,
      },
    });

    const result = await tool.run(
      { command: "pwd" },
      createRunContext({
        agentKey: "panda",
        cwd: agentHome,
        shell: {
          cwd: agentHome,
          env: {},
        },
      }),
    );

    expect(String(asObject(result).stdout).trim()).toBe(await realpath(agentHome));
    expect(resolveRunnerUrl(`http://127.0.0.1:${runner.port}`, "panda")).toBe(`http://127.0.0.1:${runner.port}`);
  });

  it("rejects requests for the wrong agent on path-scoped runner urls", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("jozef");
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/{agentKey}`,
      },
    });

    await expect(tool.run(
      { command: "pwd" },
      createRunContext({
        agentKey: "panda",
        cwd: agentHome,
        shell: {
          cwd: agentHome,
          env: {},
        },
      }),
    )).rejects.toThrow("rejected request for panda");
  });

  it("supports path-scoped runner urls when the agent segment is not the final path segment", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/runners/{agentKey}/bash`,
      },
    });

    const result = await tool.run(
      { command: "pwd" },
      createRunContext({
        agentKey: "panda",
        cwd: agentHome,
        shell: {
          cwd: agentHome,
          env: {},
        },
      }),
    );

    expect(String(asObject(result).stdout).trim()).toBe(await realpath(agentHome));
  });

  it("rejects path-scoped requests when the actual path does not match the expected agent route", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("jozef");
    const response = await fetch(`http://127.0.0.1:${runner.port}/runners/panda/bash/exec`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PANDA_RUNNER_AGENT_KEY_HEADER]: "jozef",
        [PANDA_RUNNER_PATH_SCOPED_HEADER]: "1",
        [PANDA_RUNNER_EXPECTED_PATH_HEADER]: "/runners/jozef/bash",
      },
      body: JSON.stringify({
        requestId: "request-1",
        command: "pwd",
        cwd: agentHome,
        timeoutMs: 1_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("rejected path-scoped request"),
      details: {
        expectedBasePath: "/runners/jozef/bash",
        actualBasePath: "/runners/panda/bash",
      },
    });
  });

  it("lets two agents intentionally share the same mounted workspace", async () => {
    const agentHomeA = await createWorkspace("panda-agent-home-a-");
    const agentHomeB = await createWorkspace("panda-agent-home-b-");
    const sharedWorkspace = await createWorkspace("panda-shared-workspace-");
    const runnerA = await createRunner("panda");
    const runnerB = await createRunner("ops");
    const expectedSharedWorkspace = await realpath(sharedWorkspace);
    const pandaTool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runnerA.port}/agents/{agentKey}`,
      },
    });
    const opsTool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runnerB.port}/agents/{agentKey}`,
      },
    });

    const pandaResult = await pandaTool.run(
      { command: "pwd" },
      createRunContext({
        agentKey: "panda",
        cwd: sharedWorkspace,
        shell: { cwd: sharedWorkspace, env: {} },
      }),
    );
    const opsResult = await opsTool.run(
      { command: "pwd" },
      createRunContext({
        agentKey: "ops",
        cwd: sharedWorkspace,
        shell: { cwd: sharedWorkspace, env: {} },
      }),
    );

    expect(String(asObject(pandaResult).stdout).trim()).toBe(expectedSharedWorkspace);
    expect(String(asObject(opsResult).stdout).trim()).toBe(expectedSharedWorkspace);
  });

  it("aborts remote commands through the runner", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });
    const controller = new AbortController();
    const promise = tool.run(
      { command: "sleep 5" },
      createRunContext({
        agentKey: "panda",
        cwd: agentHome,
        shell: { cwd: agentHome, env: {} },
      }, { signal: controller.signal }),
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
      expect(output.success).toBe(false);
    }
  });
});
