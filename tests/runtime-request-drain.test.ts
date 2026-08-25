import {createHash} from "node:crypto";

import {describe, expect, it, vi} from "vitest";

import type {RuntimeRequestRecord} from "../src/domain/threads/requests/index.js";
import {RuntimeRequestDrain} from "../src/app/runtime/request-drain.js";
import {sleep, waitFor} from "./helpers/wait-for.js";

function deferred(): {promise: Promise<void>; resolve(): void} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

function requestRecord(id: string): RuntimeRequestRecord {
  const now = Date.now();
  return {
    id,
    orderingKey: `v1:${createHash("sha256").update(id).digest("hex")}`,
    kind: "tui_input",
    status: "pending",
    claimToken: `claim-${id}`,
    payload: {
      actorId: "operator",
      externalMessageId: `message-${id}`,
      text: "hello",
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe("RuntimeRequestDrain", () => {
  it("does not let one slow request block an independent stream", async () => {
    const slow = deferred();
    const pending = [requestRecord("slow"), requestRecord("fast")];
    const requests = {
      claimNextPendingRequest: vi.fn(async () => pending.shift() ?? null),
      renewRequestClaim: vi.fn(async () => true),
      releaseRequestClaim: vi.fn(async () => true),
      completeRequest: vi.fn(async () => undefined),
      failRequest: vi.fn(async () => undefined),
      pruneSettledRequests: vi.fn(async () => 0),
    };
    const drain = new RuntimeRequestDrain({
      requests,
      maxConcurrency: 2,
      processRequest: async (request) => {
        if (request.id === "slow") await slow.promise;
        return request.id;
      },
    });

    drain.start();
    await waitFor(() => {
      expect(requests.completeRequest).toHaveBeenCalledWith("fast", "claim-fast", "fast");
    });
    expect(requests.completeRequest).not.toHaveBeenCalledWith("slow", "claim-slow", "slow");
    slow.resolve();
    await waitFor(() => {
      expect(requests.completeRequest).toHaveBeenCalledWith("slow", "claim-slow", "slow");
    });
    await drain.stop();
    expect(requests.completeRequest).toHaveBeenCalledWith("slow", "claim-slow", "slow");
  });

  it("claims and completes pending runtime requests", async () => {
    const pending = [requestRecord("first"), requestRecord("second")];
    const requests = {
      claimNextPendingRequest: vi.fn(async () => pending.shift() ?? null),
      renewRequestClaim: vi.fn(async () => true),
      releaseRequestClaim: vi.fn(async () => true),
      completeRequest: vi.fn(async () => undefined),
      failRequest: vi.fn(async () => undefined),
      pruneSettledRequests: vi.fn(async () => 0),
    };
    const drain = new RuntimeRequestDrain({
      requests,
      processRequest: vi.fn(async (request) => ({processed: request.id})),
    });

    drain.start();

    await waitFor(() => {
      expect(requests.completeRequest).toHaveBeenCalledTimes(2);
    });
    await drain.stop();

    expect(requests.completeRequest).toHaveBeenNthCalledWith(1, "first", "claim-first", {processed: "first"});
    expect(requests.completeRequest).toHaveBeenNthCalledWith(2, "second", "claim-second", {processed: "second"});
    expect(requests.failRequest).not.toHaveBeenCalled();
  });

  it("renews a claim while its request is still being processed", async () => {
    const active = deferred();
    const pending = [requestRecord("slow")];
    const requests = {
      claimNextPendingRequest: vi.fn(async () => pending.shift() ?? null),
      renewRequestClaim: vi.fn(async () => true),
      releaseRequestClaim: vi.fn(async () => true),
      completeRequest: vi.fn(async () => undefined),
      failRequest: vi.fn(async () => undefined),
      pruneSettledRequests: vi.fn(async () => 0),
    };
    const drain = new RuntimeRequestDrain({
      requests,
      claimRenewIntervalMs: 5,
      processRequest: async () => {
        await active.promise;
        return "done";
      },
    });

    drain.start();
    await waitFor(() => {
      expect(requests.renewRequestClaim).toHaveBeenCalledWith("slow", "claim-slow");
    });
    active.resolve();
    await waitFor(() => {
      expect(requests.completeRequest).toHaveBeenCalledWith("slow", "claim-slow", "done");
    });
    await drain.stop();
  });

  it("does not settle work after renewal proves the claim was lost", async () => {
    const active = deferred();
    const pending = [requestRecord("stolen")];
    const onError = vi.fn();
    const requests = {
      claimNextPendingRequest: vi.fn(async () => pending.shift() ?? null),
      renewRequestClaim: vi.fn(async () => false),
      releaseRequestClaim: vi.fn(async () => true),
      completeRequest: vi.fn(async () => undefined),
      failRequest: vi.fn(async () => undefined),
      pruneSettledRequests: vi.fn(async () => 0),
    };
    const drain = new RuntimeRequestDrain({
      requests,
      claimRenewIntervalMs: 5,
      onError,
      processRequest: async () => {
        await active.promise;
        return "obsolete result";
      },
    });

    drain.start();
    await waitFor(() => {
      expect(requests.renewRequestClaim).toHaveBeenCalled();
    });
    active.resolve();
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: "Runtime request stolen claim was lost while processing.",
      }));
    });
    await drain.stop();

    expect(requests.completeRequest).not.toHaveBeenCalled();
    expect(requests.failRequest).not.toHaveBeenCalled();
  });

  it("polls as a fallback when a request appears after startup without a kick", async () => {
    const pending: RuntimeRequestRecord[] = [];
    const requests = {
      claimNextPendingRequest: vi.fn(async () => pending.shift() ?? null),
      renewRequestClaim: vi.fn(async () => true),
      releaseRequestClaim: vi.fn(async () => true),
      completeRequest: vi.fn(async () => undefined),
      failRequest: vi.fn(async () => undefined),
      pruneSettledRequests: vi.fn(async () => 0),
    };
    const drain = new RuntimeRequestDrain({
      requests,
      pollIntervalMs: 1,
      processRequest: vi.fn(async (request) => ({processed: request.id})),
    });

    drain.start();
    await waitFor(() => {
      expect(requests.claimNextPendingRequest).toHaveBeenCalled();
    });
    pending.push(requestRecord("late"));

    await waitFor(() => {
      expect(requests.completeRequest).toHaveBeenCalledWith("late", "claim-late", {processed: "late"});
    });
    await drain.stop();
  });

  it("marks failed requests and keeps draining the queue", async () => {
    const pending = [requestRecord("bad"), requestRecord("good")];
    const requests = {
      claimNextPendingRequest: vi.fn(async () => pending.shift() ?? null),
      renewRequestClaim: vi.fn(async () => true),
      releaseRequestClaim: vi.fn(async () => true),
      completeRequest: vi.fn(async () => undefined),
      failRequest: vi.fn(async () => undefined),
      pruneSettledRequests: vi.fn(async () => 0),
    };
    const drain = new RuntimeRequestDrain({
      requests,
      processRequest: vi.fn(async (request) => {
        if (request.id === "bad") {
          throw new Error("bad request");
        }

        return "ok";
      }),
    });

    drain.start();

    await waitFor(() => {
      expect(requests.failRequest).toHaveBeenCalledWith("bad", "claim-bad", "bad request");
      expect(requests.completeRequest).toHaveBeenCalledWith("good", "claim-good", "ok");
    });
    await drain.stop();
  });

  it("cancels active work, releases its claim, and does not claim more after stop", async () => {
    const order: string[] = [];
    const pending = [requestRecord("first"), requestRecord("second")];
    const requests = {
      claimNextPendingRequest: vi.fn(async () => pending.shift() ?? null),
      renewRequestClaim: vi.fn(async () => true),
      releaseRequestClaim: vi.fn(async (id: string) => {
        order.push(`release-${id}`);
        return true;
      }),
      completeRequest: vi.fn(async (id: string) => {
        order.push(`complete-${id}`);
      }),
      failRequest: vi.fn(async () => undefined),
      pruneSettledRequests: vi.fn(async () => 0),
    };
    const drain = new RuntimeRequestDrain({
      requests,
      maxConcurrency: 1,
      processRequest: vi.fn(async (request, signal) => {
        order.push(`process-start-${request.id}`);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            order.push(`process-abort-${request.id}`);
            resolve();
          }, {once: true});
        });
        signal.throwIfAborted();
        return request.id;
      }),
    });

    drain.start();
    await waitFor(() => {
      expect(order).toEqual(["process-start-first"]);
    });

    await drain.stop();
    await sleep(20);

    expect(order).toEqual([
      "process-start-first",
      "process-abort-first",
      "release-first",
    ]);
    expect(requests.claimNextPendingRequest).toHaveBeenCalledTimes(1);
    expect(requests.failRequest).not.toHaveBeenCalled();
    expect(requests.completeRequest).not.toHaveBeenCalled();
  });

  it("bounds shutdown and stops renewing a non-cooperative request", async () => {
    const active = deferred();
    const pending = [requestRecord("stuck")];
    const requests = {
      claimNextPendingRequest: vi.fn(async () => pending.shift() ?? null),
      renewRequestClaim: vi.fn(async () => true),
      releaseRequestClaim: vi.fn(async () => true),
      completeRequest: vi.fn(async () => undefined),
      failRequest: vi.fn(async () => undefined),
      pruneSettledRequests: vi.fn(async () => 0),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const drain = new RuntimeRequestDrain({
      requests,
      claimRenewIntervalMs: 5,
      shutdownDrainTimeoutMs: 20,
      processRequest: async () => {
        await active.promise;
        return "late";
      },
    });

    try {
      drain.start();
      await waitFor(() => {
        expect(requests.renewRequestClaim).toHaveBeenCalled();
      });

      await drain.stop();
      expect(consoleError).toHaveBeenCalledWith(
        "Runtime request drain shutdown timed out",
        {activeRequests: 1, timeoutMs: 20},
      );
      const renewalsAtStop = requests.renewRequestClaim.mock.calls.length;
      await sleep(20);
      expect(requests.renewRequestClaim).toHaveBeenCalledTimes(renewalsAtStop);
      expect(requests.releaseRequestClaim).not.toHaveBeenCalled();
      expect(requests.completeRequest).not.toHaveBeenCalled();

      active.resolve();
      await waitFor(() => {
        expect(requests.releaseRequestClaim).toHaveBeenCalledWith("stuck", "claim-stuck");
      });
      expect(requests.completeRequest).not.toHaveBeenCalled();
    } finally {
      active.resolve();
      consoleError.mockRestore();
    }
  });

  it("prunes completed and failed requests with separate retention windows", async () => {
    const requests = {
      claimNextPendingRequest: vi.fn(async () => null),
      renewRequestClaim: vi.fn(async () => true),
      releaseRequestClaim: vi.fn(async () => true),
      completeRequest: vi.fn(async () => undefined),
      failRequest: vi.fn(async () => undefined),
      pruneSettledRequests: vi.fn(async () => 0),
    };
    const drain = new RuntimeRequestDrain({
      requests,
      now: () => 100_000,
      completedRetentionMs: 10_000,
      failedRetentionMs: 20_000,
      pruneBatchSize: 25,
      processRequest: vi.fn(),
    });

    drain.start();
    await waitFor(() => {
      expect(requests.pruneSettledRequests).toHaveBeenCalledWith({
        completedBefore: new Date(90_000),
        failedBefore: new Date(80_000),
        limit: 25,
      });
    });
    await drain.stop();
  });
});
