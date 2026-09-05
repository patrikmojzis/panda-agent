import {describe, expect, it, vi} from "vitest";

import {runCleanupSteps} from "../src/lib/cleanup.js";

const falsyFailures = [undefined, null, false, 0, ""];

describe("runCleanupSteps", () => {
  it.each(falsyFailures.flatMap((error) => [false, true].map((rethrow) => ({error, rethrow}))))("retains first falsy cleanup failure $error (rethrow: $rethrow)", async ({error, rethrow}) => {
    const laterError = new Error("later cleanup failed");
    const last = vi.fn();
    const onError = vi.fn();
    const steps = [
      {label: "first", run: () => { throw error; }},
      {label: "second", run: async () => { throw laterError; }},
      {label: "last", run: last},
    ];

    const cleanup = runCleanupSteps(steps, onError, {rethrow});
    if (rethrow) await expect(cleanup).rejects.toBe(error);
    else await expect(cleanup).resolves.toBeUndefined();

    expect(last).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenNthCalledWith(1, steps[0], error);
    expect(onError).toHaveBeenNthCalledWith(2, steps[1], laterError);
  });

  it.each([...falsyFailures, new Error("first reporter failed")].flatMap((error) => [false, true].map((rethrow) => ({error, rethrow}))))("retains first reporter failure $error after completing cleanup (rethrow: $rethrow)", async ({error, rethrow}) => {
    const order: string[] = [];
    const failures = [new Error("first cleanup"), new Error("second cleanup"), new Error("third cleanup")];
    const steps = failures.map((failure, index) => ({
      label: String(index),
      run: () => { order.push(`step:${index}`); throw failure; },
    }));
    const onError = vi.fn(async (step: {label: string}) => {
      order.push(`report:${step.label}:start`);
      await Promise.resolve();
      order.push(`report:${step.label}:end`);
      if (step.label === "1") throw error;
      if (step.label === "2") throw new Error("later reporter failed");
    });

    await expect(runCleanupSteps([
      ...steps,
      {label: "last", run: () => { order.push("last"); }},
    ], onError, {rethrow})).rejects.toBe(error);

    expect(order).toEqual([
      "step:0", "report:0:start", "report:0:end",
      "step:1", "report:1:start", "report:1:end",
      "step:2", "report:2:start", "report:2:end", "last",
    ]);
    for (const [index, step] of steps.entries()) {
      expect(onError).toHaveBeenNthCalledWith(index + 1, step, failures[index]);
    }
  });

  it("finishes nested cleanup before the outer default cleanup handles its reporter failure", async () => {
    const order: string[] = [];
    const reporterError = new Error("inner reporter failed");
    const outerReporter = vi.fn(() => { order.push("outer:report"); });
    await runCleanupSteps([
      {label: "inner", run: () => runCleanupSteps([
        {label: "failed", run: () => { throw new Error("inner cleanup failed"); }},
        {label: "remaining", run: () => { order.push("inner:remaining"); }},
      ], () => { throw reporterError; })},
      {label: "remaining", run: () => { order.push("outer:remaining"); }},
    ], outerReporter);

    expect(order).toEqual(["inner:remaining", "outer:report", "outer:remaining"]);
    expect(outerReporter).toHaveBeenCalledWith(expect.objectContaining({label: "inner"}), reporterError);
  });

  it("swallows cleanup errors by default after reporting them", async () => {
    const onError = vi.fn();

    await runCleanupSteps([
      {
        label: "first",
        run: async () => {
          throw new Error("boom");
        },
      },
      {
        label: "second",
        run: async () => {},
      },
    ], onError);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({label: "first"});
  });

  it("can rethrow the first cleanup error when asked", async () => {
    await expect(runCleanupSteps([
      {
        label: "first",
        run: async () => {
          throw new Error("boom");
        },
      },
    ], undefined, {
      rethrow: true,
    })).rejects.toThrow("boom");
  });
});
