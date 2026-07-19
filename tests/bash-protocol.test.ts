import {describe, expect, it} from "vitest";

import {
  parseBashRunnerAbortResponse,
  parseBashRunnerExecResponse,
  parseBashRunnerJobResponse,
  parseBashRunnerResponse,
} from "../src/integrations/shell/bash-protocol.js";

function validExecResponse(): Record<string, unknown> {
  return {
    ok: true,
    shell: "/bin/zsh",
    finalCwd: "/workspace",
    durationMs: 12,
    timeoutMs: 1_000,
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    abortReason: null,
    interrupted: false,
    success: true,
    stdout: "done",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutChars: 4,
    stderrChars: 0,
    stdoutPersisted: false,
    stderrPersisted: false,
    noOutput: false,
    trackedEnvKeys: ["OPENAI_API_KEY"],
    persistedEnvEntries: [
      {
        key: "OPENAI_API_KEY",
        present: true,
        value: "sk-test",
      },
    ],
  };
}

function validJobResponse(): Record<string, unknown> {
  return {
    ok: true,
    jobId: "job-1",
    status: "completed",
    command: "printf done",
    initialCwd: "/workspace",
    maxRuntimeMs: 1_800_000,
    expiresAt: 1_701_800_000,
    finalCwd: "/workspace",
    startedAt: 1_700_000_000,
    finishedAt: 1_700_000_100,
    durationMs: 100,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "done",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutChars: 4,
    stderrChars: 0,
    stdoutPersisted: false,
    stderrPersisted: false,
    trackedEnvKeys: [],
  };
}

describe("bash runner protocol", () => {
  it("parses foreground runner responses", () => {
    expect(parseBashRunnerExecResponse(validExecResponse())).toMatchObject({
      ok: true,
      shell: "/bin/zsh",
      stdout: "done",
      persistedEnvEntries: [
        {
          key: "OPENAI_API_KEY",
          present: true,
          value: "sk-test",
        },
      ],
    });
  });

  it("parses background job runner responses", () => {
    expect(parseBashRunnerJobResponse(validJobResponse())).toMatchObject({
      ok: true,
      jobId: "job-1",
      status: "completed",
      stdout: "done",
      maxRuntimeMs: 1_800_000,
      expiresAt: 1_701_800_000,
    });
  });

  it("parses runner errors and abort responses", () => {
    expect(parseBashRunnerResponse({
      ok: false,
      error: "Missing cwd.",
      details: {
        cwd: "/missing",
      },
    })).toEqual({
      ok: false,
      error: "Missing cwd.",
      details: {
        cwd: "/missing",
      },
    });

    expect(parseBashRunnerAbortResponse({
      ok: true,
      aborted: true,
    })).toEqual({
      ok: true,
      aborted: true,
    });
  });

  it("rejects malformed runner responses", () => {
    expect(() => parseBashRunnerExecResponse({
      ...validExecResponse(),
      stdoutChars: "4",
    })).toThrow("Remote bash runner returned an invalid response.");

    expect(() => parseBashRunnerJobResponse({
      ...validJobResponse(),
      status: "sleeping",
    })).toThrow("Remote bash runner returned an invalid response.");

    expect(() => parseBashRunnerResponse({
      ok: false,
      error: "bad details",
      details: {
        value: Number.NaN,
      },
    })).toThrow("Remote bash runner returned an invalid response.");

    expect(() => parseBashRunnerAbortResponse({
      ok: true,
    })).toThrow("Remote bash runner returned an invalid response.");
  });
});
