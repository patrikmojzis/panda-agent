import { afterEach, describe, expect, it, vi } from "vitest";

const tuiRuntimeMocks = vi.hoisted(() => ({
  createPandaRuntime: vi.fn(),
  resolveStoredPandaContext: vi.fn((_value: unknown, fallback: Record<string, unknown>) => ({ ...fallback })),
}));

vi.mock("../src/features/panda/runtime.js", () => ({
  createPandaRuntime: tuiRuntimeMocks.createPandaRuntime,
  resolveStoredPandaContext: tuiRuntimeMocks.resolveStoredPandaContext,
}));

import { createChatRuntime } from "../src/features/tui/runtime.js";

describe("createChatRuntime", () => {
  afterEach(() => {
    tuiRuntimeMocks.createPandaRuntime.mockReset();
    tuiRuntimeMocks.resolveStoredPandaContext.mockClear();
  });

  it("closes the shared Panda runtime when identity lookup fails", async () => {
    const close = vi.fn(async () => {});

    tuiRuntimeMocks.createPandaRuntime.mockResolvedValue({
      close,
      coordinator: {},
      extraTools: [],
      identityStore: {
        ensureIdentity: vi.fn(),
        getIdentityByHandle: vi.fn(async () => {
          throw new Error("Identity alice not found.");
        }),
      },
      store: {},
    });

    await expect(createChatRuntime({
      cwd: "/workspace/panda",
      locale: "en-US",
      timezone: "UTC",
      identity: "alice",
    })).rejects.toThrow("Identity alice not found.");

    expect(close).toHaveBeenCalledTimes(1);
  });
});
