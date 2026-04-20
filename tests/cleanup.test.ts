import {describe, expect, it, vi} from "vitest";

import {runCleanupSteps} from "../src/lib/cleanup.js";

describe("runCleanupSteps", () => {
  it("swallows cleanup errors by default after reporting them", async () => {
    const onError = vi.fn();

    await expect(runCleanupSteps([
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
    ], onError)).resolves.toBeUndefined();

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
