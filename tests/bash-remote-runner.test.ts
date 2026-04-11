import {mkdir, mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {
    Agent,
    BashJobCancelTool,
    BashJobStatusTool,
    BashJobWaitTool,
    BashTool,
    type PandaSessionContext,
    RunContext,
    ToolError,
} from "../src/index.js";
import {BashJobService} from "../src/integrations/shell/bash-job-service.js";
import {RemoteShellExecutor, resolveRunnerUrl,} from "../src/integrations/shell/bash-executor.js";
import {type PandaBashRunner, startPandaBashRunner,} from "../src/integrations/shell/bash-runner.js";
import {
    PANDA_RUNNER_AGENT_KEY_HEADER,
    PANDA_RUNNER_EXPECTED_PATH_HEADER,
    PANDA_RUNNER_PATH_SCOPED_HEADER,
} from "../src/integrations/shell/bash-protocol.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
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

  async function createRemoteBackgroundHarness(workspace: string, runner: PandaBashRunner) {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-bg-remote",
      agentKey: "panda",
    });
    const service = new BashJobService({
      store,
      env: {
        ...process.env,
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });
    const bash = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
      outputDirectory: path.join(workspace, "tool-results"),
      jobService: service,
    });
    const status = new BashJobStatusTool({ service });
    const wait = new BashJobWaitTool({ service });
    const cancel = new BashJobCancelTool({ service });
    const context: PandaSessionContext = {
      threadId: "thread-bg-remote",
      agentKey: "panda",
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

  it("does not inherit tool env, but keeps session env in remote bash", async () => {
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

    expect(String(asObject(result).stdout)).toBe("missing|session|missing|missing");
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

  it("accepts env overrides in remote mode", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });

    const result = await tool.run(
      {
        command: 'test "${OPENAI_API_KEY:-missing}" = "sk-test" && printf ok',
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
    );

    expect(String(asObject(result).stdout)).toBe("ok");
  });

  it("injects resolved credentials into remote bash without giving the runner static host env", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
        OPENAI_API_KEY: "host-secret",
      },
      credentialResolver: {
        resolveEnvironment: async () => ({
          OPENAI_API_KEY: "stored-secret",
          NOTION_API_KEY: "notion-secret",
        }),
      } as any,
    });

    const result = await tool.run(
      {
        command: [
          'test "${OPENAI_API_KEY:-missing}" = "stored-secret"',
          'test "${NOTION_API_KEY:-missing}" = "notion-secret"',
          "printf ok",
        ].join(" && "),
      },
      createRunContext({
        agentKey: "panda",
        identityId: "alice-id",
        cwd: agentHome,
        shell: {
          cwd: agentHome,
          env: {},
        },
      }),
    );

    expect(String(asObject(result).stdout)).toBe("ok");
  });

  it("accepts env payloads at the runner", async () => {
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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      stdout: "missing|hello",
    });
  });

  it("persists exported env across remote calls", async () => {
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

    expect(String(asObject(result).stdout)).toBe("sk-ephemeral");
    expect(context.shell?.env).toEqual({
      OPENAI_API_KEY: "sk-ephemeral",
    });
  });

  it("supports remote background job start, status, wait, and cancel endpoints", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");

    const startResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PANDA_RUNNER_AGENT_KEY_HEADER]: "panda",
        [PANDA_RUNNER_PATH_SCOPED_HEADER]: "1",
        [PANDA_RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "job-direct-1",
        command: "sleep 0.2 && printf done",
        cwd: agentHome,
        timeoutMs: 1_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
        persistOutputThresholdChars: 8_000,
      }),
    });

    expect(startResponse.status).toBe(200);
    await expect(startResponse.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-direct-1",
      status: "running",
    });

    const statusResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PANDA_RUNNER_AGENT_KEY_HEADER]: "panda",
        [PANDA_RUNNER_PATH_SCOPED_HEADER]: "1",
        [PANDA_RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "job-direct-1",
      }),
    });

    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-direct-1",
    });

    const waitResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/wait`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PANDA_RUNNER_AGENT_KEY_HEADER]: "panda",
        [PANDA_RUNNER_PATH_SCOPED_HEADER]: "1",
        [PANDA_RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "job-direct-1",
        timeoutMs: 1_000,
      }),
    });

    expect(waitResponse.status).toBe(200);
    await expect(waitResponse.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-direct-1",
      status: "completed",
      stdout: "done",
    });

    await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PANDA_RUNNER_AGENT_KEY_HEADER]: "panda",
        [PANDA_RUNNER_PATH_SCOPED_HEADER]: "1",
        [PANDA_RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "job-direct-2",
        command: "sleep 10",
        cwd: agentHome,
        timeoutMs: 10_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
        persistOutputThresholdChars: 8_000,
      }),
    });

    const cancelResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PANDA_RUNNER_AGENT_KEY_HEADER]: "panda",
        [PANDA_RUNNER_PATH_SCOPED_HEADER]: "1",
        [PANDA_RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "job-direct-2",
      }),
    });

    expect(cancelResponse.status).toBe(200);
    await expect(cancelResponse.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-direct-2",
      status: "cancelled",
    });

    const completedStatusResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PANDA_RUNNER_AGENT_KEY_HEADER]: "panda",
        [PANDA_RUNNER_PATH_SCOPED_HEADER]: "1",
        [PANDA_RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "job-direct-1",
      }),
    });

    expect(completedStatusResponse.status).toBe(404);

    const cancelledStatusResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PANDA_RUNNER_AGENT_KEY_HEADER]: "panda",
        [PANDA_RUNNER_PATH_SCOPED_HEADER]: "1",
        [PANDA_RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "job-direct-2",
      }),
    });

    expect(cancelledStatusResponse.status).toBe(404);
  });

  it("keeps remote background jobs isolated from the shared shell session", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");
    const {bash, wait, context} = await createRemoteBackgroundHarness(agentHome, runner);
    context.shell!.env.SESSION_MARKER = "session";

    const started = await bash.run(
      {
        command: 'cd /tmp && export BG_ONLY="$CALL_SECRET" && printf "%s|%s" "${SESSION_MARKER:-missing}" "${CALL_MARKER:-missing}"',
        env: {
          CALL_SECRET: "call-secret",
          CALL_MARKER: "call",
        },
        background: true,
      },
      createRunContext(context),
    );

    const finished = await wait.run(
      { jobId: String(asObject(started).jobId), timeoutMs: 1_000 },
      createRunContext(context),
    );
    const output = asObject(finished);

    expect(output.status).toBe("completed");
    expect(String(output.stdout)).toBe("session|[redacted]");
    expect(output.trackedEnvKeys).toEqual(["BG_ONLY"]);
    expect(context.shell?.cwd).toBe(agentHome);
    expect(context.shell?.env.BG_ONLY).toBeUndefined();
    expect(context.shell?.env.SESSION_MARKER).toBe("session");
    expect(JSON.stringify(output)).not.toContain("call-secret");
  });

  it("runs multiple remote background jobs concurrently", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");
    const {bash, wait, context} = await createRemoteBackgroundHarness(agentHome, runner);

    const startedAt = Date.now();
    const first = await bash.run(
      { command: "sleep 0.25 && printf first", background: true },
      createRunContext(context),
    );
    const second = await bash.run(
      { command: "sleep 0.25 && printf second", background: true },
      createRunContext(context),
    );

    const firstFinished = await wait.run(
      { jobId: String(asObject(first).jobId), timeoutMs: 1_000 },
      createRunContext(context),
    );
    const secondFinished = await wait.run(
      { jobId: String(asObject(second).jobId), timeoutMs: 1_000 },
      createRunContext(context),
    );

    expect(asObject(firstFinished).stdout).toBe("first");
    expect(asObject(secondFinished).stdout).toBe("second");
    expect(Date.now() - startedAt).toBeLessThan(450);
  });

  it("fires the remote background completion handler when watcher-owned jobs finish", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");
    const {bash, context, service, store} = await createRemoteBackgroundHarness(agentHome, runner);
    const completedJobIds: string[] = [];
    service.setBackgroundCompletionHandler((record) => {
      completedJobIds.push(record.id);
    });

    const started = await bash.run(
      { command: "sleep 0.1 && printf remote-done", background: true },
      createRunContext(context),
    );
    const jobId = String(asObject(started).jobId);

    await waitFor(() => completedJobIds.includes(jobId));

    expect(completedJobIds).toEqual([jobId]);
    await expect(store.getBashJob(jobId)).resolves.toMatchObject({
      status: "completed",
      stdout: "remote-done",
    });
  });

  it("does not leave a durable job behind when remote background start fails", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-bg-remote",
      agentKey: "panda",
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: "Not found.",
    }), {
      status: 404,
      headers: {
        "content-type": "application/json",
      },
    }));
    const service = new BashJobService({
      store,
      fetchImpl: fetchImpl as typeof fetch,
      env: {
        ...process.env,
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: "http://runner.local/{agentKey}",
      },
    });
    const bash = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: "http://runner.local/{agentKey}",
      },
      jobService: service,
    });
    const context: PandaSessionContext = {
      threadId: "thread-bg-remote",
      agentKey: "panda",
      cwd: "/workspace/shared",
      shell: {
        cwd: "/workspace/shared",
        env: {},
      },
    };

    await expect(bash.run(
      { command: "printf nope", background: true },
      createRunContext(context),
    )).rejects.toBeInstanceOf(ToolError);

    await expect(store.listBashJobs("thread-bg-remote")).resolves.toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns a clean error for unknown remote background jobs", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const runner = await createRunner("panda");
    const response = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PANDA_RUNNER_AGENT_KEY_HEADER]: "panda",
        [PANDA_RUNNER_PATH_SCOPED_HEADER]: "1",
        [PANDA_RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "missing-job",
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Unknown background job missing-job.",
    });

    const {status, context} = await createRemoteBackgroundHarness(agentHome, runner);
    await expect(status.run(
      { jobId: "missing-job" },
      createRunContext(context),
    )).rejects.toBeInstanceOf(ToolError);
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

  it("reports a missing remote cwd clearly for foreground bash", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const missingCwd = path.join(agentHome, "missing-cwd");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        PANDA_BASH_EXECUTION_MODE: "remote",
        PANDA_RUNNER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });

    await expect(tool.run(
      { command: "pwd" },
      createRunContext({
        agentKey: "panda",
        cwd: missingCwd,
        shell: {
          cwd: missingCwd,
          env: {},
        },
      }),
    )).rejects.toThrow(`Requested cwd does not exist inside the remote bash runner: ${missingCwd}`);
  });

  it("reports a missing remote cwd clearly for background bash", async () => {
    const agentHome = await createWorkspace("panda-agent-home-");
    const missingCwd = path.join(agentHome, "missing-cwd");
    const runner = await createRunner("panda");
    const {bash, context, store} = await createRemoteBackgroundHarness(agentHome, runner);
    context.cwd = missingCwd;
    context.shell = {
      cwd: missingCwd,
      env: {},
    };

    await expect(bash.run(
      { command: "sleep 1", background: true },
      createRunContext(context),
    )).rejects.toThrow(`Requested cwd does not exist inside the remote bash runner: ${missingCwd}`);

    await expect(store.listBashJobs("thread-bg-remote")).resolves.toHaveLength(0);
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
    await expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      env: {
        CALL_MARKER: "hello",
      },
    });
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
