import {describe, expect, it} from "vitest";

import {WorkspaceCommandExecutor, resolveWorkspaceCommandExecutorFromEnv} from "../src/integrations/shell/workspace-command-executor.js";
import type {WorkspaceExecAction, WorkspaceProcessSnapshot} from "../src/integrations/shell/workspace-exec-protocol.js";

function snapshot(overrides: Partial<WorkspaceProcessSnapshot> = {}): WorkspaceProcessSnapshot {
  return {
    processId: "proc",
    status: "completed",
    command: "cmd",
    initialCwd: "/workspace",
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    abortReason: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutChars: 0,
    stderrChars: 0,
    stdoutPersisted: false,
    stderrPersisted: false,
    trackedEnvKeys: [],
    ...overrides,
  };
}

function response(process: WorkspaceProcessSnapshot): Response {
  return new Response(JSON.stringify({ok: true, process}), {status: 200, headers: {"content-type": "application/json"}});
}

describe("WorkspaceCommandExecutor", () => {
  it("selects only on complete workspace exec config and fails on partial config", () => {
    expect(resolveWorkspaceCommandExecutorFromEnv({})).toBeUndefined();
    expect(() => resolveWorkspaceCommandExecutorFromEnv({
      PANDA_WORKSPACE_EXEC_MANAGER_URL: "http://manager",
      PANDA_WORKSPACE_EXEC_ENVIRONMENT_ID: "env-a",
    })).toThrow("requires all");
    expect(resolveWorkspaceCommandExecutorFromEnv({
      PANDA_WORKSPACE_EXEC_MANAGER_URL: "http://manager",
      PANDA_WORKSPACE_EXEC_ENVIRONMENT_ID: "env-a",
      PANDA_WORKSPACE_EXEC_TOKEN: "workspace-token",
    })).toBeInstanceOf(WorkspaceCommandExecutor);
  });

  it("maps foreground result, strips state markers, and preserves cwd/env parity", async () => {
    const actions: WorkspaceExecAction[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const action = JSON.parse(String(init?.body)) as WorkspaceExecAction;
      actions.push(action);
      if (action.action !== "start") throw new Error("unexpected action");
      const command = action.request.command;
      const token = /__PANDA_STATE_([A-Za-z0-9_]+)_BEGIN__/.exec(command)?.[1];
      expect(token).toBeTruthy();
      return response(snapshot({
        processId: action.request.processId ?? "proc",
        command,
        stderr: `user-err\n__PANDA_STATE_${token}_BEGIN__\n/tmp\nFOO\tpresent\tYmFy\nOLD\tabsent\t\n__PANDA_STATE_${token}_END__\n`,
        stderrChars: 999,
        trackedEnvKeys: ["FOO", "OLD"],
      }));
    };
    const executor = new WorkspaceCommandExecutor({managerUrl: "http://manager", environmentId: "env-a", credential: "workspace-token", fetchImpl});
    const outcome = await executor.execute({
      cwd: "/workspace",
      signal: new AbortController().signal,
      request: {requestId: "req", command: "cd /tmp; export FOO=bar; unset OLD", cwd: "/workspace", timeoutMs: 1000, trackedEnvKeys: ["FOO", "OLD"], maxOutputChars: 1000},
    });

    expect(outcome.result.finalCwd).toBe("/tmp");
    expect(outcome.result.stderr).toBe("user-err\n\n");
    expect(outcome.result.persistedEnvEntries).toEqual([
      {key: "FOO", present: true, value: "bar"},
      {key: "OLD", present: false, value: ""},
    ]);
    expect(actions[0]).toMatchObject({action: "start", environmentId: "env-a"});
  });

  it("uses async status and cancel actions for background jobs", async () => {
    const actions: WorkspaceExecAction[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const action = JSON.parse(String(init?.body)) as WorkspaceExecAction;
      actions.push(action);
      if (action.action === "start") return response(snapshot({processId: action.request.processId ?? "proc", status: "running", command: action.request.command, initialCwd: action.request.cwd, exitCode: undefined, finishedAt: undefined, durationMs: undefined}));
      if (action.action === "status") return response(snapshot({processId: action.processId, status: "completed", stdout: "done", stdoutChars: 4}));
      if (action.action === "cancel") return response(snapshot({processId: action.processId, status: "cancelled", aborted: true, abortReason: "Command aborted."}));
      return response(snapshot({processId: action.processId}));
    };
    const executor = new WorkspaceCommandExecutor({managerUrl: "http://manager", environmentId: "env-a", credential: "workspace-token", fetchImpl});
    const job = await executor.startJob({cwd: "/workspace", request: {jobId: "job1", command: "echo done", cwd: "/workspace", timeoutMs: 1000, trackedEnvKeys: [], maxOutputChars: 1000, persistOutputThresholdChars: 1000}});

    await expect(job.snapshot()).resolves.toMatchObject({jobId: "job1", status: "completed", stdout: "done", stdoutPersisted: false});
    await expect(job.cancel(25)).resolves.toMatchObject({status: "cancelled"});
    expect(actions.map((action) => action.action)).toEqual(["start", "status", "cancel"]);
  });
});
