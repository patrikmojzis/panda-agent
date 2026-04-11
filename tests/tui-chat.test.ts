import {describe, expect, it, vi} from "vitest";

import {stringToUserMessage} from "../src/kernel/agent/index.js";
import type {ThreadRunRecord} from "../src/domain/threads/runtime/index.js";
import * as markdown from "../src/ui/tui/markdown.js";
import {buildChatHelpText} from "../src/ui/tui/chat-commands.js";
import {buildChatViewModel, buildWelcomeTranscriptLines} from "../src/ui/tui/chat-view.js";
import type {ChatRuntimeServices} from "../src/ui/tui/runtime.js";
import * as tuiRuntime from "../src/ui/tui/runtime.js";
import {stripAnsi} from "../src/ui/tui/theme.js";
import {createComposerState, setComposerValue} from "../src/ui/tui/composer.js";
import {PandaChatApp, runChatCli} from "../src/ui/tui/chat.js";

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

describe("PandaChatApp Ctrl-C handling", () => {
  it("aborts once and closes after the active run settles", async () => {
    const abortThread = vi.fn(async () => true);
    const waitForCurrentRun = vi.fn(async () => {});
    const app = new PandaChatApp() as unknown as AppHarness;

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
    const app = new PandaChatApp() as unknown as AppHarness;

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

describe("PandaChatApp bracketed paste", () => {
  it("keeps pasted returns inside the composer until paste ends", async () => {
    const app = new PandaChatApp() as any;
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

describe("PandaChatApp Shift+Enter", () => {
  it("turns backslash-enter into a newline without sending", async () => {
    const app = new PandaChatApp() as any;
    const submitComposer = vi.spyOn(app, "submitComposer").mockResolvedValue(undefined);

    app.render = vi.fn();
    app.composer = createComposerState("alpha\\");

    await app.handleKeypress("\r", { name: "return" });

    expect(submitComposer).not.toHaveBeenCalled();
    expect(app.composer.value).toBe("alpha\n");
    expect(app.composer.cursor).toBe("alpha\n".length);
  });

  it("inserts a newline when shift is held on return", async () => {
    const app = new PandaChatApp() as any;
    const submitComposer = vi.spyOn(app, "submitComposer").mockResolvedValue(undefined);

    app.render = vi.fn();
    app.composer = createComposerState("alpha");

    await app.handleKeypress("", { shift: true, name: "return" });

    expect(submitComposer).not.toHaveBeenCalled();
    expect(app.composer.value).toBe("alpha\n");
  });

  it("inserts a newline for meta-enter terminal keybindings", async () => {
    const app = new PandaChatApp() as any;
    const submitComposer = vi.spyOn(app, "submitComposer").mockResolvedValue(undefined);

    app.render = vi.fn();
    app.composer = createComposerState("alpha");

    await app.handleKeypress("\u001b\r", { meta: true, name: "return", sequence: "\u001b\r" });
    await app.handleKeypress("\u001b\n", { meta: true, name: "enter", sequence: "\u001b\n" });

    expect(submitComposer).not.toHaveBeenCalled();
    expect(app.composer.value).toBe("alpha\n\n");
  });

  it("inserts a newline for kitty and modifyOtherKeys Shift+Enter sequences", async () => {
    const app = new PandaChatApp() as any;
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

describe("PandaChatApp composer word shortcuts", () => {
  it("supports meta-left and meta-b for moving backward by word", async () => {
    const app = new PandaChatApp() as any;
    app.render = vi.fn();

    const value = "alpha beta gamma";
    app.composer = createComposerState(value);

    await app.handleKeypress("", { meta: true, name: "left" });
    expect(app.composer.cursor).toBe("alpha beta ".length);

    await app.handleKeypress("\u001bb", { name: "b" });
    expect(app.composer.cursor).toBe("alpha ".length);
  });

  it("supports raw alt-arrow sequences and meta-f/right for moving forward by word", async () => {
    const app = new PandaChatApp() as any;
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
    const app = new PandaChatApp() as any;
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

describe("PandaChatApp thinking command", () => {
  it("updates and clears thinking on the current thread", async () => {
    const updateThread = vi.fn(async (_threadId: string, update: { thinking?: "high" | null }) => ({
      id: "thread-thinking",
      agentKey: "panda",
      model: "openai/gpt-5.1",
      thinking: update.thinking ?? undefined,
      createdAt: 1,
      updatedAt: 2,
    }));
    const app = new PandaChatApp() as any;

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
    const app = new PandaChatApp() as any;

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

describe("PandaChatApp fresh-thread agent selection", () => {
  it("does not inherit the current thread agent for /new when no explicit chat agent is set", async () => {
    const createThread = vi.fn(async () => ({
      id: "thread-new",
      identityId: "local",
      agentKey: "jozef",
      model: "openai/gpt-5.1",
      context: {},
      createdAt: 1,
      updatedAt: 2,
    }));
    const app = new PandaChatApp() as any;
    const expectedModel = app.model;

    app.currentThreadId = "thread-current";
    app.currentThread = {
      id: "thread-current",
      identityId: "local",
      agentKey: "panda",
      model: "openai/gpt-5.1",
      context: {},
      createdAt: 1,
      updatedAt: 1,
    };
    app.services = {
      createThread,
    } as ChatRuntimeServices;
    app.switchThread = vi.fn(async (thread) => {
      app.currentThread = thread;
      app.currentThreadId = thread.id;
    });
    app.pushEntry = vi.fn();
    app.setNotice = vi.fn();

    await expect(app.handleCommand("/new")).resolves.toBe(true);

    expect(createThread).toHaveBeenCalledWith({
      id: undefined,
      agentKey: undefined,
      model: expectedModel,
      thinking: undefined,
    });
  });

  it("does not inherit the current thread agent for /reset when no explicit chat agent is set", async () => {
    const resetHomeThread = vi.fn(async () => ({
      id: "thread-reset",
      identityId: "local",
      agentKey: "jozef",
      model: "openai/gpt-5.1",
      context: {},
      createdAt: 1,
      updatedAt: 2,
    }));
    const app = new PandaChatApp() as any;
    const expectedModel = app.model;

    app.currentThreadId = "thread-current";
    app.currentThread = {
      id: "thread-current",
      identityId: "local",
      agentKey: "panda",
      model: "openai/gpt-5.1",
      context: {},
      createdAt: 1,
      updatedAt: 1,
    };
    app.services = {
      resetHomeThread,
    } as ChatRuntimeServices;
    app.switchThread = vi.fn(async (thread) => {
      app.currentThread = thread;
      app.currentThreadId = thread.id;
    });
    app.pushEntry = vi.fn();
    app.setNotice = vi.fn();

    await expect(app.handleCommand("/reset")).resolves.toBe(true);

    expect(resetHomeThread).toHaveBeenCalledWith({
      agentKey: undefined,
      model: expectedModel,
      thinking: undefined,
    });
  });
});

describe("PandaChatApp history search", () => {
  it("filters history matches and loads the selected prompt into the composer", async () => {
    const app = new PandaChatApp() as any;
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

describe("PandaChatApp thread picker", () => {
  it("preselects the current thread and resumes the chosen entry", async () => {
    const summaries = [
      {
        thread: {
          id: "thread-a",
          identityId: "local",
          agentKey: "panda",
          model: "openai/gpt-5.1",
          context: {},
          createdAt: 1,
          updatedAt: 1,
        },
        messageCount: 1,
        pendingInputCount: 0,
      },
      {
        thread: {
          id: "thread-b",
          identityId: "local",
          agentKey: "panda",
          model: "openai/gpt-5.1",
          context: {},
          createdAt: 2,
          updatedAt: 2,
        },
        messageCount: 2,
        pendingInputCount: 0,
      },
      {
        thread: {
          id: "thread-c",
          identityId: "local",
          agentKey: "ops",
          model: "openai/gpt-5.1",
          context: {},
          createdAt: 3,
          updatedAt: 3,
        },
        messageCount: 3,
        pendingInputCount: 0,
      },
    ];
    const listThreadSummaries = vi.fn(async () => summaries);
    const app = new PandaChatApp() as any;

    app.currentThreadId = "thread-b";
    app.currentThread = summaries[1]?.thread;
    app.render = vi.fn();
    app.services = {
      listThreadSummaries,
    } as ChatRuntimeServices;
    app.switchThread = vi.fn(async (thread) => {
      app.currentThread = thread;
      app.currentThreadId = thread.id;
    });
    app.setNotice = vi.fn();

    await app.openThreadPicker();

    expect(listThreadSummaries).toHaveBeenCalledWith(16);
    expect(app.threadPicker.active).toBe(true);
    expect(app.threadPicker.selected).toBe(1);

    app.cycleThreadPicker(1);
    await app.selectThreadPickerEntry();

    expect(app.switchThread).toHaveBeenCalledWith(summaries[2]?.thread);
    expect(app.threadPicker.active).toBe(false);
    expect(app.setNotice).toHaveBeenCalledWith("Resumed thread thread-c.", "info");
  });
});

describe("PandaChatApp compact command", () => {
  it("calls the runtime compact operation and records the result locally", async () => {
    const compactThread = vi.fn(async () => ({
      compacted: true,
      tokensBefore: 1_200,
      tokensAfter: 400,
    }));
    const app = new PandaChatApp() as any;

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
    const app = new PandaChatApp() as any;

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

describe("PandaChatApp performance helpers", () => {
  it("reuses cached transcript lines for unchanged assistant entries", () => {
    const renderMarkdownLines = vi.spyOn(markdown, "renderMarkdownLines");
    const app = new PandaChatApp() as any;

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

  it("batches transcript changes when appending stored messages", () => {
    const app = new PandaChatApp() as any;
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
    const app = new PandaChatApp() as any;

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
      const app = new PandaChatApp() as any;

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
    const app = new PandaChatApp() as any;

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
    const helpText = buildChatHelpText("/thinking <minimal|low|medium|high|xhigh|off>");

    expect(helpText).toContain("/thread shows the current thread id and active session settings.");
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
      threadPickerActive: false,
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
      threadPickerActive: false,
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

describe("PandaChatApp agent header", () => {
  it("updates the header when switching to a thread with a different agent", async () => {
    const app = new PandaChatApp() as any;

    app.services = {
      identity: {
        id: "alice-id",
        handle: "alice",
        displayName: "Alice",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
      getAgent: vi.fn(async (agentKey: string) => ({
        agentKey,
        displayName: agentKey === "panda" ? "Panda" : "Ops",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      })),
    } as ChatRuntimeServices;
    app.refreshToolCatalog = vi.fn();
    app.reloadVisibleTranscript = vi.fn(async () => {});
    app.syncStoredThreadState = vi.fn(async () => {});

    await app.switchThread({
      id: "thread-panda",
      identityId: "alice-id",
      agentKey: "panda",
      context: {cwd: "/tmp/panda"},
      createdAt: 1,
      updatedAt: 1,
    });
    expect(stripAnsi(app.buildView().headerLine)).toContain("Panda · @alice · cwd /tmp/panda");

    await app.switchThread({
      id: "thread-ops",
      identityId: "alice-id",
      agentKey: "ops",
      context: {cwd: "/tmp/ops"},
      createdAt: 1,
      updatedAt: 1,
    });
    expect(stripAnsi(app.buildView().headerLine)).toContain("Ops · @alice · cwd /tmp/ops");
  });

  it("falls back to the agent key when agent lookup fails", async () => {
    const app = new PandaChatApp() as any;

    app.services = {
      identity: {
        id: "alice-id",
        handle: "alice",
        displayName: "Alice",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
      getAgent: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as ChatRuntimeServices;
    app.refreshToolCatalog = vi.fn();
    app.reloadVisibleTranscript = vi.fn(async () => {});
    app.syncStoredThreadState = vi.fn(async () => {});

    await app.switchThread({
      id: "thread-ops",
      identityId: "alice-id",
      agentKey: "ops",
      context: {cwd: "/tmp/ops"},
      createdAt: 1,
      updatedAt: 1,
    });

    expect(stripAnsi(app.buildView().headerLine)).toContain("ops · @alice · cwd /tmp/ops");
  });
});

describe("runChatCli", () => {
  it("returns the final thread id from the chat app", async () => {
    const run = vi.spyOn(PandaChatApp.prototype, "run").mockResolvedValue({
      threadId: "thread-exit-result",
    });

    await expect(runChatCli()).resolves.toEqual({
      threadId: "thread-exit-result",
    });

    run.mockRestore();
  });
});

describe("PandaChatApp explicit thread id", () => {
  it("preserves identity access errors instead of trying to recreate the thread", async () => {
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
      getThread: vi.fn(async () => {
        throw new Error("Thread thread-locked does not belong to identity alice.");
      }),
      createThread: vi.fn(async () => {
        throw new Error("should not create");
      }),
    } as unknown as ChatRuntimeServices);

    const app = new PandaChatApp({ threadId: "thread-locked" }) as any;
    app.switchThread = vi.fn(async () => {});

    await expect(app.initializeRuntime()).rejects.toThrow("Thread thread-locked does not belong to identity alice.");
    expect(app.services.createThread).not.toHaveBeenCalled();

    createChatRuntime.mockRestore();
  });
});
