import process from "node:process";

import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";
import {registerSmokeCommand} from "../src/app/smoke/cli.js";

const smokeCliMocks = vi.hoisted(() => {
  const result = {
    current: {
      artifactDir: "/tmp/runtime-smoke/pass",
      artifacts: {
        runs: "/tmp/runtime-smoke/pass/runs.json",
        summary: "/tmp/runtime-smoke/pass/summary.json",
        toolArtifacts: "/tmp/runtime-smoke/pass/tool-artifacts.json",
        transcript: "/tmp/runtime-smoke/pass/transcript.json",
      },
      assertions: [],
      config: {
        agentKey: "panda",
        cwd: "/workspace/panda-agent",
        databaseName: "panda_smoke",
        expectText: ["hi"],
        expectTool: ["browser"],
        forbidToolError: true,
        identityHandle: "smoke",
        inputCount: 1,
        reuseDb: false,
        timeoutMs: 120_000,
      },
      runs: [],
      sessionId: "session-1",
      startedAt: 1,
      success: true,
      threadId: "thread-1",
      toolArtifacts: {
        bashArtifacts: [],
        toolArtifacts: [],
      },
      transcript: [],
    },
  };

  return {
    result,
    runSmoke: vi.fn(async () => result.current),
    startSmokeFollowUpRepl: vi.fn(async () => {}),
  };
});

vi.mock("../src/app/smoke/harness.js", () => ({
  runSmoke: smokeCliMocks.runSmoke,
}));

vi.mock("../src/app/smoke/follow-up.js", () => ({
  startSmokeFollowUpRepl: smokeCliMocks.startSmokeFollowUpRepl,
}));

function createProgram(): Command {
  const program = new Command();
  registerSmokeCommand(program);
  return program;
}

describe("Smoke CLI", () => {
  afterEach(() => {
    smokeCliMocks.runSmoke.mockClear();
    smokeCliMocks.startSmokeFollowUpRepl.mockClear();
    smokeCliMocks.result.current = {
      artifactDir: "/tmp/runtime-smoke/pass",
      artifacts: {
        runs: "/tmp/runtime-smoke/pass/runs.json",
        summary: "/tmp/runtime-smoke/pass/summary.json",
        toolArtifacts: "/tmp/runtime-smoke/pass/tool-artifacts.json",
        transcript: "/tmp/runtime-smoke/pass/transcript.json",
      },
      assertions: [],
      config: {
        agentKey: "panda",
        cwd: "/workspace/panda-agent",
        databaseName: "panda_smoke",
        expectText: ["hi"],
        expectTool: ["browser"],
        forbidToolError: true,
        identityHandle: "smoke",
        inputCount: 1,
        reuseDb: false,
        timeoutMs: 120_000,
      },
      runs: [],
      sessionId: "session-1",
      startedAt: 1,
      success: true,
      threadId: "thread-1",
      toolArtifacts: {
        bashArtifacts: [],
        toolArtifacts: [],
      },
      transcript: [],
    };
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("passes parsed smoke options through to the harness", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      [
        "smoke",
        "--agent",
        "panda",
        "--db-url",
        "postgres://smoke-db",
        "--input",
        "say hi",
        "--expect-text",
        "hi",
        "--expect-tool",
        "browser",
        "--forbid-tool-error",
      ],
      {from: "user"},
    );

    expect(smokeCliMocks.runSmoke).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: "panda",
      dbUrl: "postgres://smoke-db",
      expectText: ["hi"],
      expectTool: ["browser"],
      forbidToolError: true,
      inputs: ["say hi"],
    }));
    expect(write).toHaveBeenCalledWith(
      "Smoke passed.\nthread thread-1\nsession session-1\nartifacts /tmp/runtime-smoke/pass\n",
    );
  });

  it("prints json and sets a failing exit code when smoke fails", async () => {
    smokeCliMocks.result.current = {
      ...smokeCliMocks.result.current,
      error: {
        message: "Missing expected text: hi",
        stage: "assertions" as const,
      },
      success: false,
    };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      [
        "smoke",
        "--agent",
        "panda",
        "--db-url",
        "postgres://smoke-db",
        "--input",
        "say hi",
        "--json",
      ],
      {from: "user"},
    );

    expect(write).toHaveBeenCalledWith(expect.stringContaining("\"success\": false"));
    expect(process.exitCode).toBe(1);
  });

  it("starts interactive follow-up on the persisted smoke session", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      [
        "smoke",
        "--agent",
        "panda",
        "--db-url",
        "postgres://smoke-db",
        "--input",
        "say hi",
        "--interactive",
      ],
      {from: "user"},
    );

    expect(smokeCliMocks.startSmokeFollowUpRepl).toHaveBeenCalledWith({
      artifactDir: "/tmp/runtime-smoke/pass",
      dbUrl: "postgres://smoke-db",
      identity: "smoke",
      sessionId: "session-1",
      threadId: "thread-1",
      timeoutMs: 120_000,
    });
    expect(write).toHaveBeenCalledWith(
      "Smoke passed.\nthread thread-1\nsession session-1\nartifacts /tmp/runtime-smoke/pass\n",
    );
  });

  it("passes an explicit session target through to the harness", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      [
        "smoke",
        "--session",
        "session-existing",
        "--reuse-db",
        "--db-url",
        "postgres://smoke-db",
        "--input",
        "why did you fail?",
      ],
      {from: "user"},
    );

    expect(smokeCliMocks.runSmoke).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: undefined,
      dbUrl: "postgres://smoke-db",
      inputs: ["why did you fail?"],
      reuseDb: true,
      sessionId: "session-existing",
    }));
    expect(write).toHaveBeenCalledWith(
      "Smoke passed.\nthread thread-1\nsession session-1\nartifacts /tmp/runtime-smoke/pass\n",
    );
  });

  it("rejects session-targeted smoke without reuse-db", async () => {
    await expect(createProgram().parseAsync(
      [
        "smoke",
        "--session",
        "session-existing",
        "--db-url",
        "postgres://smoke-db",
        "--input",
        "why did you fail?",
      ],
      {from: "user"},
    )).rejects.toThrow("Session-targeted smoke requires --reuse-db.");

    expect(smokeCliMocks.runSmoke).not.toHaveBeenCalled();
  });

  it("rejects session-targeted smoke when model override is passed", async () => {
    await expect(createProgram().parseAsync(
      [
        "smoke",
        "--session",
        "session-existing",
        "--reuse-db",
        "--db-url",
        "postgres://smoke-db",
        "--model",
        "openai/gpt-5.4",
        "--input",
        "why did you fail?",
      ],
      {from: "user"},
    )).rejects.toThrow("Session-targeted smoke does not support --model.");

    expect(smokeCliMocks.runSmoke).not.toHaveBeenCalled();
  });

  it("rejects smoke when neither agent nor session is provided", async () => {
    await expect(createProgram().parseAsync(
      [
        "smoke",
        "--db-url",
        "postgres://smoke-db",
        "--input",
        "say hi",
      ],
      {from: "user"},
    )).rejects.toThrow("Pass --agent or --session.");

    expect(smokeCliMocks.runSmoke).not.toHaveBeenCalled();
  });
});
