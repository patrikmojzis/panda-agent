import {describe, expect, it, vi} from "vitest";

import {stringToUserMessage} from "../src/kernel/agent/index.js";
import {createCompactBoundaryMessage, type ThreadRunRecord} from "../src/domain/threads/runtime/index.js";
import * as markdown from "../src/ui/tui/markdown.js";
import {buildChatHelpText} from "../src/ui/tui/chat-commands.js";
import {buildChatViewModel, buildWelcomeTranscriptLines} from "../src/ui/tui/chat-view.js";
import type {ChatRuntimeServices} from "../src/ui/tui/runtime.js";
import * as tuiRuntime from "../src/ui/tui/runtime.js";
import {stripAnsi} from "../src/ui/tui/theme.js";
import {createComposerState, setComposerValue} from "../src/ui/tui/composer.js";
import {ChatApp, runChatCli} from "../src/ui/tui/chat.js";
import {collectThreadUsageSnapshot, formatThreadUsageSnapshot,} from "../src/ui/tui/usage-summary.js";

type AppHarness = {
  closed: boolean;
  currentThreadId: string;
  runPhase: "idle" | "thinking";
  services: ChatRuntimeServices | null;
  transcript: Array<{ title: string; body: string }>;
  render(): void;
  handleKeypress(sequence: string, key: { ctrl?: boolean; meta?: boolean; shift?: boolean; name?: string }): Promise<void>;
  observeLatestRun(runs: readonly ThreadRunRecord[]): void;
  cleanup(): Promise<void>;
};

function flushTimers(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function assistantWithUsage(
  text: string,
  overrides: Partial<{
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
  }> = {},
) {
  return {
    role: "assistant" as const,
    content: [{type: "text" as const, text}],
    api: "openai-responses" as const,
    provider: overrides.provider ?? "anthropic",
    model: overrides.model ?? "claude-opus-4-6",
    usage: overrides.usage ?? {
      input: 3,
      output: 42,
      cacheRead: 120,
      cacheWrite: 180,
      totalTokens: 345,
      cost: {
        input: 0.001,
        output: 0.010,
        cacheRead: 0.005,
        cacheWrite: 0.007,
        total: 0.023,
      },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function imageToolResult(data = "abcd".repeat(200)) {
  return {
    role: "toolResult" as const,
    toolCallId: "tool-call-1",
    toolName: "browser",
    content: [
      {type: "text" as const, text: "Stored screenshot"},
      {type: "image" as const, data, mimeType: "image/png"},
    ],
    isError: false,
    timestamp: Date.now(),
  };
}

describe("ChatApp Ctrl-C handling", () => {
  it("aborts once and closes after the active run settles", async () => {
    const abortThread = vi.fn(async () => true);
    const waitForCurrentRun = vi.fn(async () => {});
    const app = new ChatApp() as unknown as AppHarness;

    app.currentThreadId = "thread-ctrl-c";
    app.runPhase = "thinking";
    app.services = {
      abortThread,
      waitForCurrentRun,
    } as unknown as ChatRuntimeServices;
    app.render = vi.fn();

    await app.handleKeypress("\u0003", { ctrl: true, name: "c" });

    expect(abortThread).toHaveBeenCalledWith("thread-ctrl-c", "Aborted from Ctrl-C.");
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

    expect(waitForCurrentRun).toHaveBeenCalledWith("thread-ctrl-c");
    expect(app.closed).toBe(true);
  });

  it("pauses stdin during cleanup so the process can exit", async () => {
    const abortThread = vi.fn(async () => true);
    const waitForCurrentRun = vi.fn(async () => {});
    const pause = vi.spyOn(process.stdin, "pause");
    const offStdin = vi.spyOn(process.stdin, "off");
    const offStdout = vi.spyOn(process.stdout, "off");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const close = vi.fn(async () => {});
    const app = new ChatApp() as unknown as AppHarness;

    app.currentThreadId = "thread-cleanup";
    app.runPhase = "thinking";
    app.services = {
      abortThread,
      waitForCurrentRun,
      close,
    } as unknown as ChatRuntimeServices;

    await app.cleanup();

    expect(abortThread).toHaveBeenCalledWith("thread-cleanup", "TUI closed.");
    expect(waitForCurrentRun).toHaveBeenCalledWith("thread-cleanup");
    expect(pause).toHaveBeenCalledTimes(1);
    expect(offStdin).toHaveBeenCalled();
    expect(offStdout).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith("\u001b[?2004l");
    expect(write).toHaveBeenCalledWith("\u001b[>4m\u001b[<u");
    expect(close).toHaveBeenCalledTimes(1);

    pause.mockRestore();
    offStdin.mockRestore();
    offStdout.mockRestore();
    write.mockRestore();
  });

});

describe("ChatApp bracketed paste", () => {
  it("keeps pasted returns inside the composer until paste ends", async () => {
    const app = new ChatApp() as any;
    const submitComposer = vi.spyOn(app, "submitComposer").mockResolvedValue(undefined);

    app.render = vi.fn();

    await app.handleKeypress("", { name: "paste-start" });
    await app.handleKeypress("f", { name: "f" });
    await app.handleKeypress("\r", { name: "return" });
    await app.handleKeypress("o", { name: "o" });
    await app.handleKeypress("o", { name: "o" });
    await app.handleKeypress("", { name: "paste-end" });

    expect(submitComposer).not.toHaveBeenCalled();
    expect(app.composer.value).toBe("f\noo");

    await app.handleKeypress("\r", { name: "return" });

    expect(submitComposer).toHaveBeenCalledTimes(1);
  });
});

describe("ChatApp Shift+Enter", () => {
  it("turns backslash-enter into a newline without sending", async () => {
    const app = new ChatApp() as any;
    const submitComposer = vi.spyOn(app, "submitComposer").mockResolvedValue(undefined);

    app.render = vi.fn();
    app.composer = createComposerState("alpha\\");

    await app.handleKeypress("\r", { name: "return" });

    expect(submitComposer).not.toHaveBeenCalled();
    expect(app.composer.value).toBe("alpha\n");
    expect(app.composer.cursor).toBe("alpha\n".length);
  });

  it("inserts a newline when shift is held on return", async () => {
    const app = new ChatApp() as any;
    const submitComposer = vi.spyOn(app, "submitComposer").mockResolvedValue(undefined);

    app.render = vi.fn();
    app.composer = createComposerState("alpha");

    await app.handleKeypress("", { shift: true, name: "return" });

    expect(submitComposer).not.toHaveBeenCalled();
    expect(app.composer.value).toBe("alpha\n");
  });

  it("inserts a newline for meta-enter terminal keybindings", async () => {
    const app = new ChatApp() as any;
    const submitComposer = vi.spyOn(app, "submitComposer").mockResolvedValue(undefined);

    app.render = vi.fn();
    app.composer = createComposerState("alpha");

    await app.handleKeypress("\u001b\r", { meta: true, name: "return", sequence: "\u001b\r" });
    await app.handleKeypress("\u001b\n", { meta: true, name: "enter", sequence: "\u001b\n" });

    expect(submitComposer).not.toHaveBeenCalled();
    expect(app.composer.value).toBe("alpha\n\n");
  });

  it("inserts a newline for kitty and modifyOtherKeys Shift+Enter sequences", async () => {
    const app = new ChatApp() as any;
    const submitComposer = vi.spyOn(app, "submitComposer").mockResolvedValue(undefined);

    app.render = vi.fn();

    await app.handleKeypress(undefined, { name: "undefined", sequence: "\u001b[13;2u", code: "[13;2u" });
    await app.handleKeypress(undefined, { name: "undefined", sequence: "\u001b[27;2;", code: "[27;2;" });
    await app.handleKeypress("1", { name: "1", sequence: "1" });
    await app.handleKeypress("3", { name: "3", sequence: "3" });
    await app.handleKeypress("~", { sequence: "~" });

    expect(submitComposer).not.toHaveBeenCalled();
    expect(app.composer.value).toBe("\n\n");
  });
});

describe("ChatApp composer word shortcuts", () => {
  it("supports meta-left and meta-b for moving backward by word", async () => {
    const app = new ChatApp() as any;
    app.render = vi.fn();

    const value = "alpha beta gamma";
    app.composer = createComposerState(value);

    await app.handleKeypress("", { meta: true, name: "left" });
    expect(app.composer.cursor).toBe("alpha beta ".length);

    await app.handleKeypress("\u001bb", { name: "b" });
    expect(app.composer.cursor).toBe("alpha ".length);
  });

  it("supports raw alt-arrow sequences and meta-f/right for moving forward by word", async () => {
    const app = new ChatApp() as any;
    app.render = vi.fn();

    const value = "alpha beta gamma";
    app.composer = setComposerValue(value, "alpha ".length);

    await app.handleKeypress("\u001b[1;3C", { name: "right" });
    expect(app.composer.cursor).toBe("alpha beta".length);

    await app.handleKeypress("\u001bf", { name: "f" });
    expect(app.composer.cursor).toBe(value.length);

    app.composer = setComposerValue(value, 0);
    await app.handleKeypress("", { meta: true, name: "right" });
    expect(app.composer.cursor).toBe("alpha".length);
  });

  it("supports meta-backspace for deleting the previous word", async () => {
    const app = new ChatApp() as any;
    app.render = vi.fn();

    const value = "alpha beta gamma";
    app.composer = createComposerState(value);

    await app.handleKeypress("\u001b\u007f", { name: "backspace" });
    expect(app.composer.value).toBe("alpha beta ");
    expect(app.composer.cursor).toBe("alpha beta ".length);

    await app.handleKeypress("", { meta: true, name: "backspace" });
    expect(app.composer.value).toBe("alpha ");
    expect(app.composer.cursor).toBe("alpha ".length);
  });
});

describe("ChatApp thinking command", () => {
  it("updates and clears thinking on the current thread", async () => {
    const updateThread = vi.fn(async (_threadId: string, update: { thinking?: "high" | null }) => ({
      id: "thread-thinking",
      agentKey: "panda",
      model: "openai/gpt-5.1",
      thinking: update.thinking ?? undefined,
      createdAt: 1,
      updatedAt: 2,
    }));
    const app = new ChatApp() as any;

    app.currentThreadId = "thread-thinking";
    app.services = {
      updateThread,
    } as ChatRuntimeServices;

    await app.handleCommand("/thinking high");
    expect(updateThread).toHaveBeenNthCalledWith(1, "thread-thinking", { thinking: "high" });
    expect(app.thinking).toBe("high");

    await app.handleCommand("/thinking off");
    expect(updateThread).toHaveBeenNthCalledWith(2, "thread-thinking", { thinking: null });
    expect(app.thinking).toBeUndefined();
  });

  it("surfaces store failures for model and thinking updates", async () => {
    const updateThread = vi.fn(async () => {
      throw new Error("store unavailable");
    });
    const app = new ChatApp() as any;

    app.currentThreadId = "thread-config";
    app.model = "openai/gpt-5.1";
    app.thinking = "medium";
    app.currentThread = {
      id: "thread-config",
      model: "openai/gpt-5.1",
      thinking: "medium",
    };
    app.services = {
      updateThread,
    } as ChatRuntimeServices;

    await expect(app.handleCommand("/model openai/gpt-5.2")).resolves.toBe(true);
    expect(app.model).toBe("openai/gpt-5.1");
    expect(app.transcript.at(-1)).toMatchObject({
      role: "error",
      title: "config",
      body: "store unavailable",
    });

    await expect(app.handleCommand("/thinking high")).resolves.toBe(true);
    expect(app.thinking).toBe("medium");
    expect(app.transcript.at(-1)).toMatchObject({
      role: "error",
      title: "config",
      body: "store unavailable",
    });
  });
});

describe("ChatApp fresh-session agent selection", () => {
  it("does not inherit the current session agent for /new when no explicit chat agent is set", async () => {
    const createBranchSession = vi.fn(async () => ({
      id: "thread-new",
      sessionId: "session-branch",
      model: "openai/gpt-5.1",
      context: {
        agentKey: "jozef",
        sessionId: "session-branch",
        identityId: "test-user",
      },
      createdAt: 1,
      updatedAt: 2,
    }));
    const app = new ChatApp() as any;
    const expectedModel = app.model;

    app.currentThreadId = "thread-current";
    app.currentThread = {
      id: "thread-current",
      sessionId: "session-main",
      model: "openai/gpt-5.1",
      context: {
        agentKey: "panda",
        sessionId: "session-main",
        identityId: "test-user",
      },
      createdAt: 1,
      updatedAt: 1,
    };
    app.services = {
      createBranchSession,
    } as ChatRuntimeServices;
    app.switchThread = vi.fn(async (thread) => {
      app.currentThread = thread;
      app.currentThreadId = thread.id;
    });
    app.pushEntry = vi.fn();
    app.setNotice = vi.fn();

    await expect(app.handleCommand("/new")).resolves.toBe(true);

    expect(createBranchSession).toHaveBeenCalledWith({
      sessionId: undefined,
      agentKey: undefined,
      model: expectedModel,
      thinking: undefined,
    });
  });

  it("does not inherit the current session agent for /reset when no explicit chat agent is set", async () => {
    const resetSession = vi.fn(async () => ({
      id: "thread-reset",
      sessionId: "session-main",
      model: "openai/gpt-5.1",
      context: {
        agentKey: "jozef",
        sessionId: "session-main",
        identityId: "test-user",
      },
      createdAt: 1,
      updatedAt: 2,
    }));
    const app = new ChatApp() as any;
    const expectedModel = app.model;

    app.currentThreadId = "thread-current";
    app.currentThread = {
      id: "thread-current",
      sessionId: "session-main",
      model: "openai/gpt-5.1",
      context: {
        agentKey: "panda",
        sessionId: "session-main",
        identityId: "test-user",
      },
      createdAt: 1,
      updatedAt: 1,
    };
    app.services = {
      resetSession,
    } as ChatRuntimeServices;
    app.switchThread = vi.fn(async (thread) => {
      app.currentThread = thread;
      app.currentThreadId = thread.id;
    });
    app.pushEntry = vi.fn();
    app.setNotice = vi.fn();

    await expect(app.handleCommand("/reset")).resolves.toBe(true);

    expect(resetSession).toHaveBeenCalledWith({
      agentKey: undefined,
      model: expectedModel,
      sessionId: "session-main",
      thinking: undefined,
    });
  });
});

describe("ChatApp history search", () => {
  it("filters history matches and loads the selected prompt into the composer", async () => {
    const app = new ChatApp() as any;
    app.render = vi.fn();
    app.inputHistory.push("deploy alpha", "fix bug", "deploy beta");

    await app.handleKeypress("\u0012", { ctrl: true, name: "r" });
    await app.handleKeypress("d", { name: "d" });
    await app.handleKeypress("e", { name: "e" });
    await app.handleKeypress("p", { name: "p" });
    await app.handleKeypress("l", { name: "l" });
    await app.handleKeypress("o", { name: "o" });
    await app.handleKeypress("y", { name: "y" });
    await app.handleKeypress("\u0012", { ctrl: true, name: "r" });
    await app.handleKeypress("\r", { name: "return" });

    expect(app.historySearch.active).toBe(false);
    expect(app.composer.value).toBe("deploy alpha");
  });
});

describe("ChatApp session picker", () => {
  it("preselects the current session and opens the chosen entry", async () => {
    const sessions = [
      {
        id: "session-a",
        agentKey: "panda",
        kind: "main" as const,
        currentThreadId: "thread-a",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "session-b",
        agentKey: "panda",
        kind: "branch" as const,
        currentThreadId: "thread-b",
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: "session-c",
        agentKey: "panda",
        kind: "branch" as const,
        currentThreadId: "thread-c",
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    const selectedThread = {
      id: "thread-c",
      sessionId: "session-c",
      context: {agentKey: "panda", sessionId: "session-c"},
      createdAt: 3,
      updatedAt: 3,
    };
    const listAgentSessions = vi.fn(async () => sessions);
    const openSession = vi.fn(async () => selectedThread);
    const app = new ChatApp() as any;

    app.currentThreadId = "thread-b";
    app.currentThread = {
      id: "thread-b",
      sessionId: "session-b",
      context: {agentKey: "panda", sessionId: "session-b"},
      createdAt: 2,
      updatedAt: 2,
    };
    app.render = vi.fn();
    app.services = {
      listAgentSessions,
      openSession,
    } as ChatRuntimeServices;
    app.switchThread = vi.fn(async (thread) => {
      app.currentThread = thread;
      app.currentThreadId = thread.id;
    });
    app.setNotice = vi.fn();

    await app.openSessionPicker();

    expect(listAgentSessions).toHaveBeenCalledWith("panda");
    expect(app.sessionPicker.active).toBe(true);
    expect(app.sessionPicker.selected).toBe(1);

    app.cycleSessionPicker(1);
    await app.selectSessionPickerEntry();

    expect(openSession).toHaveBeenCalledWith("session-c");
    expect(app.switchThread).toHaveBeenCalledWith(selectedThread);
    expect(app.sessionPicker.active).toBe(false);
    expect(app.setNotice).toHaveBeenCalledWith("Opened session session-c.", "info");
  });

  it("keeps the picker open and refreshes when the selected session goes stale", async () => {
    const firstSessions = [
      {
        id: "session-a",
        agentKey: "panda",
        kind: "main" as const,
        currentThreadId: "thread-a",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "session-b",
        agentKey: "panda",
        kind: "branch" as const,
        currentThreadId: "thread-b",
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    const refreshedSessions = [
      {
        id: "session-a",
        agentKey: "panda",
        kind: "main" as const,
        currentThreadId: "thread-a",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const listAgentSessions = vi.fn()
      .mockResolvedValueOnce(firstSessions)
      .mockResolvedValueOnce(refreshedSessions);
    const openSession = vi.fn(async () => {
      throw new Error("missing session");
    });
    const app = new ChatApp() as any;

    app.currentThreadId = "thread-a";
    app.currentThread = {
      id: "thread-a",
      sessionId: "session-a",
      context: {agentKey: "panda", sessionId: "session-a"},
      createdAt: 1,
      updatedAt: 1,
    };
    app.render = vi.fn();
    app.services = {
      listAgentSessions,
      openSession,
    } as ChatRuntimeServices;
    app.switchThread = vi.fn(async () => undefined);
    app.setNotice = vi.fn();

    await app.openSessionPicker();
    app.cycleSessionPicker(1);
    await expect(app.selectSessionPickerEntry()).resolves.toBeUndefined();

    expect(openSession).toHaveBeenCalledWith("session-b");
    expect(app.switchThread).not.toHaveBeenCalled();
    expect(listAgentSessions).toHaveBeenCalledTimes(2);
    expect(app.sessionPicker.active).toBe(true);
    expect(app.sessionPicker.sessions).toEqual(refreshedSessions);
    expect(app.sessionPicker.selected).toBe(0);
    expect(app.setNotice).toHaveBeenCalledWith(
      "Session session-b is no longer available. Refreshed the list.",
      "error",
    );
  });
});

describe("ChatApp compact command", () => {
  it("calls the runtime compact operation and records the result locally", async () => {
    const compactThread = vi.fn(async () => ({
      compacted: true,
      tokensBefore: 1_200,
      tokensAfter: 400,
    }));
    const app = new ChatApp() as any;

    app.currentThreadId = "thread-compact";
    app.currentThread = {
      id: "thread-compact",
      agentKey: "panda",
      model: "openai/gpt-5.1",
      createdAt: 1,
      updatedAt: 2,
    };
    app.services = {
      compactThread,
      store: {
        loadTranscript: vi.fn(async () => []),
        getThread: vi.fn(async () => app.currentThread),
        listRuns: vi.fn(async () => []),
      },
    } as ChatRuntimeServices;

    await expect(app.handleCommand("/compact")).resolves.toBe(true);

    expect(compactThread).toHaveBeenCalledWith("thread-compact", "");
    expect(app.transcript.at(-1)).toMatchObject({
      role: "meta",
      title: "compact",
      body: expect.stringContaining("Compacted older context"),
    });
  });

  it("surfaces compaction failures", async () => {
    const compactThread = vi.fn(async () => {
      throw new Error("summary too large");
    });
    const app = new ChatApp() as any;

    app.currentThreadId = "thread-compact";
    app.currentThread = {
      id: "thread-compact",
      agentKey: "panda",
      model: "openai/gpt-5.1",
      createdAt: 1,
      updatedAt: 2,
    };
    app.services = {
      compactThread,
    } as ChatRuntimeServices;

    await expect(app.handleCommand("/compact")).resolves.toBe(true);

    expect(app.transcript.at(-1)).toMatchObject({
      role: "error",
      title: "compact",
      body: "summary too large",
    });
  });
});

describe("thread usage snapshots", () => {
  it("separates stored transcript bloat from the current model-visible context", () => {
    const compactBoundary = createCompactBoundaryMessage("Intent:\n- keep going");
    const thread = {
      id: "thread-usage",
      identityId: "test-user",
      agentKey: "panda",
      model: "anthropic/claude-opus-4-6",
      thinking: "high" as const,
      createdAt: 1,
      updatedAt: 2,
    };
    const transcript = [
      {
        id: "message-1",
        threadId: "thread-usage",
        sequence: 1,
        origin: "input" as const,
        source: "tui",
        message: stringToUserMessage("old request"),
        createdAt: 1,
      },
      {
        id: "message-2",
        threadId: "thread-usage",
        sequence: 2,
        origin: "runtime" as const,
        source: "tool:browser",
        message: imageToolResult(),
        createdAt: 2,
      },
      {
        id: "message-3",
        threadId: "thread-usage",
        sequence: 3,
        origin: "runtime" as const,
        source: "assistant",
        message: assistantWithUsage("old reply"),
        createdAt: 3,
      },
      {
        id: "message-4",
        threadId: "thread-usage",
        sequence: 4,
        origin: "runtime" as const,
        source: "compact",
        message: compactBoundary,
        metadata: {
          kind: "compact_boundary",
          compactedUpToSequence: 3,
          preservedTailUserTurns: 2,
          trigger: "manual",
          tokensBefore: 1_200,
          tokensAfter: 400,
        },
        createdAt: 4,
      },
      {
        id: "message-5",
        threadId: "thread-usage",
        sequence: 5,
        origin: "input" as const,
        source: "tui",
        message: stringToUserMessage("recent request"),
        createdAt: 5,
      },
      {
        id: "message-6",
        threadId: "thread-usage",
        sequence: 6,
        origin: "runtime" as const,
        source: "assistant",
        message: assistantWithUsage("recent reply", {
          usage: {
            input: 4,
            output: 21,
            cacheRead: 80,
            cacheWrite: 90,
            totalTokens: 195,
            cost: {
              input: 0.001,
              output: 0.005,
              cacheRead: 0.002,
              cacheWrite: 0.003,
              total: 0.011,
            },
          },
        }),
        createdAt: 6,
      },
    ];

    const snapshot = collectThreadUsageSnapshot({
      thread,
      transcript,
      model: thread.model,
      thinking: thread.thinking,
      isRunning: false,
      now: 10,
    });
    const formatted = formatThreadUsageSnapshot(snapshot);

    expect(snapshot.storedMessages).toBe(6);
    expect(snapshot.runMessages).toBe(3);
    expect(snapshot.visibleMessages).toBe(3);
    expect(snapshot.storedImages.count).toBe(1);
    expect(snapshot.visibleImages.count).toBe(0);
    expect(snapshot.totalUsage.responses).toBe(2);
    expect(snapshot.totalUsage.totalTokens).toBe(540);
    expect(snapshot.latestCompaction).toMatchObject({
      trigger: "manual",
      tokensBefore: 1_200,
      tokensAfter: 400,
    });
    expect(formatted).toContain("## Context");
    expect(formatted).toContain("**Stored thread:** 6 msgs");
    expect(formatted).toContain("**Inline images:** stored 1");
    expect(formatted).toContain("**Last compaction:** manual");
    expect(formatted).toContain("**Thread total:** 2 responses");
  });
});

describe("ChatApp usage command", () => {
  it("shows a usage snapshot for the current thread", async () => {
    const thread = {
      id: "thread-usage",
      identityId: "test-user",
      agentKey: "panda",
      model: "anthropic/claude-opus-4-6",
      thinking: "high" as const,
      createdAt: 1,
      updatedAt: 2,
    };
    const getThread = vi.fn(async () => thread);
    const loadTranscript = vi.fn(async () => [
      {
        id: "message-1",
        threadId: "thread-usage",
        sequence: 1,
        origin: "input" as const,
        source: "tui",
        message: stringToUserMessage("hello"),
        createdAt: 1,
      },
      {
        id: "message-2",
        threadId: "thread-usage",
        sequence: 2,
        origin: "runtime" as const,
        source: "assistant",
        message: assistantWithUsage("hi"),
        createdAt: 2,
      },
    ]);
    const app = new ChatApp() as any;

    app.currentThreadId = "thread-usage";
    app.currentThread = thread;
    app.model = thread.model;
    app.thinking = thread.thinking;
    app.services = {
      getThread,
      store: {
        loadTranscript,
      },
    } as ChatRuntimeServices;

    await expect(app.handleCommand("/usage")).resolves.toBe(true);
    expect(getThread).toHaveBeenCalledWith("thread-usage");
    expect(loadTranscript).toHaveBeenCalledWith("thread-usage");
    expect(app.transcript.at(-1)).toMatchObject({
      role: "meta",
      title: "usage",
      body: expect.stringContaining("## Provider Usage"),
    });
  });
});

describe("ChatApp performance helpers", () => {
  it("reuses cached transcript lines for unchanged assistant entries", () => {
    const renderMarkdownLines = vi.spyOn(markdown, "renderMarkdownLines");
    const app = new ChatApp() as any;

    app.transcript.push({
      id: 1,
      role: "assistant",
      title: "agent",
      body: "**hello**",
    });
    app.nextEntryId = 2;

    app.buildView();
    app.buildView();
    expect(renderMarkdownLines).toHaveBeenCalledTimes(1);

    app.transcript[0].body = "**updated**";
    app.buildView();
    expect(renderMarkdownLines).toHaveBeenCalledTimes(2);

    renderMarkdownLines.mockRestore();
  });

  it("renders usage meta entries through the markdown renderer", () => {
    const renderMarkdownLines = vi.spyOn(markdown, "renderMarkdownLines");
    const app = new ChatApp() as any;

    app.transcript.push({
      id: 1,
      role: "meta",
      title: "usage",
      body: "## Context\n- **Visible now:** 26 msgs",
    });
    app.transcript.push({
      id: 2,
      role: "meta",
      title: "session",
      body: "Opened session session-123.",
    });
    app.nextEntryId = 3;

    const view = app.buildView();

    expect(renderMarkdownLines).toHaveBeenCalledTimes(1);
    expect(view.transcriptLines.some((line: { plain: string }) => line.plain.includes("**Visible now:**"))).toBe(false);

    renderMarkdownLines.mockRestore();
  });

  it("batches transcript changes when appending stored messages", () => {
    const app = new ChatApp() as any;
    const markDirty = vi.spyOn(app, "markDirty");

    app.appendStoredMessages([
      {
        id: "message-1",
        threadId: "thread-batch",
        sequence: 1,
        origin: "input",
        message: stringToUserMessage("hello"),
        source: "tui",
        createdAt: 1,
      },
      {
        id: "message-2",
        threadId: "thread-batch",
        sequence: 2,
        origin: "input",
        message: stringToUserMessage("second"),
        source: "tui",
        createdAt: 2,
      },
    ]);

    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(app.transcript).toHaveLength(2);
  });

  it("loads thread, transcript, and runs during a forced sync", async () => {
    const getThread = vi.fn(async () => ({
      id: "thread-sync",
      agentKey: "panda",
      model: "openai/gpt-5.1",
      createdAt: 1,
      updatedAt: 2,
    }));
    const loadTranscript = vi.fn(async () => []);
    const listRuns = vi.fn(async () => []);
    const app = new ChatApp() as any;

    app.currentThreadId = "thread-sync";
    app.services = {
      extraTools: [],
      store: {
        getThread,
        loadTranscript,
        listRuns,
      },
    } as ChatRuntimeServices;

    await app.syncStoredThreadState(true);

    expect(getThread).toHaveBeenCalledWith("thread-sync");
    expect(loadTranscript).toHaveBeenCalledWith("thread-sync");
    expect(listRuns).toHaveBeenCalledWith("thread-sync");
  });

  it("debounces scheduled syncs into a single stored refresh", async () => {
    vi.useFakeTimers();

    try {
      const getThread = vi.fn(async () => ({
        id: "thread-sync",
        agentKey: "panda",
        model: "openai/gpt-5.1",
        createdAt: 1,
        updatedAt: 2,
      }));
      const loadTranscript = vi.fn(async () => []);
      const listRuns = vi.fn(async () => []);
      const app = new ChatApp() as any;

      app.currentThreadId = "thread-sync";
      app.services = {
        extraTools: [],
        store: {
          getThread,
          loadTranscript,
          listRuns,
        },
      } as ChatRuntimeServices;

      app.scheduleSyncStoredThreadState();
      app.scheduleSyncStoredThreadState();

      await vi.advanceTimersByTimeAsync(149);
      expect(loadTranscript).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(loadTranscript).toHaveBeenCalledTimes(1);
      expect(getThread).toHaveBeenCalledTimes(1);
      expect(listRuns).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues follow-up sync work instead of running concurrent syncs", async () => {
    let resolveTranscript: (() => void) | null = null;
    const firstTranscript = new Promise<[]>(resolve => {
      resolveTranscript = () => resolve([]);
    });
    const loadTranscript = vi.fn(async () => {
      if (loadTranscript.mock.calls.length === 1) {
        return firstTranscript;
      }

      return [];
    });
    const getThread = vi.fn(async () => ({
      id: "thread-sync",
      agentKey: "panda",
      model: "openai/gpt-5.1",
      createdAt: 1,
      updatedAt: 2,
    }));
    const listRuns = vi.fn(async () => []);
    const app = new ChatApp() as any;

    app.currentThreadId = "thread-sync";
    app.services = {
      extraTools: [],
      store: {
        getThread,
        loadTranscript,
        listRuns,
      },
    } as ChatRuntimeServices;

    const first = app.syncStoredThreadState(true);

    await Promise.resolve();

    await app.syncStoredThreadState(true);

    expect(loadTranscript).toHaveBeenCalledTimes(1);
    expect(getThread).toHaveBeenCalledTimes(1);
    expect(listRuns).toHaveBeenCalledTimes(1);

    resolveTranscript?.();
    await first;
    await flushTimers();

    expect(loadTranscript).toHaveBeenCalledTimes(2);
    expect(getThread).toHaveBeenCalledTimes(2);
    expect(listRuns).toHaveBeenCalledTimes(2);
  });
});

describe("buildChatHelpText", () => {
  it("documents reliable newline fallbacks", () => {
    const helpText = buildChatHelpText("/thinking <low|medium|high|xhigh|off>");

    expect(helpText).toContain("/thread shows the current session and thread ids plus active settings.");
    expect(helpText).toContain("/usage shows current context estimates, provider token usage, and cost.");
    expect(helpText).not.toContain("/thread shows the current thread id and storage mode.");
    expect(helpText).toContain("\\ + Enter inserts a newline.");
    expect(helpText).toContain("Shift-Enter or Meta-Enter also inserts a newline when your terminal exposes it.");
    expect(helpText).not.toContain("Ctrl-J inserts a newline.");
  });
});

describe("buildWelcomeTranscriptLines", () => {
  it("keeps the welcome key hints aligned with the composer policy", () => {
    const welcome = buildWelcomeTranscriptLines({
      width: 120,
      model: "openai/gpt-5.1",
      thinkingLabel: "off",
      cwd: "/tmp/panda",
    });
    const text = welcome.map((line) => line.plain).join("\n");

    expect(text).toContain("\\ + Enter insert a newline");
    expect(text).toContain("Shift-Enter insert a newline when supported");
    expect(text).not.toContain("Ctrl-J");
  });
});

describe("buildChatViewModel", () => {
  it("shows the active agent and identity in the header", () => {
    const view = buildChatViewModel({
      terminalWidth: 120,
      terminalRows: 30,
      transcriptLines: [],
      transcriptSearchActive: false,
      transcriptSearchQuery: "",
      transcriptSearchSelection: 0,
      sessionPickerActive: false,
      historySearchActive: false,
      historySearchQuery: "",
      historySearchSelection: 0,
      historyMatchCount: 0,
      historyPreview: null,
      notice: null,
      slashContext: null,
      slashCompletionIndex: 0,
      followTranscript: true,
      scrollTop: 0,
      pendingLocalInputLines: [],
      composerLayout: {
        lines: [""],
        cursorRow: 0,
        cursorColumn: 1,
      },
      isRunning: false,
      runStartedAt: 0,
      agentLabel: "Panda",
      identityHandle: "alice",
      currentSessionId: "session-test",
      currentThreadId: "thread-test",
      model: "openai/gpt-5.1",
      thinkingLabel: "off",
      modeLabel: "compose",
      cwd: "/tmp/panda",
    });

    expect(stripAnsi(view.headerLine)).toBe("Panda · @alice · cwd /tmp/panda");
  });

  it("shows the shared newline hint in the footer", () => {
    const view = buildChatViewModel({
      terminalWidth: 120,
      terminalRows: 30,
      transcriptLines: [],
      transcriptSearchActive: false,
      transcriptSearchQuery: "",
      transcriptSearchSelection: 0,
      sessionPickerActive: false,
      historySearchActive: false,
      historySearchQuery: "",
      historySearchSelection: 0,
      historyMatchCount: 0,
      historyPreview: null,
      notice: null,
      slashContext: null,
      slashCompletionIndex: 0,
      followTranscript: true,
      scrollTop: 0,
      pendingLocalInputLines: [],
      composerLayout: {
        lines: [""],
        cursorRow: 0,
        cursorColumn: 1,
      },
      isRunning: false,
      runStartedAt: 0,
      agentLabel: "Panda",
      identityHandle: "alice",
      currentSessionId: "session-test",
      currentThreadId: "thread-test",
      model: "openai/gpt-5.1",
      thinkingLabel: "off",
      modeLabel: "compose",
      cwd: "/tmp/panda",
    });

    expect(stripAnsi(view.infoLine.text)).toContain("\\ + Enter newline");
    expect(stripAnsi(view.infoLine.text)).not.toContain("Ctrl-J");
  });
});

describe("ChatApp agent header", () => {
  it("uses the session agent key in the header when switching threads", async () => {
    const app = new ChatApp() as any;

    app.services = {
      identity: {
        id: "alice-id",
        handle: "alice",
        displayName: "Alice",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
    } as ChatRuntimeServices;
    app.refreshToolCatalog = vi.fn();
    app.reloadVisibleTranscript = vi.fn(async () => {});
    app.syncStoredThreadState = vi.fn(async () => {});

    await app.switchThread({
      id: "thread-panda",
      sessionId: "session-panda",
      context: {
        cwd: "/tmp/panda",
        agentKey: "panda",
        sessionId: "session-panda",
        identityId: "alice-id",
      },
      createdAt: 1,
      updatedAt: 1,
    });
    expect(stripAnsi(app.buildView().headerLine)).toContain("panda · @alice · cwd /tmp/panda");

    await app.switchThread({
      id: "thread-ops",
      sessionId: "session-ops",
      context: {
        cwd: "/tmp/ops",
        agentKey: "ops",
        sessionId: "session-ops",
        identityId: "alice-id",
      },
      createdAt: 1,
      updatedAt: 1,
    });
    expect(stripAnsi(app.buildView().headerLine)).toContain("ops · @alice · cwd /tmp/ops");
  });
});

describe("runChatCli", () => {
  it("returns the final session and thread ids from the chat app", async () => {
    const run = vi.spyOn(ChatApp.prototype, "run").mockResolvedValue({
      sessionId: "session-exit-result",
      threadId: "thread-exit-result",
    });

    await expect(runChatCli()).resolves.toEqual({
      sessionId: "session-exit-result",
      threadId: "thread-exit-result",
    });

    run.mockRestore();
  });
});

describe("ChatApp explicit session id", () => {
  it("preserves access errors instead of trying to create a branch session", async () => {
    const createChatRuntime = vi.spyOn(tuiRuntime, "createChatRuntime").mockResolvedValue({
      identity: {
        id: "alice-id",
        handle: "alice",
        displayName: "Alice",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
      recoverOrphanedRuns: vi.fn(async () => []),
      openSession: vi.fn(async () => {
        throw new Error("Session session-locked does not belong to identity alice.");
      }),
      createBranchSession: vi.fn(async () => {
        throw new Error("should not create");
      }),
    } as unknown as ChatRuntimeServices);

    const app = new ChatApp({ session: "session-locked" }) as any;
    app.switchThread = vi.fn(async () => {});

    await expect(app.initializeRuntime()).rejects.toThrow("Session session-locked does not belong to identity alice.");
    expect(app.services.createBranchSession).not.toHaveBeenCalled();

    createChatRuntime.mockRestore();
  });
});
