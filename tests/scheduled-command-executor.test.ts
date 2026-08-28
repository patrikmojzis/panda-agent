import {describe, expect, it, vi} from "vitest";

import {RuntimeScheduledCommandExecutor} from "../src/app/runtime/scheduled-command-executor.js";
import type {
  ScheduledCommandRecord,
  ScheduledCommandRunRecord,
} from "../src/domain/scheduling/scheduled-commands/types.js";

const now = Date.parse("2026-08-28T10:00:00.000Z");

function command(): ScheduledCommandRecord {
  return {
    commandId: "00000000-0000-4000-8000-000000000001",
    sessionId: "session-main",
    version: 1,
    title: "Sync prices",
    command: "./sync-prices",
    cwd: "jobs",
    cron: "0 * * * *",
    timezone: "UTC",
    credentialNames: ["GAS_API_TOKEN"],
    timeoutMs: 60_000,
    enabled: true,
    keyId: "v1",
    integrityTag: "a".repeat(64),
    nextFireAt: now + 60_000,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function run(): ScheduledCommandRunRecord {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    commandId: command().commandId,
    sessionId: "session-main",
    version: 1,
    trigger: "schedule",
    scheduledFor: now,
    status: "claimed",
    createdAt: now,
  };
}

function session() {
  return {
    id: "session-main",
    agentKey: "panda",
    kind: "main" as const,
    currentThreadId: "thread-main",
    createdAt: now,
    updatedAt: now,
  };
}

describe("runtime scheduled command executor", () => {
  it("refuses to execute inside panda-core's local environment", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const resolveCredential = vi.fn();
    const executor = new RuntimeScheduledCommandExecutor({
      sessions: {getSession: vi.fn(async () => session())},
      environments: {resolveDefault: vi.fn(async () => ({
        id: "local",
        agentKey: "panda",
        kind: "local" as const,
        state: "ready" as const,
        executionMode: "local" as const,
        credentialPolicy: {mode: "all_agent" as const},
        skillPolicy: {mode: "all_agent" as const},
        toolPolicy: {bash: {allowed: true}},
        source: "fallback" as const,
      }))},
      credentials: {resolveCredential},
      fetchImpl,
    });

    await expect(executor.execute({
      command: command(),
      run: run(),
      signal: new AbortController().signal,
      onPrepared: vi.fn(),
    })).rejects.toMatchObject({failureCode: "environment_not_isolated"});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it("refuses disposable workspaces that carry interactive command access", async () => {
    const executor = new RuntimeScheduledCommandExecutor({
      sessions: {getSession: vi.fn(async () => session())},
      environments: {resolveDefault: vi.fn(async () => ({
        id: "disposable-1",
        agentKey: "panda",
        kind: "disposable_container" as const,
        state: "ready" as const,
        executionMode: "remote" as const,
        runnerUrl: "http://runner.local/disposable-1",
        initialCwd: "/workspace",
        credentialPolicy: {mode: "all_agent" as const},
        skillPolicy: {mode: "all_agent" as const},
        toolPolicy: {bash: {allowed: true}},
        source: "binding" as const,
      }))},
      credentials: {resolveCredential: vi.fn()},
      fetchImpl: vi.fn<typeof fetch>(),
    });

    await expect(executor.execute({
      command: command(),
      run: run(),
      signal: new AbortController().signal,
      onPrepared: vi.fn(),
    })).rejects.toMatchObject({failureCode: "environment_not_supported"});
  });

  it("sends only explicit credentials to the remote runner and redacts stored output", async () => {
    const secret = "gas-api-secret-value";
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ok: true,
      shell: "/bin/bash",
      finalCwd: "/workspace/jobs",
      durationMs: 4,
      timeoutMs: 60_000,
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      abortReason: null,
      interrupted: false,
      success: true,
      stdout: `synced with ${secret}`,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutChars: 34,
      stderrChars: 0,
      stdoutPersisted: false,
      stderrPersisted: false,
      noOutput: false,
      trackedEnvKeys: [],
      persistedEnvEntries: [],
    }), {status: 200, headers: {"content-type": "application/json"}}));
    const onPrepared = vi.fn(async () => {});
    const executor = new RuntimeScheduledCommandExecutor({
      sessions: {getSession: vi.fn(async () => session())},
      environments: {resolveDefault: vi.fn(async () => ({
        id: "runner:panda",
        agentKey: "panda",
        kind: "persistent_agent_runner" as const,
        state: "ready" as const,
        executionMode: "remote" as const,
        runnerUrl: "http://runner.local/panda",
        initialCwd: "/workspace",
        credentialPolicy: {mode: "allowlist" as const, envKeys: ["GAS_API_TOKEN"]},
        skillPolicy: {mode: "all_agent" as const},
        toolPolicy: {bash: {allowed: true}},
        source: "fallback" as const,
      }))},
      credentials: {resolveCredential: vi.fn(async () => ({
        id: "credential-1",
        agentKey: "panda",
        envKey: "GAS_API_TOKEN",
        value: secret,
        envelopeVersion: 1,
        createdAt: now,
        updatedAt: now,
      }))},
      fetchImpl,
    });

    const result = await executor.execute({
      command: command(),
      run: run(),
      signal: new AbortController().signal,
      onPrepared,
    });

    expect(onPrepared).toHaveBeenCalledWith({environmentId: "runner:panda", cwd: "/workspace/jobs"});
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain("[redacted]");
    const request = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {env: Record<string, string>};
    expect(body.env).toEqual({
      GAS_API_TOKEN: secret,
      PANDA_CRON_ID: command().commandId,
      PANDA_CRON_RUN_ID: run().id,
      PANDA_CRON_SCHEDULED_FOR: "2026-08-28T10:00:00.000Z",
    });
    expect(body.env).not.toHaveProperty("PANDA_COMMAND_TOKEN");
  });
});
