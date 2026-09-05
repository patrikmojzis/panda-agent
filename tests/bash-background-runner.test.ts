import {describe, expect, it} from "vitest";

import {startBashBackgroundJob} from "../src/integrations/shell/bash-background-runner.js";

describe("remote background start compensation", () => {
  it.each([
    {stage: "transport", diagnostic: "start was ambiguous", originalMessage: "Start response lost."},
    {stage: "http", diagnostic: "was rejected ambiguously", originalMessage: "Proxy rejected the response."},
    {stage: "payload", diagnostic: "returned an ambiguous response", originalMessage: "Remote bash runner returned an invalid background job response."},
  ])("retains both errors when compensation fails after $stage failure", async ({stage, diagnostic, originalMessage}) => {
    const controller = new AbortController();
    const startError = new Error(originalMessage);
    const compensationError = new Error("Cancellation transport failed.");
    const requests: string[] = [];
    let startSignal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const endpoint = new URL(String(input)).pathname;
      requests.push(endpoint);
      if (endpoint.endsWith("/jobs/start")) {
        startSignal = init?.signal;
        controller.abort(new Error("Runtime shutdown."));
        if (stage === "transport") throw startError;
        return new Response(JSON.stringify(stage === "http"
          ? {ok: false, error: originalMessage}
          : {ok: true}), {status: stage === "http" ? 502 : 200});
      }

      expect(endpoint).toBe("/agents/panda/jobs/cancel");
      expect(init?.signal).toBeDefined();
      expect(init?.signal).not.toBe(startSignal);
      expect(init?.signal?.aborted).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({
        jobId: "job-ambiguous",
        timeoutMs: 5_000,
        reserveIfMissing: true,
      });
      throw compensationError;
    };

    const result = startBashBackgroundJob({
      jobId: "job-ambiguous",
      signal: controller.signal,
      command: "echo ready",
      cwd: "/workspace",
      maxRuntimeMs: 1_000,
      trackedEnvKeys: [],
      maxOutputChars: 1_000,
      persistOutputThresholdChars: 1_000,
      outputDirectory: "/unused",
      redactionValues: [],
      persistOutputFiles: false,
      context: {agentKey: "panda"},
      processEnv: {
        BASH_EXECUTION_MODE: "remote",
        BASH_SERVER_URL_TEMPLATE: "http://runner/agents/{agentKey}",
      },
      fetchImpl,
    });

    const error: unknown = await result.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toBe(`Remote background job job-ambiguous ${diagnostic} and compensation failed.`);
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toMatchObject({message: originalMessage});
    if (stage === "transport") expect(aggregate.errors[0]).toBe(startError);
    expect(aggregate.errors[1]).toBe(compensationError);
    expect(requests).toEqual(["/agents/panda/jobs/start", "/agents/panda/jobs/cancel"]);
  });
});
