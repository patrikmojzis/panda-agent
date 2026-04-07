import { describe, expect, it, vi } from "vitest";

import type { ThreadRunRecord } from "../src/features/thread-runtime/index.js";
import type { ChatRuntimeServices } from "../src/features/tui/runtime.js";
import { PandaChatApp } from "../src/features/tui/chat.js";

type AppHarness = {
  closed: boolean;
  currentThreadId: string;
  runPhase: "idle" | "thinking";
  services: ChatRuntimeServices | null;
  render(): void;
  handleKeypress(sequence: string, key: { ctrl?: boolean; name?: string }): Promise<void>;
  observeLatestRun(runs: readonly ThreadRunRecord[]): void;
  cleanup(): Promise<void>;
};

function flushTimers(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("PandaChatApp Ctrl-C handling", () => {
  it("aborts once and closes after the active run settles", async () => {
    const abort = vi.fn(async () => true);
    const waitForIdle = vi.fn(async () => {});
    const app = new PandaChatApp() as unknown as AppHarness;

    app.currentThreadId = "thread-ctrl-c";
    app.runPhase = "thinking";
    app.services = {
      coordinator: {
        abort,
        waitForIdle,
      },
    } as unknown as ChatRuntimeServices;
    app.render = vi.fn();

    await app.handleKeypress("\u0003", { ctrl: true, name: "c" });

    expect(abort).toHaveBeenCalledWith("thread-ctrl-c", "Aborted from Ctrl-C.");
    expect(app.closed).toBe(false);

    app.observeLatestRun([{
      id: "run-ctrl-c",
      threadId: "thread-ctrl-c",
      status: "failed",
      startedAt: Date.now() - 100,
      finishedAt: Date.now(),
      error: "Aborted from Ctrl-C.",
    }]);

    await flushTimers();

    expect(waitForIdle).toHaveBeenCalledWith("thread-ctrl-c");
    expect(app.closed).toBe(true);
  });

  it("pauses stdin during cleanup so the process can exit", async () => {
    const pause = vi.spyOn(process.stdin, "pause");
    const offStdin = vi.spyOn(process.stdin, "off");
    const offStdout = vi.spyOn(process.stdout, "off");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const close = vi.fn(async () => {});
    const app = new PandaChatApp() as unknown as AppHarness;

    app.services = {
      close,
    } as unknown as ChatRuntimeServices;

    await app.cleanup();

    expect(pause).toHaveBeenCalledTimes(1);
    expect(offStdin).toHaveBeenCalled();
    expect(offStdout).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);

    pause.mockRestore();
    offStdin.mockRestore();
    offStdout.mockRestore();
    write.mockRestore();
  });
});

describe("PandaChatApp thinking command", () => {
  it("updates and clears thinking on the current thread", async () => {
    const updateThread = vi.fn(async (_threadId: string, update: { thinking?: "high" | null }) => ({
      id: "thread-thinking",
      agentKey: "panda",
      provider: "openai",
      model: "gpt-5.1",
      thinking: update.thinking ?? undefined,
      createdAt: 1,
      updatedAt: 2,
    }));
    const app = new PandaChatApp() as any;

    app.currentThreadId = "thread-thinking";
    app.services = {
      store: {
        updateThread,
      },
    } as ChatRuntimeServices;

    await app.handleCommand("/thinking high");
    expect(updateThread).toHaveBeenNthCalledWith(1, "thread-thinking", { thinking: "high" });
    expect(app.thinking).toBe("high");

    await app.handleCommand("/thinking off");
    expect(updateThread).toHaveBeenNthCalledWith(2, "thread-thinking", { thinking: null });
    expect(app.thinking).toBeUndefined();
  });
});
