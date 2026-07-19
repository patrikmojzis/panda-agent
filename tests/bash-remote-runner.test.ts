import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readFile, realpath, rm} from "node:fs/promises";
import {request as httpRequest} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {
    Agent,
    BackgroundJobCancelTool,
    BackgroundJobStatusTool,
    BackgroundJobWaitTool,
    BashTool,
    type DefaultAgentSessionContext,
    RunContext,
    ToolError,
} from "../src/index.js";
import {ExecutionEnvironmentResolver} from "../src/app/runtime/execution-environment-resolver.js";
import {PostgresExecutionEnvironmentStore} from "../src/domain/execution-environments/postgres.js";
import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import {RemoteShellExecutor, resolveRunnerUrl,} from "../src/integrations/shell/bash-executor.js";
import {
  type CommandExecutor,
  type CommandExecutorExecInput,
  type CommandExecutorJob,
  type CommandExecutorJobStartInput,
  resolveBashRunnerOptions,
  type BashRunner,
  startBashRunner,
} from "../src/integrations/shell/bash-runner.js";
import {
    type BashExecutionResult,
    type BashJobSnapshot,
    RUNNER_AGENT_KEY_HEADER,
    RUNNER_AUTHORIZATION_HEADER,
    RUNNER_EXPECTED_PATH_HEADER,
    RUNNER_PATH_SCOPED_HEADER,
} from "../src/integrations/shell/bash-protocol.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

const execFileAsync = promisify(execFile);

function createAgent() {
  return new Agent({
    name: "remote-bash-test-agent",
    instructions: "Use tools.",
  });
}

function createRunContext(
  context: DefaultAgentSessionContext,
  options: { signal?: AbortSignal } = {},
): RunContext<DefaultAgentSessionContext> {
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
  const runners: BashRunner[] = [];
  const directories: string[] = [];
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();

    while (runners.length > 0) {
      await runners.pop()?.close();
    }

    while (directories.length > 0) {
      await rm(directories.pop() ?? "", { recursive: true, force: true });
    }

    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function createRunner(
    agentKey: string,
    options: {
      env?: NodeJS.ProcessEnv;
      sharedSecret?: string;
      allowedRoots?: readonly string[];
      commandExecutor?: CommandExecutor;
    } = {},
  ): Promise<BashRunner> {
    const runner = await startBashRunner({
      agentKey,
      host: "127.0.0.1",
      port: 0,
      env: options.env,
      sharedSecret: options.sharedSecret,
      allowedRoots: options.allowedRoots,
      commandExecutor: options.commandExecutor,
    });
    runners.push(runner);
    return runner;
  }

  async function createWorkspace(prefix: string): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    const resolved = await realpath(directory);
    directories.push(resolved);
    return resolved;
  }

  async function createDbPool() {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    return pool;
  }

  it("executes bash through a DB-bound runner target alias", async () => {
    const localWorkspace = await createWorkspace("runtime-db-bound-local-");
    const runnerWorkspace = await createWorkspace("runtime-db-bound-runner-");
    const sharedSecret = "db-bound-runner-secret";
    const runner = await createRunner("panda", {
      sharedSecret,
      allowedRoots: [runnerWorkspace],
    });
    const pool = await createDbPool();
    const stores = await createRuntimeStores(pool);
    const environmentStore = new PostgresExecutionEnvironmentStore({pool});
    await environmentStore.ensureSchema();
    const session = await stores.sessionStore.createSession({
      id: "session-db-bound-runner",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-db-bound-runner",
    });
    await stores.threadStore.createThread({
      id: "thread-db-bound-runner",
      sessionId: session.id,
    });
    await environmentStore.createEnvironment({
      id: "env-db-bound-runner",
      agentKey: "panda",
      kind: "persistent_agent_runner",
      runnerUrl: `http://${runner.host}:${runner.port}`,
      runnerCwd: runnerWorkspace,
    });
    await environmentStore.bindSession({
      sessionId: session.id,
      environmentId: "env-db-bound-runner",
      alias: "vps",
      toolPolicy: {allowedTools: ["bash"]},
    });
    const resolver = new ExecutionEnvironmentResolver({store: environmentStore, env: {}});
    const tool = new BashTool({
      env: {BASH_SERVER_SHARED_SECRET: sharedSecret},
    });
    const context: DefaultAgentSessionContext = {
      cwd: localWorkspace,
      agentKey: "panda",
      sessionId: session.id,
      sessionKind: session.kind,
      threadId: "thread-db-bound-runner",
      resolveExecutionTarget: (target) => resolver.resolve(session, target),
    };

    const result = await tool.run({
      command: 'printf "db-bound:%s" "$PWD"',
      target: "vps",
    }, createRunContext(context));

    expect(asObject(result).stdout).toBe(`db-bound:${runnerWorkspace}`);
    expect(asObject(result).stdout).not.toBe(`db-bound:${localWorkspace}`);
  }, 10_000);

  it("rejects deprecated core-side RUNNER_* env even when BASH_SERVER_* is set", () => {
    expect(() => new RemoteShellExecutor({
      runnerUrlTemplate: "http://runner-new/{agentKey}",
      env: {
        RUNNER_URL_TEMPLATE: "http://runner-old/{agentKey}",
        BASH_SERVER_URL_TEMPLATE: "http://runner-new/{agentKey}",
      },
    })).toThrow("RUNNER_URL_TEMPLATE was renamed to BASH_SERVER_URL_TEMPLATE");
  });

  it("rejects deprecated bash-server process RUNNER_* env even when BASH_SERVER_* is set", () => {
    expect(() => resolveBashRunnerOptions({
      RUNNER_AGENT_KEY: "panda",
      BASH_SERVER_AGENT_KEY: "panda",
    })).toThrow("RUNNER_AGENT_KEY was renamed to BASH_SERVER_AGENT_KEY");
  });


  function buildDirectRunnerHeaders(agentKey: string, options: {sharedSecret?: string} = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      [RUNNER_AGENT_KEY_HEADER]: agentKey,
      [RUNNER_PATH_SCOPED_HEADER]: "1",
      [RUNNER_EXPECTED_PATH_HEADER]: `/agents/${agentKey}`,
      ...(options.sharedSecret ? {[RUNNER_AUTHORIZATION_HEADER]: `Bearer ${options.sharedSecret}`} : {}),
    };
  }

  async function createRemoteBackgroundHarness(
    workspace: string,
    runner: BashRunner,
    options: {runnerSharedSecret?: string} = {},
  ) {
    const store = new TestThreadRuntimeStore();
    const sessionId = "session-bg-remote";
    await store.createThread({
      id: "thread-bg-remote",
      sessionId,
    });
    const service = new BackgroundToolJobService({
      store,
      env: {
        ...process.env,
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
        ...(options.runnerSharedSecret ? {BASH_SERVER_SHARED_SECRET: options.runnerSharedSecret} : {}),
      },
    });
    const bash = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
        ...(options.runnerSharedSecret ? {BASH_SERVER_SHARED_SECRET: options.runnerSharedSecret} : {}),
      },
      outputDirectory: path.join(workspace, "tool-results"),
      jobService: service,
    });
    const status = new BackgroundJobStatusTool({ service });
    const wait = new BackgroundJobWaitTool({ service });
    const cancel = new BackgroundJobCancelTool({ service });
    const context: DefaultAgentSessionContext = {
      sessionId,
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
    const projectRoot = await createWorkspace("runtime-remote-project-");
    await mkdir(path.join(projectRoot, "nested"));
    const runner = await createRunner("panda");
    const expectedNested = await realpath(path.join(projectRoot, "nested"));
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });
    const context: DefaultAgentSessionContext = {
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
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
        OPENAI_API_KEY: "sk-secret",
        HOST_MARKER: "host",
      },
    });
    const context: DefaultAgentSessionContext = {
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
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda", {
      env: {
        ...process.env,
        RUNNER_MARKER: "runner",
      },
    });
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
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

  it("starts remote commands with a safe non-leaking command env", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda", {
      env: {
        ...process.env,
        PATH: "/runner-only-bin",
        SHELL: "/runner-shell",
        RUNNER_MARKER: "runner-secret",
      },
    });
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });

    const result = await tool.run(
      {
        command: [
          'test "${RUNNER_MARKER:-missing}" = "missing"',
          'test "$SHELL" = "/bin/bash"',
          `test "$HOME" = ${JSON.stringify(agentHome)}`,
          'test -n "${BASH_VERSION:-}"',
          'test "${PATH#*/runner-only-bin}" = "$PATH"',
          "command -v sed >/dev/null",
          "command -v dirname >/dev/null",
          "command -v uname >/dev/null",
          "command -v node >/dev/null",
          'printf "%s" "$PATH"',
        ].join(" && "),
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

    expect(String(asObject(result).stdout).split(":")).toEqual(expect.arrayContaining([
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
    ]));
  });

  it("starts remote background jobs with SAFE_SHELL despite hostile runner SHELL", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda", {
      env: {
        ...process.env,
        PATH: "/runner-only-bin",
        SHELL: "/runner-shell",
        RUNNER_MARKER: "runner-secret",
      },
    });

    const startResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNNER_AGENT_KEY_HEADER]: "panda",
        [RUNNER_PATH_SCOPED_HEADER]: "1",
        [RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "job-safe-shell",
        command: [
          'test "${RUNNER_MARKER:-missing}" = "missing"',
          'test "$SHELL" = "/bin/bash"',
          `test "$HOME" = ${JSON.stringify(agentHome)}`,
          'test -n "${BASH_VERSION:-}"',
          'test "${PATH#*/runner-only-bin}" = "$PATH"',
          "command -v sed >/dev/null",
          "printf background-ok",
        ].join(" && "),
        cwd: agentHome,
        maxRuntimeMs: 1_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
        persistOutputThresholdChars: 8_000,
      }),
    });

    expect(startResponse.status).toBe(200);

    const waitResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/wait`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNNER_AGENT_KEY_HEADER]: "panda",
        [RUNNER_PATH_SCOPED_HEADER]: "1",
        [RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "job-safe-shell",
        timeoutMs: 1_000,
      }),
    });

    expect(waitResponse.status).toBe(200);
    await expect(waitResponse.json()).resolves.toMatchObject({
      ok: true,
      status: "completed",
      stdout: "background-ok",
    });
  });

  it("appends safe system PATH entries after a persisted project PATH", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const projectBin = path.join(agentHome, "node_modules", ".bin");
    const runner = await createRunner("panda", {
      env: {
        ...process.env,
        SHELL: "/bin/bash",
      },
    });
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });
    const context: DefaultAgentSessionContext = {
      agentKey: "panda",
      cwd: agentHome,
      shell: {
        cwd: agentHome,
        env: {},
      },
    };

    await tool.run(
      { command: `export PATH=${JSON.stringify(projectBin)}` },
      createRunContext(context),
    );

    expect(context.shell?.env.PATH).toBe(projectBin);

    const result = await tool.run(
      {
        command: [
          `case "$PATH" in ${projectBin}:*) ;; *) exit 21 ;; esac`,
          "command -v sed >/dev/null",
          "command -v node >/dev/null",
          'printf "%s" "$PATH"',
        ].join(" && "),
      },
      createRunContext(context),
    );

    const pathEntries = String(asObject(result).stdout).split(":");
    expect(pathEntries[0]).toBe(projectBin);
    expect(pathEntries).toEqual(expect.arrayContaining(["/usr/bin", "/bin"]));
  });

  it("accepts env overrides in remote mode", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });

    const result = await tool.run(
      {
        command: 'test "${OPENAI_API_KEY:-missing}" = "sk-test-123" && printf ok',
        env: {
          OPENAI_API_KEY: "sk-test-123",
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
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
        OPENAI_API_KEY: "host-secret",
      },
      credentialResolver: {
        resolveEnvironment: async () => ({
          OPENAI_API_KEY: "stored-secret-123",
          NOTION_API_KEY: "notion-secret-123",
        }),
      },
    });

    const result = await tool.run(
      {
        command: [
          'test "${OPENAI_API_KEY:-missing}" = "stored-secret-123"',
          'test "${NOTION_API_KEY:-missing}" = "notion-secret-123"',
          "printf ok",
        ].join(" && "),
      },
      createRunContext({
        agentKey: "panda",
        cwd: agentHome,
        currentInput: {
          source: "tui",
          identityId: "alice-id",
        },
        shell: {
          cwd: agentHome,
          env: {},
        },
      }),
    );

    expect(String(asObject(result).stdout)).toBe("ok");
  });


  function fakeExecResult(input: CommandExecutorExecInput): BashExecutionResult {
    return {
      shell: "/bin/bash",
      finalCwd: input.cwd,
      durationMs: 1,
      timeoutMs: input.request.timeoutMs,
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      abortReason: null,
      interrupted: false,
      success: true,
      stdout: `fake-exec:${input.request.command}:${input.request.env?.MARKER ?? "missing"}`,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutChars: `fake-exec:${input.request.command}:${input.request.env?.MARKER ?? "missing"}`.length,
      stderrChars: 0,
      stdoutPersisted: false,
      stderrPersisted: false,
      noOutput: false,
      trackedEnvKeys: input.request.trackedEnvKeys,
      persistedEnvEntries: [],
    };
  }

  function fakeJobSnapshot(input: CommandExecutorJobStartInput, status: BashJobSnapshot["status"]): BashJobSnapshot {
    const finished = status !== "running";
    const startedAt = Date.now();
    return {
      jobId: input.request.jobId,
      status,
      command: input.request.command,
      initialCwd: input.cwd,
      maxRuntimeMs: input.request.maxRuntimeMs,
      expiresAt: startedAt + input.request.maxRuntimeMs,
      startedAt,
      timedOut: false,
      stdout: status === "completed" ? "fake-job-done" : "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutChars: status === "completed" ? "fake-job-done".length : 0,
      stderrChars: 0,
      stdoutPersisted: false,
      stderrPersisted: false,
      trackedEnvKeys: input.request.trackedEnvKeys,
      ...(finished ? {finishedAt: startedAt + 333, durationMs: 333, exitCode: 0, signal: null, finalCwd: input.cwd} : {}),
    };
  }

  async function requestDirectRunnerJob(
    runner: BashRunner,
    endpoint: "start" | "status" | "wait" | "cancel",
    body: Record<string, unknown>,
    options: {sharedSecret?: string} = {},
  ): Promise<Response> {
    return fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/${endpoint}`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda", options),
      body: JSON.stringify(body),
    });
  }

  function directJobStartRequest(jobId: string, cwd: string, command = "printf fake-job-done") {
    return {
      jobId,
      command,
      cwd,
      maxRuntimeMs: 1_000,
      trackedEnvKeys: [],
      maxOutputChars: 8_000,
      persistOutputThresholdChars: 8_000,
    };
  }

  function createControlledBackgroundExecutor(
    terminalStatus: BashJobSnapshot["status"] = "completed",
  ): {
    commandExecutor: CommandExecutor;
    complete(): void;
    watcherReturned: Promise<void>;
    waitTimeouts: Array<number | undefined>;
    cancelCalls(): number;
  } {
    let status: BashJobSnapshot["status"] = "running";
    let releaseCompletion!: () => void;
    let markWatcherReturned!: () => void;
    let cancelCallCount = 0;
    const completion = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const watcherReturned = new Promise<void>((resolve) => {
      markWatcherReturned = resolve;
    });
    const waitTimeouts: Array<number | undefined> = [];

    return {
      commandExecutor: {
        execute: async () => {
          throw new Error("unexpected exec");
        },
        startJob: async (input) => ({
          snapshot: () => fakeJobSnapshot(input, status),
          wait: async (timeoutMs) => {
            waitTimeouts.push(timeoutMs);
            await completion;
            status = terminalStatus;
            markWatcherReturned();
            return fakeJobSnapshot(input, status);
          },
          cancel: async () => {
            cancelCallCount += 1;
            status = "cancelled";
            return fakeJobSnapshot(input, status);
          },
        }),
      },
      complete: releaseCompletion,
      watcherReturned,
      waitTimeouts,
      cancelCalls: () => cancelCallCount,
    };
  }

  it("retains watcher-completed output through status until the first terminal wait consumes it", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const controlled = createControlledBackgroundExecutor();
    const runner = await createRunner("panda", {commandExecutor: controlled.commandExecutor});

    const startResponse = await requestDirectRunnerJob(runner, "start", {
      jobId: "job-retained-terminal",
      command: "printf fake-job-done",
      cwd: agentHome,
      maxRuntimeMs: 1_000,
      trackedEnvKeys: [],
      maxOutputChars: 8_000,
      persistOutputThresholdChars: 8_000,
    });
    expect(startResponse.status).toBe(200);
    await expect(startResponse.json()).resolves.toMatchObject({status: "running"});

    controlled.complete();
    await controlled.watcherReturned;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const statusResponse = await requestDirectRunnerJob(runner, "status", {jobId: "job-retained-terminal"});
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({status: "completed", stdout: "fake-job-done"});

    const duplicateStart = await requestDirectRunnerJob(runner, "start", {
      jobId: "job-retained-terminal",
      command: "printf replacement",
      cwd: agentHome,
      maxRuntimeMs: 1_000,
      trackedEnvKeys: [],
      maxOutputChars: 8_000,
      persistOutputThresholdChars: 8_000,
    });
    expect(duplicateStart.status).toBe(400);

    const waitResponse = await requestDirectRunnerJob(runner, "wait", {
      jobId: "job-retained-terminal",
      timeoutMs: 1_000,
    });
    expect(waitResponse.status).toBe(200);
    await expect(waitResponse.json()).resolves.toMatchObject({status: "completed", stdout: "fake-job-done"});
    expect(controlled.waitTimeouts).toEqual([5_000]);

    const repeatedWait = await requestDirectRunnerJob(runner, "wait", {
      jobId: "job-retained-terminal",
      timeoutMs: 1_000,
    });
    expect(repeatedWait.status).toBe(404);
  });

  it("retains a complete immutable terminal snapshot observed before the start response", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    let snapshotCalls = 0;
    let waitCalls = 0;
    let cancelCalls = 0;
    let terminalSnapshot: BashJobSnapshot | undefined;
    const runner = await createRunner("panda", {
      commandExecutor: {
        execute: async () => {
          throw new Error("unexpected exec");
        },
        startJob: async (input) => {
          terminalSnapshot = fakeJobSnapshot(input, "completed");
          return {
            snapshot: () => {
              snapshotCalls += 1;
              return terminalSnapshot!;
            },
            wait: async () => {
              waitCalls += 1;
              throw new Error("terminal snapshot should not call executor wait");
            },
            cancel: async () => {
              cancelCalls += 1;
              throw new Error("terminal snapshot should not call executor cancel");
            },
          };
        },
      },
    });

    const startResponse = await requestDirectRunnerJob(
      runner,
      "start",
      directJobStartRequest("job-terminal-at-start", agentHome),
    );
    expect(startResponse.status).toBe(200);
    await expect(startResponse.json()).resolves.toMatchObject({
      status: "completed",
      stdout: "fake-job-done",
      maxRuntimeMs: 1_000,
      expiresAt: expect.any(Number),
      finishedAt: expect.any(Number),
      durationMs: 333,
      exitCode: 0,
      signal: null,
    });

    terminalSnapshot!.stdout = "mutated-after-publication";
    terminalSnapshot!.trackedEnvKeys.push("MUTATED");
    const statusResponse = await requestDirectRunnerJob(runner, "status", {jobId: "job-terminal-at-start"});
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      status: "completed",
      stdout: "fake-job-done",
      trackedEnvKeys: [],
    });

    const waitResponse = await requestDirectRunnerJob(runner, "wait", {jobId: "job-terminal-at-start"});
    expect(waitResponse.status).toBe(200);
    await expect(waitResponse.json()).resolves.toMatchObject({status: "completed", stdout: "fake-job-done"});
    expect({snapshotCalls, waitCalls, cancelCalls}).toEqual({snapshotCalls: 1, waitCalls: 0, cancelCalls: 0});
  });

  it.each(["failed", "cancelled"] as const)(
    "retains a %s watcher result until terminal wait consumes it",
    async (terminalStatus) => {
      const agentHome = await createWorkspace("runtime-agent-home-");
      const controlled = createControlledBackgroundExecutor(terminalStatus);
      const runner = await createRunner("panda", {commandExecutor: controlled.commandExecutor});
      const jobId = `job-retained-${terminalStatus}`;

      const startResponse = await requestDirectRunnerJob(
        runner,
        "start",
        directJobStartRequest(jobId, agentHome, "exit 1"),
      );
      expect(startResponse.status).toBe(200);
      controlled.complete();
      await controlled.watcherReturned;
      await new Promise<void>((resolve) => setImmediate(resolve));

      const statusResponse = await requestDirectRunnerJob(runner, "status", {jobId});
      expect(statusResponse.status).toBe(200);
      await expect(statusResponse.json()).resolves.toMatchObject({
        status: terminalStatus,
        maxRuntimeMs: 1_000,
        expiresAt: expect.any(Number),
      });
      const waitResponse = await requestDirectRunnerJob(runner, "wait", {jobId, timeoutMs: 1_000});
      expect(waitResponse.status).toBe(200);
      await expect(waitResponse.json()).resolves.toMatchObject({status: terminalStatus});
      expect((await requestDirectRunnerJob(runner, "wait", {jobId})).status).toBe(404);
    },
  );

  it("retains through the 65-second client envelope and expires at the 90-second boundary", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const controlled = createControlledBackgroundExecutor();
    const runner = await createRunner("panda", {commandExecutor: controlled.commandExecutor});
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const startResponse = await requestDirectRunnerJob(
      runner,
      "start",
      directJobStartRequest("job-terminal-expiry", agentHome),
    );
    expect(startResponse.status).toBe(200);
    controlled.complete();
    await controlled.watcherReturned;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const timerCallIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 90_000);
    expect(timerCallIndex).toBeGreaterThanOrEqual(0);
    expect(90_000).toBeGreaterThan(65_000);
    const retained = await requestDirectRunnerJob(runner, "status", {jobId: "job-terminal-expiry"});
    expect(retained.status).toBe(200);

    const expiryCallback = setTimeoutSpy.mock.calls[timerCallIndex]?.[0];
    if (typeof expiryCallback !== "function") throw new Error("Expected terminal expiry callback.");
    expiryCallback();
    expect((await requestDirectRunnerJob(runner, "status", {jobId: "job-terminal-expiry"})).status).toBe(404);
  });

  it("unrefs terminal retention and clears retained state on runner close", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const controlled = createControlledBackgroundExecutor();
    const runner = await createRunner("panda", {commandExecutor: controlled.commandExecutor});
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    expect((await requestDirectRunnerJob(
      runner,
      "start",
      directJobStartRequest("job-terminal-close", agentHome),
    )).status).toBe(200);
    controlled.complete();
    await controlled.watcherReturned;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const timerCallIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 90_000);
    expect(timerCallIndex).toBeGreaterThanOrEqual(0);
    const retentionTimer = setTimeoutSpy.mock.results[timerCallIndex]?.value as NodeJS.Timeout;
    expect(retentionTimer.hasRef()).toBe(false);

    await runner.close();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(retentionTimer);
    expect(controlled.cancelCalls()).toBe(0);
    expect(runner.server.listening).toBe(false);
  });

  it("recovers from a watcher rejection and releases the credential-shaped executor job", async () => {
    const script = `
      import {startBashRunner} from "./src/integrations/shell/bash-runner.ts";
      let releaseCompletion;
      let markWatcherRejected;
      let markWatcherReturned;
      let jobReference;
      let waitCalls = 0;
      const completion = new Promise((resolve) => { releaseCompletion = resolve; });
      const watcherRejected = new Promise((resolve) => { markWatcherRejected = resolve; });
      const watcherReturned = new Promise((resolve) => { markWatcherReturned = resolve; });
      const snapshot = (input, status) => {
        const startedAt = Date.now();
        return ({
        jobId: input.request.jobId,
        status,
        command: input.request.command,
        initialCwd: input.cwd,
        maxRuntimeMs: input.request.maxRuntimeMs,
        expiresAt: startedAt + input.request.maxRuntimeMs,
        startedAt,
        timedOut: false,
        stdout: status === "completed" ? "done" : "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutChars: status === "completed" ? 4 : 0,
        stderrChars: 0,
        stdoutPersisted: false,
        stderrPersisted: false,
        trackedEnvKeys: [],
        ...(status === "running" ? {} : {finishedAt: startedAt + 1, durationMs: 1, exitCode: 0, signal: null}),
      });
      };
      const runner = await startBashRunner({
        agentKey: "panda",
        host: "127.0.0.1",
        port: 0,
        commandExecutor: {
          execute: async () => { throw new Error("unexpected exec"); },
          startJob: async (input) => {
            let status = "running";
            const job = {
              credentialShapedEnv: {OPENAI_API_KEY: "sk-shaped-not-a-real-secret"},
              snapshot: () => snapshot(input, status),
              wait: async () => {
                waitCalls += 1;
                if (waitCalls === 1) {
                  markWatcherRejected();
                  throw new Error("transient watcher transport failure");
                }
                await completion;
                status = "completed";
                markWatcherReturned();
                return snapshot(input, status);
              },
              cancel: async () => {
                status = "cancelled";
                return snapshot(input, status);
              },
            };
            jobReference = new WeakRef(job);
            return job;
          },
        },
      });
      try {
        const response = await fetch("http://127.0.0.1:" + runner.port + "/agents/panda/jobs/start", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-runtime-agent-key": "panda",
            "x-runtime-agent-path-scoped": "1",
            "x-runtime-expected-path": "/agents/panda",
          },
          body: JSON.stringify({
            jobId: "job-weak-reference",
            command: "printf done",
            cwd: process.cwd(),
            maxRuntimeMs: 1_000,
            trackedEnvKeys: [],
            maxOutputChars: 8_000,
            persistOutputThresholdChars: 8_000,
          }),
        });
        if (response.status !== 200) throw new Error("start failed: " + response.status);
        await response.json();
        await watcherRejected;
        releaseCompletion();
        await watcherReturned;
        if (waitCalls !== 2) throw new Error("watcher did not retry exactly once: " + waitCalls);
        await new Promise((resolve) => setImmediate(resolve));
        for (let index = 0; index < 20; index += 1) {
          global.gc();
          await new Promise((resolve) => setImmediate(resolve));
          if (!jobReference.deref()) break;
        }
        if (jobReference.deref()) throw new Error("terminal state retained the credential-shaped executor job");
        process.stdout.write("executor-job-released");
      } finally {
        await runner.close();
      }
    `;

    const result = await execFileAsync(process.execPath, [
      "--expose-gc",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ], {cwd: path.resolve("."), timeout: 10_000});
    expect(result.stdout).toBe("executor-job-released");
  }, 15_000);

  it("allows only one of two concurrent waits to consume a running job's terminal result", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const controlled = createControlledBackgroundExecutor();
    const runner = await createRunner("panda", {commandExecutor: controlled.commandExecutor});
    expect((await requestDirectRunnerJob(
      runner,
      "start",
      directJobStartRequest("job-concurrent-waits", agentHome),
    )).status).toBe(200);

    const waits = [
      requestDirectRunnerJob(runner, "wait", {jobId: "job-concurrent-waits", timeoutMs: 1_000}),
      requestDirectRunnerJob(runner, "wait", {jobId: "job-concurrent-waits", timeoutMs: 1_000}),
    ];
    await vi.waitFor(() => {
      expect(controlled.waitTimeouts.filter((timeoutMs) => timeoutMs === 1_000)).toHaveLength(2);
    });
    controlled.complete();

    const responses = await Promise.all(waits);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
    const bodies = await Promise.all(responses.map((response) => response.json())) as Array<Record<string, unknown>>;
    expect(bodies).toContainEqual(expect.objectContaining({status: "completed", stdout: "fake-job-done"}));
    expect(bodies).toContainEqual(expect.objectContaining({error: "Unknown background job job-concurrent-waits."}));
  });

  it("lets cancel consume while an earlier wait finishes with the unknown-job contract", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const controlled = createControlledBackgroundExecutor();
    const runner = await createRunner("panda", {commandExecutor: controlled.commandExecutor});
    expect((await requestDirectRunnerJob(
      runner,
      "start",
      directJobStartRequest("job-wait-cancel-race", agentHome, "sleep 1"),
    )).status).toBe(200);

    const waitResponsePromise = requestDirectRunnerJob(runner, "wait", {
      jobId: "job-wait-cancel-race",
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(controlled.waitTimeouts).toContain(1_000));

    const cancelResponse = await requestDirectRunnerJob(runner, "cancel", {jobId: "job-wait-cancel-race"});
    expect(cancelResponse.status).toBe(200);
    await expect(cancelResponse.json()).resolves.toMatchObject({status: "cancelled"});
    controlled.complete();

    const waitResponse = await waitResponsePromise;
    expect(waitResponse.status).toBe(404);
    await expect(waitResponse.json()).resolves.toMatchObject({error: "Unknown background job job-wait-cancel-race."});
    expect(controlled.cancelCalls()).toBe(1);
  });

  it("allows an accepted status read to finish while concurrent cancel consumes the job", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    let status: BashJobSnapshot["status"] = "running";
    let snapshotCalls = 0;
    let releaseStatus!: () => void;
    let markStatusStarted!: () => void;
    let releaseWatcher!: () => void;
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });
    const watcherGate = new Promise<void>((resolve) => { releaseWatcher = resolve; });
    const runner = await createRunner("panda", {
      commandExecutor: {
        execute: async () => { throw new Error("unexpected exec"); },
        startJob: async (input) => ({
          snapshot: async () => {
            snapshotCalls += 1;
            if (snapshotCalls > 1) {
              markStatusStarted();
              await statusGate;
            }
            return fakeJobSnapshot(input, status);
          },
          wait: async () => {
            await watcherGate;
            return fakeJobSnapshot(input, status);
          },
          cancel: async (timeoutMs) => {
            expect(timeoutMs).toBe(5_000);
            status = "cancelled";
            releaseWatcher();
            return fakeJobSnapshot(input, status);
          },
        }),
      },
    });
    expect((await requestDirectRunnerJob(
      runner,
      "start",
      directJobStartRequest("job-status-cancel-race", agentHome, "sleep 1"),
    )).status).toBe(200);

    const statusResponsePromise = requestDirectRunnerJob(runner, "status", {jobId: "job-status-cancel-race"});
    await statusStarted;
    const cancelResponse = await requestDirectRunnerJob(runner, "cancel", {jobId: "job-status-cancel-race"});
    expect(cancelResponse.status).toBe(200);
    releaseStatus();

    const statusResponse = await statusResponsePromise;
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({status: "cancelled"});
    expect((await requestDirectRunnerJob(runner, "wait", {jobId: "job-status-cancel-race"})).status).toBe(404);
  });

  it("does not let a consumed result's stale expiry delete a replacement with the same job id", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const jobs: Array<{complete(status?: BashJobSnapshot["status"]): void; watcherReturned: Promise<void>}> = [];
    const runner = await createRunner("panda", {
      commandExecutor: {
        execute: async () => { throw new Error("unexpected exec"); },
        startJob: async (input) => {
          let status: BashJobSnapshot["status"] = "running";
          let release!: () => void;
          let markWatcherReturned!: () => void;
          const completion = new Promise<void>((resolve) => { release = resolve; });
          const watcherReturned = new Promise<void>((resolve) => { markWatcherReturned = resolve; });
          jobs.push({
            complete: (nextStatus = "completed") => {
              status = nextStatus;
              release();
            },
            watcherReturned,
          });
          return {
            snapshot: () => fakeJobSnapshot(input, status),
            wait: async () => {
              await completion;
              markWatcherReturned();
              return fakeJobSnapshot(input, status);
            },
            cancel: async () => {
              status = "cancelled";
              release();
              return fakeJobSnapshot(input, status);
            },
          };
        },
      },
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const jobId = "job-reused-after-consume";

    expect((await requestDirectRunnerJob(runner, "start", directJobStartRequest(jobId, agentHome, "printf first"))).status)
      .toBe(200);
    jobs[0]!.complete();
    await jobs[0]!.watcherReturned;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const timerCall = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 90_000);
    const staleExpiry = setTimeoutSpy.mock.calls[timerCall]?.[0];
    if (typeof staleExpiry !== "function") throw new Error("Expected terminal expiry callback.");

    expect((await requestDirectRunnerJob(runner, "wait", {jobId})).status).toBe(200);
    expect((await requestDirectRunnerJob(runner, "start", directJobStartRequest(jobId, agentHome, "sleep 1"))).status)
      .toBe(200);
    staleExpiry();

    const replacementStatus = await requestDirectRunnerJob(runner, "status", {jobId});
    expect(replacementStatus.status).toBe(200);
    await expect(replacementStatus.json()).resolves.toMatchObject({status: "running", command: "sleep 1"});
    await requestDirectRunnerJob(runner, "cancel", {jobId, timeoutMs: 1_000});
  });

  it("publishes one close promise and drains a job that resolves after close starts", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    let resolveStart!: (job: CommandExecutorJob) => void;
    let markStartCalled!: () => void;
    let cancelCalls = 0;
    let startCalls = 0;
    const startGate = new Promise<CommandExecutorJob>((resolve) => { resolveStart = resolve; });
    const startCalled = new Promise<void>((resolve) => { markStartCalled = resolve; });
    const runner = await createRunner("panda", {
      commandExecutor: {
        execute: async () => { throw new Error("unexpected exec"); },
        startJob: async () => {
          startCalls += 1;
          markStartCalled();
          return startGate;
        },
      },
    });
    const input = {
      request: directJobStartRequest("job-close-during-start", agentHome, "sleep 1"),
      cwd: agentHome,
    } satisfies CommandExecutorJobStartInput;
    const job: CommandExecutorJob = {
      snapshot: () => fakeJobSnapshot(input, "running"),
      wait: async () => fakeJobSnapshot(input, "cancelled"),
      cancel: async () => {
        cancelCalls += 1;
        return fakeJobSnapshot(input, "cancelled");
      },
    };

    const startResponsePromise = requestDirectRunnerJob(runner, "start", input.request);
    await startCalled;
    const firstClose = runner.close();
    const secondClose = runner.close();
    expect(firstClose).toBe(secondClose);
    resolveStart(job);

    const startResponse = await startResponsePromise;
    expect(startResponse.status).toBe(503);
    await expect(startResponse.json()).resolves.toMatchObject({ok: false, error: "Runner is closing."});
    await firstClose;
    expect(cancelCalls).toBe(1);
    expect(startCalls).toBe(1);
    expect(runner.server.listening).toBe(false);
    expect(runner.close()).toBe(firstClose);
  });

  it("drains a watcher completing during close without resurrecting terminal state or timers", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    let status: BashJobSnapshot["status"] = "running";
    let releaseCompletion!: () => void;
    let markWatcherReturned!: () => void;
    let cancelCalls = 0;
    const completion = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    const watcherReturned = new Promise<void>((resolve) => { markWatcherReturned = resolve; });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const runner = await createRunner("panda", {
      commandExecutor: {
        execute: async () => { throw new Error("unexpected exec"); },
        startJob: async (input) => ({
          snapshot: () => fakeJobSnapshot(input, status),
          wait: async () => {
            await completion;
            markWatcherReturned();
            return fakeJobSnapshot(input, status);
          },
          cancel: async () => {
            cancelCalls += 1;
            status = "cancelled";
            releaseCompletion();
            return fakeJobSnapshot(input, status);
          },
        }),
      },
    });
    expect((await requestDirectRunnerJob(
      runner,
      "start",
      directJobStartRequest("job-close-during-watch", agentHome, "sleep 1"),
    )).status).toBe(200);
    const observationCallIndex = setTimeoutSpy.mock.calls.findIndex((call) => (
      typeof call[1] === "number" && call[1] > 90_000
    ));
    expect(observationCallIndex).toBeGreaterThanOrEqual(0);
    const observationTimer = setTimeoutSpy.mock.results[observationCallIndex]?.value as NodeJS.Timeout;

    const firstClose = runner.close();
    expect(runner.close()).toBe(firstClose);
    await firstClose;
    await watcherReturned;

    expect(cancelCalls).toBe(1);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(observationTimer);
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 90_000)).toBe(false);
    expect(runner.server.listening).toBe(false);
  });

  it("leaves no local process-group residue after runner close", async () => {
    if (process.platform === "win32") return;

    const agentHome = await createWorkspace("runtime-agent-home-");
    const markerPath = path.join(agentHome, "close-processes.txt");
    const runner = await createRunner("panda");
    const startResponse = await requestDirectRunnerJob(runner, "start", {
      ...directJobStartRequest(
        "job-close-process-residue",
        agentHome,
        `(sleep 30) & child=$!; printf '%s %s' "$$" "$child" > ${JSON.stringify(markerPath)}; wait`,
      ),
      maxRuntimeMs: 60_000,
    });
    expect(startResponse.status).toBe(200);
    await waitFor(async () => {
      try {
        return (await readFile(markerPath, "utf8")).trim().split(" ").length === 2;
      } catch {
        return false;
      }
    });
    const pids = (await readFile(markerPath, "utf8")).trim().split(" ").map(Number);

    await runner.close();
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });

  it("reserves a job id before a deferred start and allows reuse only after consumption", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const pendingStarts: Array<{
      input: CommandExecutorJobStartInput;
      resolve(job: CommandExecutorJob): void;
    }> = [];
    const createJob = (input: CommandExecutorJobStartInput): CommandExecutorJob => {
      let status: BashJobSnapshot["status"] = "running";
      let release!: () => void;
      const completion = new Promise<void>((resolve) => { release = resolve; });
      return {
        snapshot: () => fakeJobSnapshot(input, status),
        wait: async () => {
          await completion;
          return fakeJobSnapshot(input, status);
        },
        cancel: async () => {
          status = "cancelled";
          release();
          return fakeJobSnapshot(input, status);
        },
      };
    };
    const runner = await createRunner("panda", {
      commandExecutor: {
        execute: async () => { throw new Error("unexpected exec"); },
        startJob: (input) => new Promise<CommandExecutorJob>((resolve) => {
          pendingStarts.push({input, resolve});
        }),
      },
    });
    const request = directJobStartRequest("job-deferred-duplicate", agentHome, "sleep 1");

    const firstStart = requestDirectRunnerJob(runner, "start", request);
    await waitFor(() => pendingStarts.length === 1);
    const secondResponse = await requestDirectRunnerJob(runner, "start", request);
    expect(secondResponse.status).toBe(400);
    await expect(secondResponse.json()).resolves.toMatchObject({
      error: "Background job job-deferred-duplicate already exists.",
    });
    expect(pendingStarts).toHaveLength(1);

    pendingStarts[0]!.resolve(createJob(pendingStarts[0]!.input));
    expect((await firstStart).status).toBe(200);
    expect((await requestDirectRunnerJob(runner, "cancel", {jobId: request.jobId})).status).toBe(200);

    const reusedStart = requestDirectRunnerJob(runner, "start", {...request, command: "printf reused"});
    await waitFor(() => pendingStarts.length === 2);
    pendingStarts[1]!.resolve(createJob(pendingStarts[1]!.input));
    expect((await reusedStart).status).toBe(200);
    expect((await requestDirectRunnerJob(runner, "cancel", {jobId: request.jobId})).status).toBe(200);
    expect(pendingStarts).toHaveLength(2);
  });

  it("drains a created job when snapshot publication fails before ownership transfer", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const cleanupCalls: string[] = [];
    let startCalls = 0;
    const runner = await createRunner("panda", {
      commandExecutor: {
        execute: async () => { throw new Error("unexpected exec"); },
        startJob: async (input) => {
          startCalls += 1;
          if (startCalls === 1) {
            return {
              snapshot: () => { throw new Error("snapshot failed"); },
              cancel: async () => {
                cleanupCalls.push("cancel");
                return fakeJobSnapshot(input, "running");
              },
              wait: async () => {
                cleanupCalls.push("wait");
                return fakeJobSnapshot(input, "cancelled");
              },
            };
          }
          return {
            snapshot: () => fakeJobSnapshot(input, "completed"),
            wait: async () => fakeJobSnapshot(input, "completed"),
            cancel: async () => fakeJobSnapshot(input, "completed"),
          };
        },
      },
    });
    const request = directJobStartRequest("job-snapshot-publication-failure", agentHome);

    expect((await requestDirectRunnerJob(runner, "start", request)).status).toBe(500);
    expect(cleanupCalls).toEqual(["cancel", "wait"]);
    expect((await requestDirectRunnerJob(runner, "start", request)).status).toBe(200);
    expect((await requestDirectRunnerJob(runner, "wait", {jobId: request.jobId})).status).toBe(200);
  });

  it("releases a reserved job id when executor start fails", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    let startCalls = 0;
    const runner = await createRunner("panda", {
      commandExecutor: {
        execute: async () => { throw new Error("unexpected exec"); },
        startJob: async (input) => {
          startCalls += 1;
          if (startCalls === 1) throw new Error("deferred start failed");
          return {
            snapshot: () => fakeJobSnapshot(input, "completed"),
            wait: async () => fakeJobSnapshot(input, "completed"),
            cancel: async () => fakeJobSnapshot(input, "completed"),
          };
        },
      },
    });
    const request = directJobStartRequest("job-reuse-after-start-failure", agentHome);

    expect((await requestDirectRunnerJob(runner, "start", request)).status).toBe(500);
    expect((await requestDirectRunnerJob(runner, "start", request)).status).toBe(200);
    expect((await requestDirectRunnerJob(runner, "wait", {jobId: request.jobId})).status).toBe(200);
    expect(startCalls).toBe(2);
  });

  it("does not recreate an abort timer when close races an accepted slow body", async () => {
    const runner = await createRunner("panda");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let closeStarted: Promise<void> | undefined;
    const response = new Promise<{statusCode: number; body: string}>((resolve, reject) => {
      const clientRequest = httpRequest({
        host: "127.0.0.1",
        port: runner.port,
        path: "/agents/panda/abort",
        method: "POST",
        headers: {
          ...buildDirectRunnerHeaders("panda"),
          connection: "close",
        },
      }, (clientResponse) => {
        const chunks: Buffer[] = [];
        clientResponse.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        clientResponse.once("end", () => resolve({
          statusCode: clientResponse.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      clientRequest.once("error", reject);
      const connected = new Promise<void>((connectedResolve) => {
        clientRequest.once("socket", (socket) => {
          if (socket.connecting) socket.once("connect", connectedResolve);
          else connectedResolve();
        });
      });
      clientRequest.write('{"requestId":"slow');
      void connected.then(async () => {
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        closeStarted = runner.close();
        clientRequest.end('-abort"}');
        await closeStarted;
      }).catch(reject);
    });

    const result = await response;
    await closeStarted;
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body)).toMatchObject({ok: false, error: "Runner is closing."});
    expect(setTimeoutSpy.mock.calls.filter((call) => call[1] === 30_000)).toHaveLength(0);
  });

  it("loses zero authenticated first waits after accepted running starts", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const sharedSecret = "runner-retention-stress-secret";
    const runner = await createRunner("panda", {sharedSecret});
    const attempts = 100;
    let acceptedRunning = 0;
    let lostFirstWaits = 0;

    for (let index = 0; index < attempts; index += 1) {
      const jobId = `job-retention-stress-${index}`;
      const startResponse = await requestDirectRunnerJob(runner, "start", {
        ...directJobStartRequest(jobId, agentHome, "sleep 0.01; printf done"),
        maxRuntimeMs: 2_000,
      }, {sharedSecret});
      expect(startResponse.status).toBe(200);
      const started = await startResponse.json() as Record<string, unknown>;
      expect(started.status).toBe("running");
      acceptedRunning += 1;

      await new Promise((resolve) => setTimeout(resolve, 25));
      const waitResponse = await requestDirectRunnerJob(
        runner,
        "wait",
        {jobId, timeoutMs: 1_000},
        {sharedSecret},
      );
      if (waitResponse.status === 404) lostFirstWaits += 1;
      expect(waitResponse.status).toBe(200);
      await expect(waitResponse.json()).resolves.toMatchObject({status: "completed", stdout: "done"});
    }

    expect({acceptedRunning, lostFirstWaits}).toEqual({acceptedRunning: attempts, lostFirstWaits: 0});
  }, 30_000);

  it("rejects duplicate active foreground request IDs and close kills the accepted process group", async () => {
    if (process.platform === "win32") return;

    const agentHome = await createWorkspace("runtime-agent-home-");
    const markerPath = path.join(agentHome, "duplicate-exec-processes.txt");
    const runner = await createRunner("panda");
    const body = {
      requestId: "request-duplicate-active",
      command: `(sleep 30) & child=$!; printf '%s %s' "$$" "$child" > ${JSON.stringify(markerPath)}; wait`,
      cwd: agentHome,
      timeoutMs: 60_000,
      trackedEnvKeys: [],
      maxOutputChars: 8_000,
    };

    const acceptedResponse = fetch(`http://127.0.0.1:${runner.port}/agents/panda/exec`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify(body),
    });
    await waitFor(async () => {
      try {
        return (await readFile(markerPath, "utf8")).trim().split(" ").length === 2;
      } catch {
        return false;
      }
    });
    const pids = (await readFile(markerPath, "utf8")).trim().split(" ").map(Number);

    const duplicateResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/exec`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({...body, command: "printf duplicate"}),
    });
    expect(duplicateResponse.status).toBe(400);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      error: "Runner requestId request-duplicate-active is already active.",
    });

    const closeStartedAt = Date.now();
    await runner.close();
    expect(Date.now() - closeStartedAt).toBeLessThan(6_000);
    const accepted = await acceptedResponse;
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({aborted: true});
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 10_000);

  it("retries persistent watcher failures, then releases credentials and the job ID at its lifetime bound", async () => {
    const script = `
      import {startBashRunner} from "./src/integrations/shell/bash-runner.ts";
      const realSetTimeout = globalThis.setTimeout;
      let observationExpiry;
      let observationDelay;
      let observationTimer;
      let firstJobReference;
      let startCalls = 0;
      let watcherWaitCalls = 0;
      globalThis.setTimeout = ((callback, delay, ...args) => {
        const timer = realSetTimeout(callback, delay, ...args);
        if (typeof delay === "number" && delay > 90_000 && !observationExpiry) {
          observationExpiry = callback;
          observationDelay = delay;
          observationTimer = timer;
        }
        return timer;
      });
      const snapshot = (input, status) => {
        const startedAt = Date.now();
        return {
          jobId: input.request.jobId,
          status,
          command: input.request.command,
          initialCwd: input.cwd,
          maxRuntimeMs: input.request.maxRuntimeMs,
          expiresAt: startedAt + input.request.maxRuntimeMs,
          startedAt,
          timedOut: false,
          stdout: status === "completed" ? "done" : "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutChars: status === "completed" ? 4 : 0,
          stderrChars: 0,
          stdoutPersisted: false,
          stderrPersisted: false,
          trackedEnvKeys: [],
          ...(status === "running" ? {} : {
            finishedAt: startedAt + 1,
            durationMs: 1,
            exitCode: 0,
            signal: null,
          }),
        };
      };
      const runner = await startBashRunner({
        agentKey: "panda",
        host: "127.0.0.1",
        port: 0,
        commandExecutor: {
          execute: async () => { throw new Error("unexpected exec"); },
          startJob: async (input) => {
            startCalls += 1;
            if (startCalls === 1) {
              const job = {
                credentialShapedEnv: {OPENAI_API_KEY: "sk-shaped-not-a-real-secret"},
                snapshot: () => snapshot(input, "running"),
                wait: async () => {
                  watcherWaitCalls += 1;
                  throw new Error("persistent watcher transport failure");
                },
                cancel: async () => snapshot(input, "cancelled"),
              };
              firstJobReference = new WeakRef(job);
              return job;
            }
            return {
              snapshot: () => snapshot(input, "completed"),
              wait: async () => snapshot(input, "completed"),
              cancel: async () => snapshot(input, "completed"),
            };
          },
        },
      });
      const headers = {
        "content-type": "application/json",
        "x-runtime-agent-key": "panda",
        "x-runtime-agent-path-scoped": "1",
        "x-runtime-expected-path": "/agents/panda",
      };
      const requestJob = (endpoint, body) => fetch(
        "http://127.0.0.1:" + runner.port + "/agents/panda/jobs/" + endpoint,
        {method: "POST", headers, body: JSON.stringify(body)},
      );
      const waitUntil = async (predicate) => {
        const deadline = Date.now() + 5_000;
        while (!predicate()) {
          if (Date.now() >= deadline) throw new Error("condition timed out");
          await new Promise((resolve) => realSetTimeout(resolve, 10));
        }
      };
      try {
        const request = {
          jobId: "job-persistent-watch-failure",
          command: "sleep 1",
          cwd: process.cwd(),
          maxRuntimeMs: 1_000,
          trackedEnvKeys: [],
          maxOutputChars: 8_000,
          persistOutputThresholdChars: 8_000,
        };
        const started = await requestJob("start", request);
        if (started.status !== 200 || (await started.json()).status !== "running") {
          throw new Error("running start failed");
        }
        await waitUntil(() => watcherWaitCalls >= 2);
        if (!observationExpiry || !(observationDelay > 90_000 && observationDelay <= 91_000)) {
          throw new Error("missing bounded observation expiry");
        }
        if (observationTimer.hasRef()) throw new Error("observation expiry timer was referenced");
        observationExpiry();
        observationExpiry = undefined;
        observationTimer = undefined;
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        const expired = await requestJob("status", {jobId: request.jobId});
        if (expired.status !== 404) throw new Error("expired ID remained reserved: " + expired.status);
        const reused = await requestJob("start", {...request, command: "printf reused"});
        if (reused.status !== 200) throw new Error("ID reuse failed: " + reused.status);
        const consumed = await requestJob("wait", {jobId: request.jobId});
        if (consumed.status !== 200) throw new Error("replacement consume failed: " + consumed.status);

        for (let index = 0; index < 20; index += 1) {
          global.gc();
          await new Promise((resolve) => setImmediate(resolve));
          if (!firstJobReference.deref()) break;
        }
        if (firstJobReference.deref()) throw new Error("persistent failure retained the credential-shaped job");
        if (startCalls !== 2) throw new Error("unexpected start count: " + startCalls);
        process.stdout.write("persistent-watch-released");
      } finally {
        globalThis.setTimeout = realSetTimeout;
        await runner.close();
      }
    `;

    const result = await execFileAsync(process.execPath, [
      "--expose-gc",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ], {cwd: path.resolve("."), timeout: 10_000});
    expect(result.stdout).toBe("persistent-watch-released");
  }, 15_000);

  it.each([
    ["valid executor deadline", 1_000_500, 1_000, 90_500],
    ["missing executor deadline", "missing", 1_000, 91_000],
    ["NaN executor deadline", Number.NaN, 1_000, 91_000],
    ["infinite executor deadline", Number.POSITIVE_INFINITY, 1_000, 91_000],
    ["past/skewed executor deadline", 999_999, 1_000, 91_000],
    ["excessive timer-valid executor deadline", 2_001_000_000, 1_000, 91_000],
    ["maximum accepted local lifetime", "missing", 21_600_000, 21_690_000],
  ] as const)(
    "bounds observation expiry for %s",
    async (_label, executorExpiresAt, maxRuntimeMs, expectedDelayMs) => {
      const agentHome = await createWorkspace("runtime-agent-home-");
      vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      let status: BashJobSnapshot["status"] = "running";
      let releaseWatcher!: () => void;
      const watcherGate = new Promise<void>((resolve) => { releaseWatcher = resolve; });
      const runner = await createRunner("panda", {
        commandExecutor: {
          execute: async () => { throw new Error("unexpected exec"); },
          startJob: async (input) => {
            const snapshot = (): BashJobSnapshot => {
              const result = fakeJobSnapshot(input, status);
              if (executorExpiresAt === "missing") {
                delete (result as Partial<BashJobSnapshot>).expiresAt;
              } else {
                result.expiresAt = executorExpiresAt;
              }
              return result;
            };
            return {
              snapshot,
              wait: async () => {
                await watcherGate;
                return snapshot();
              },
              cancel: async () => {
                status = "cancelled";
                releaseWatcher();
                return snapshot();
              },
            };
          },
        },
      });

      expect((await requestDirectRunnerJob(
        runner,
        "start",
        {
          ...directJobStartRequest("job-observation-deadline", agentHome, "sleep 1"),
          maxRuntimeMs,
        },
      )).status).toBe(200);
      const timerCallIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === expectedDelayMs);
      expect(timerCallIndex).toBeGreaterThanOrEqual(0);
      const observationTimer = setTimeoutSpy.mock.results[timerCallIndex]?.value as NodeJS.Timeout;
      expect(observationTimer.hasRef()).toBe(false);
      await runner.close();
    },
  );

  it("uses a bounded watcher poll and awaits the in-flight poll during close", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    let watcherWaitTimeout: number | undefined;
    let markWatcherStarted!: () => void;
    const watcherStarted = new Promise<void>((resolve) => { markWatcherStarted = resolve; });
    const runner = await createRunner("panda", {
      commandExecutor: {
        execute: async () => { throw new Error("unexpected exec"); },
        startJob: async (input) => ({
          snapshot: () => fakeJobSnapshot(input, "running"),
          wait: async (timeoutMs) => {
            watcherWaitTimeout = timeoutMs;
            markWatcherStarted();
            if ((timeoutMs ?? Number.POSITIVE_INFINITY) > 5_000) {
              throw new Error("watcher poll was not bounded");
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            return fakeJobSnapshot(input, "running");
          },
          cancel: async () => fakeJobSnapshot(input, "cancelled"),
        }),
      },
    });
    expect((await requestDirectRunnerJob(
      runner,
      "start",
      directJobStartRequest("job-bounded-watch-close", agentHome, "sleep 1"),
    )).status).toBe(200);
    await watcherStarted;

    const closeStartedAt = Date.now();
    await runner.close();
    expect(watcherWaitTimeout).toBeLessThanOrEqual(5_000);
    expect(Date.now() - closeStartedAt).toBeLessThan(6_000);
  }, 10_000);

  it("serves /exec through the command executor seam without changing the runner protocol", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const calls: CommandExecutorExecInput[] = [];
    const runner = await createRunner("panda", {
      commandExecutor: {
        execute: async (input) => {
          calls.push(input);
          return {result: fakeExecResult(input)};
        },
        startJob: async () => {
          throw new Error("unexpected job start");
        },
      },
    });

    const response = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/exec`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({
        requestId: "request-seam-exec",
        command: "printf hello",
        cwd: agentHome,
        timeoutMs: 1_000,
        trackedEnvKeys: ["MARKER"],
        maxOutputChars: 8_000,
        env: {MARKER: "seam"},
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      finalCwd: agentHome,
      stdout: "fake-exec:printf hello:seam",
      trackedEnvKeys: ["MARKER"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(agentHome);
    expect(calls[0]?.request.command).toBe("printf hello");
  });

  it("keeps /jobs state in the runner while job execution goes through the command executor seam", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const startedJobs = new Map<string, CommandExecutorJob>();
    const startCalls: CommandExecutorJobStartInput[] = [];
    const runner = await createRunner("panda", {
      commandExecutor: {
        execute: async () => {
          throw new Error("unexpected exec");
        },
        startJob: async (input) => {
          startCalls.push(input);
          let status: BashJobSnapshot["status"] = "running";
          const job: CommandExecutorJob = {
            snapshot: () => fakeJobSnapshot(input, status),
            wait: async (timeoutMs) => {
              if (timeoutMs === 5_000) {
                return fakeJobSnapshot(input, status);
              }
              status = "completed";
              return fakeJobSnapshot(input, status);
            },
            cancel: async () => {
              status = "cancelled";
              return fakeJobSnapshot(input, status);
            },
          };
          startedJobs.set(input.request.jobId, job);
          return job;
        },
      },
    });

    const startResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/start`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({
        jobId: "job-seam-1",
        command: "sleep 1",
        cwd: agentHome,
        maxRuntimeMs: 1_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
        persistOutputThresholdChars: 8_000,
      }),
    });
    expect(startResponse.status).toBe(200);
    await expect(startResponse.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-seam-1",
      status: "running",
    });

    const statusResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/status`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({jobId: "job-seam-1"}),
    });
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-seam-1",
      status: "running",
    });

    const waitResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/wait`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({jobId: "job-seam-1", timeoutMs: 1_000}),
    });
    expect(waitResponse.status).toBe(200);
    await expect(waitResponse.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-seam-1",
      status: "completed",
      stdout: "fake-job-done",
    });

    const evictedStatusResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/status`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({jobId: "job-seam-1"}),
    });
    expect(evictedStatusResponse.status).toBe(404);
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]?.cwd).toBe(agentHome);
    expect(startedJobs.has("job-seam-1")).toBe(true);
  });


  it("keeps jobs queryable when the background watcher hits a transient wait error", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const waitTimeouts: Array<number | undefined> = [];
    const runner = await createRunner("panda", {
      commandExecutor: {
        execute: async () => {
          throw new Error("unexpected exec");
        },
        startJob: async (input) => {
          const job: CommandExecutorJob = {
            snapshot: () => fakeJobSnapshot(input, "running"),
            wait: async (timeoutMs) => {
              waitTimeouts.push(timeoutMs);
              throw new Error("transient watcher wait failure");
            },
            cancel: async () => fakeJobSnapshot(input, "cancelled"),
          };
          return job;
        },
      },
    });

    const startResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/start`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({
        jobId: "job-transient-watch",
        command: "sleep 60",
        cwd: agentHome,
        maxRuntimeMs: 60_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
        persistOutputThresholdChars: 8_000,
      }),
    });
    expect(startResponse.status).toBe(200);

    await vi.waitFor(() => {
      expect(waitTimeouts).toEqual([5_000]);
    });

    const statusResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/status`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({jobId: "job-transient-watch"}),
    });
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-transient-watch",
      status: "running",
    });
  });

  it("accepts env payloads at the runner", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");

    const response = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/exec`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNNER_AGENT_KEY_HEADER]: "panda",
        [RUNNER_PATH_SCOPED_HEADER]: "1",
        [RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
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
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });
    const context: DefaultAgentSessionContext = {
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

    expect(String(asObject(result).stdout)).toBe("[redacted]");
    expect(context.shell?.env).toEqual({
      OPENAI_API_KEY: "sk-ephemeral",
    });
    expect(context.shell?.secretEnvKeys).toEqual(["OPENAI_API_KEY"]);
  });

  it("supports remote background job start, status, wait, and cancel endpoints", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");

    const legacyStartResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/start`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({
        jobId: "job-legacy-timeout",
        command: "sleep 1",
        cwd: agentHome,
        timeoutMs: 1_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
        persistOutputThresholdChars: 8_000,
      }),
    });
    expect(legacyStartResponse.status).toBe(400);
    await expect(legacyStartResponse.json()).resolves.toMatchObject({
      ok: false,
      error: "Background job timeoutMs is not accepted. Use maxRuntimeMs.",
    });

    const serverPortFile = path.join(agentHome, "remote-server.port");
    const serverScript = `const fs=require("node:fs");const http=require("node:http");const marker="remote-bash-server-marker";const server=http.createServer((_request,response)=>response.end("ready"));server.listen(0,"127.0.0.1",()=>fs.writeFileSync(${JSON.stringify(serverPortFile)},String(server.address().port)));`;
    const serverStartResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/start`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({
        jobId: "job-direct-server",
        command: `node -e ${JSON.stringify(serverScript)}`,
        cwd: agentHome,
        maxRuntimeMs: 60_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
        persistOutputThresholdChars: 8_000,
      }),
    });
    expect(serverStartResponse.status).toBe(200);
    await expect(serverStartResponse.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-direct-server",
      status: "running",
      maxRuntimeMs: 60_000,
    });

    const serverHealthResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/exec`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({
        requestId: "request-direct-server-health",
        command: `for _attempt in {1..40}; do if test -s ${JSON.stringify(serverPortFile)}; then _port=$(cat ${JSON.stringify(serverPortFile)}); curl -fsS "http://127.0.0.1:${"${_port}"}/" && exit 0; fi; sleep 0.05; done; exit 1`,
        cwd: agentHome,
        timeoutMs: 5_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
      }),
    });
    expect(serverHealthResponse.status).toBe(200);
    await expect(serverHealthResponse.json()).resolves.toMatchObject({ok: true, success: true, stdout: "ready"});
    const serverPort = Number((await readFile(serverPortFile, "utf8")).trim());
    expect(Number.isInteger(serverPort)).toBe(true);

    const serverCancelResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/cancel`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({jobId: "job-direct-server"}),
    });
    expect(serverCancelResponse.status).toBe(200);
    await expect(serverCancelResponse.json()).resolves.toMatchObject({ok: true, status: "cancelled"});
    await expect(fetch(`http://127.0.0.1:${serverPort}/`)).rejects.toThrow();

    const serverProcessResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/exec`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({
        requestId: "request-direct-server-process-check",
        command: "pgrep -af '[r]emote-bash-server-marker' || true",
        cwd: agentHome,
        timeoutMs: 5_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
      }),
    });
    expect(serverProcessResponse.status).toBe(200);
    await expect(serverProcessResponse.json()).resolves.toMatchObject({ok: true, success: true, stdout: ""});

    const startResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNNER_AGENT_KEY_HEADER]: "panda",
        [RUNNER_PATH_SCOPED_HEADER]: "1",
        [RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "job-direct-1",
        command: "command -v sed >/dev/null && sleep 0.2 && printf done",
        cwd: agentHome,
        maxRuntimeMs: 1_000,
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
      maxRuntimeMs: 1_000,
      expiresAt: expect.any(Number),
    });

    const statusResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNNER_AGENT_KEY_HEADER]: "panda",
        [RUNNER_PATH_SCOPED_HEADER]: "1",
        [RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
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
        [RUNNER_AGENT_KEY_HEADER]: "panda",
        [RUNNER_PATH_SCOPED_HEADER]: "1",
        [RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
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
        [RUNNER_AGENT_KEY_HEADER]: "panda",
        [RUNNER_PATH_SCOPED_HEADER]: "1",
        [RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "job-direct-2",
        command: "sleep 10",
        cwd: agentHome,
        maxRuntimeMs: 10_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
        persistOutputThresholdChars: 8_000,
      }),
    });

    const cancelResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNNER_AGENT_KEY_HEADER]: "panda",
        [RUNNER_PATH_SCOPED_HEADER]: "1",
        [RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
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

    const expiringStart = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/start`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({
        jobId: "job-direct-expiry",
        command: "sleep 10",
        cwd: agentHome,
        maxRuntimeMs: 100,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
        persistOutputThresholdChars: 8_000,
      }),
    });
    expect(expiringStart.status).toBe(200);
    const expiringWait = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/wait`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({jobId: "job-direct-expiry", timeoutMs: 1_000}),
    });
    expect(expiringWait.status).toBe(200);
    await expect(expiringWait.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-direct-expiry",
      status: "failed",
      timedOut: true,
      maxRuntimeMs: 100,
    });

    const completedStatusResponse = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNNER_AGENT_KEY_HEADER]: "panda",
        [RUNNER_PATH_SCOPED_HEADER]: "1",
        [RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
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
        [RUNNER_AGENT_KEY_HEADER]: "panda",
        [RUNNER_PATH_SCOPED_HEADER]: "1",
        [RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
      },
      body: JSON.stringify({
        jobId: "job-direct-2",
      }),
    });

    expect(cancelledStatusResponse.status).toBe(404);
  }, 15_000);

  it("keeps remote background jobs isolated from the shared shell session", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");
    const {bash, wait, context} = await createRemoteBackgroundHarness(agentHome, runner);
    context.shell!.env.SESSION_MARKER = "session";

    const started = await bash.run(
      {
        command: 'cd /tmp && export BG_ONLY="$CALL_SECRET" && printf "%s|%s|%s" "${SESSION_MARKER:-missing}" "${CALL_MARKER:-missing}" "${CALL_SECRET:-missing}"',
        env: {
          CALL_SECRET: "call-secret-value",
          CALL_MARKER: "call",
        },
        background: true,
      },
      createRunContext(context),
    );
    expect(asObject(started).maxRuntimeMs).toBe(1_800_000);
    expect(asObject(started).expiresAt).toBe(Number(asObject(started).startedAt) + 1_800_000);

    const finished = await wait.run(
      { jobId: String(asObject(started).jobId), timeoutMs: 1_000 },
      createRunContext(context),
    );
    const output = asObject(finished);

    expect(output.status).toBe("completed");
    expect(String(output.stdout)).toBe("session|call|[redacted]");
    expect(output.trackedEnvKeys).toEqual(["BG_ONLY"]);
    expect(context.shell?.cwd).toBe(agentHome);
    expect(context.shell?.env.BG_ONLY).toBeUndefined();
    expect(context.shell?.env.SESSION_MARKER).toBe("session");
    expect(JSON.stringify(output)).not.toContain("call-secret");
  });

  it("redacts explicit short source secret output for remote background jobs without hiding unrelated output", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");
    const {bash, status, wait, context} = await createRemoteBackgroundHarness(agentHome, runner);

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
  });

  it("runs multiple remote background jobs concurrently", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
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

  it("surfaces remote background maximum-runtime expiry as a failed timeout", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");
    const {bash, wait, context} = await createRemoteBackgroundHarness(agentHome, runner);
    const started = asObject(await bash.run(
      {command: "sleep 10", background: true, maxRuntimeMs: 100},
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
  });

  it("fires the remote background completion handler when watcher-owned jobs finish", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
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
    await expect(store.getToolJob(jobId)).resolves.toMatchObject({
      status: "completed",
      result: {
        stdout: "remote-done",
      },
    });
  });

  it("does not leave a durable job behind when remote background start fails", async () => {
    const store = new TestThreadRuntimeStore();
    await store.createThread({
      id: "thread-bg-remote",
      sessionId: "session-bg-remote",
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
    const service = new BackgroundToolJobService({store});
    const bash = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: "http://runner.local/{agentKey}",
      },
      fetchImpl: fetchImpl as typeof fetch,
      jobService: service,
    });
    const context: DefaultAgentSessionContext = {
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

    await expect(store.listToolJobs("thread-bg-remote")).resolves.toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns a clean error for unknown remote background jobs", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");
    const response = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNNER_AGENT_KEY_HEADER]: "panda",
        [RUNNER_PATH_SCOPED_HEADER]: "1",
        [RUNNER_EXPECTED_PATH_HEADER]: "/agents/panda",
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
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
      },
    });
    const context: DefaultAgentSessionContext = {
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
    const agentHome = await createWorkspace("runtime-agent-home-");
    const missingCwd = path.join(agentHome, "missing-cwd");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
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
    const agentHome = await createWorkspace("runtime-agent-home-");
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

    await expect(store.listToolJobs("thread-bg-remote")).resolves.toHaveLength(0);
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
      env: {
        BASH_SERVER_SHARED_SECRET: "secret-123",
      },
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
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      [RUNNER_AUTHORIZATION_HEADER]: "Bearer secret-123",
    });
    expect(resolveRunnerUrl("http://runner-{agentKey}:8080/base", "work")).toBe("http://runner-work:8080/base");
    await expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      env: {
        CALL_MARKER: "hello",
      },
    });
  });

  it("uses optional runner bearer auth for foreground and background remote bash", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda", {sharedSecret: "secret-123"});
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
        BASH_SERVER_SHARED_SECRET: "secret-123",
      },
    });

    const result = await tool.run(
      { command: "printf foreground" },
      createRunContext({
        agentKey: "panda",
        cwd: agentHome,
        shell: {
          cwd: agentHome,
          env: {},
        },
      }),
    );
    expect(String(asObject(result).stdout)).toBe("foreground");

    const {bash, wait, context} = await createRemoteBackgroundHarness(agentHome, runner, {
      runnerSharedSecret: "secret-123",
    });
    const started = await bash.run(
      { command: "printf background", background: true },
      createRunContext(context),
    );
    const finished = await wait.run(
      { jobId: String(asObject(started).jobId), timeoutMs: 1_000 },
      createRunContext(context),
    );

    expect(asObject(finished)).toMatchObject({
      status: "completed",
      stdout: "background",
    });
  });

  it("rejects missing and wrong runner bearer tokens while leaving health public", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const markerPath = path.join(agentHome, "should-not-run.txt");
    const runner = await createRunner("panda", {sharedSecret: "secret-123"});

    const health = await fetch(`http://127.0.0.1:${runner.port}/health`);
    expect(health.status).toBe(200);

    const requestBody = {
      requestId: "request-auth-1",
      command: `printf nope > ${JSON.stringify(markerPath)}`,
      cwd: agentHome,
      timeoutMs: 1_000,
      trackedEnvKeys: [],
      maxOutputChars: 8_000,
    };
    const missing = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/exec`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify(requestBody),
    });
    expect(missing.status).toBe(401);

    const wrong = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/exec`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda", {sharedSecret: "wrong"}),
      body: JSON.stringify({...requestBody, requestId: "request-auth-2"}),
    });
    expect(wrong.status).toBe(403);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({code: "ENOENT"});

    const correct = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/exec`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda", {sharedSecret: "secret-123"}),
      body: JSON.stringify({...requestBody, requestId: "request-auth-3", command: `printf ok > ${JSON.stringify(markerPath)}`}),
    });
    expect(correct.status).toBe(200);
    await expect(readFile(markerPath, "utf8")).resolves.toBe("ok");
  });

  it("enforces optional allowed roots for foreground and background initial cwd", async () => {
    const allowedRoot = await createWorkspace("runtime-allowed-root-");
    const deniedRoot = await createWorkspace("runtime-denied-root-");
    const nested = path.join(allowedRoot, "nested");
    await mkdir(nested);
    const runner = await createRunner("panda", {allowedRoots: [allowedRoot]});

    const allowed = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/exec`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({
        requestId: "request-root-1",
        command: "pwd",
        cwd: nested,
        timeoutMs: 1_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
      }),
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({
      ok: true,
      stdout: `${await realpath(nested)}\n`,
    });

    const denied = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/exec`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({
        requestId: "request-root-2",
        command: "pwd",
        cwd: deniedRoot,
        timeoutMs: 1_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
      }),
    });
    expect(denied.status).toBe(400);
    await expect(denied.json()).resolves.toMatchObject({
      ok: false,
      error: "Runner cwd is outside BASH_SERVER_ALLOWED_ROOTS.",
    });

    const deniedJob = await fetch(`http://127.0.0.1:${runner.port}/agents/panda/jobs/start`, {
      method: "POST",
      headers: buildDirectRunnerHeaders("panda"),
      body: JSON.stringify({
        jobId: "job-root-denied",
        command: "pwd",
        cwd: deniedRoot,
        maxRuntimeMs: 1_000,
        trackedEnvKeys: [],
        maxOutputChars: 8_000,
        persistOutputThresholdChars: 8_000,
      }),
    });
    expect(deniedJob.status).toBe(400);
  });

  it("supports a single runner url without an agent key placeholder", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}`,
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
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("jozef");
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/{agentKey}`,
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
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/runners/{agentKey}/bash`,
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
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("jozef");
    const response = await fetch(`http://127.0.0.1:${runner.port}/runners/panda/bash/exec`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNNER_AGENT_KEY_HEADER]: "jozef",
        [RUNNER_PATH_SCOPED_HEADER]: "1",
        [RUNNER_EXPECTED_PATH_HEADER]: "/runners/jozef/bash",
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
    const sharedWorkspace = await createWorkspace("panda-shared-workspace-");
    const runnerA = await createRunner("panda");
    const runnerB = await createRunner("ops");
    const expectedSharedWorkspace = await realpath(sharedWorkspace);
    const primaryTool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runnerA.port}/agents/{agentKey}`,
      },
    });
    const opsTool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runnerB.port}/agents/{agentKey}`,
      },
    });

    const primaryResult = await primaryTool.run(
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

    expect(String(asObject(primaryResult).stdout).trim()).toBe(expectedSharedWorkspace);
    expect(String(asObject(opsResult).stdout).trim()).toBe(expectedSharedWorkspace);
  });

  it("aborts remote commands through the runner", async () => {
    const agentHome = await createWorkspace("runtime-agent-home-");
    const runner = await createRunner("panda");
    const tool = new BashTool({
      env: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: `http://127.0.0.1:${runner.port}/agents/{agentKey}`,
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
