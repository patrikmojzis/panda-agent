import {afterEach, describe, expect, it, vi} from "vitest";

import {stringToUserMessage} from "../src/kernel/agent/index.js";
import type {SessionRecord} from "../src/domain/sessions/index.js";
import type {ThreadMessageRecord, ThreadRecord, ThreadRunRecord,} from "../src/domain/threads/runtime/index.js";
import {ObserveApp, type ObserveServices,} from "../src/ui/observe/app.js";

interface TestOutput {
  buffer: string;
  columns?: number;
  isTTY?: boolean;
  write(chunk: string): boolean;
}

function createOutput(overrides: Partial<Pick<TestOutput, "columns" | "isTTY">> = {}): TestOutput {
  return {
    buffer: "",
    columns: overrides.columns ?? 100,
    isTTY: overrides.isTTY ?? true,
    write(chunk: string) {
      this.buffer += chunk;
      return true;
    },
  };
}

function createSession(
  sessionId: string,
  currentThreadId: string,
  kind: SessionRecord["kind"] = "main",
): SessionRecord {
  return {
    id: sessionId,
    agentKey: "panda",
    kind,
    currentThreadId,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createThread(threadId: string, sessionId = "session-1"): ThreadRecord {
  return {
    id: threadId,
    sessionId,
    context: {
      agentKey: "panda",
      cwd: "/workspace/panda-agent",
    },
    model: "openai/gpt-5.4",
    createdAt: 1,
    updatedAt: 2,
  };
}

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{type: "text" as const, text}],
    api: "openai-responses" as const,
    provider: "openai" as const,
    model: "openai/gpt-5.4" as const,
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function createMessageRecord(input: {
  id: string;
  threadId: string;
  sequence: number;
  text: string;
  role?: "assistant" | "user";
}): ThreadMessageRecord {
  return {
    id: input.id,
    threadId: input.threadId,
    sequence: input.sequence,
    origin: "runtime",
    message: input.role === "user"
      ? stringToUserMessage(input.text)
      : assistantMessage(input.text),
    source: input.role === "user" ? "tui" : "assistant",
    createdAt: input.sequence,
  };
}

function createServices(input: {
  getMainSession?: () => Promise<SessionRecord | null>;
  getSession?: () => Promise<SessionRecord>;
  getThread: (threadId: string) => Promise<ThreadRecord>;
  loadTranscript: (threadId: string) => Promise<readonly ThreadMessageRecord[]>;
  listRuns?: (threadId: string) => Promise<readonly ThreadRunRecord[]>;
}): ObserveServices {
  return {
    sessionStore: {
      getMainSession: input.getMainSession ?? (async () => null),
      getSession: input.getSession ?? (async () => createSession("session-1", "thread-1")),
    },
    store: {
      getThread: input.getThread,
      loadTranscript: input.loadTranscript,
      listRuns: input.listRuns ?? (async () => []),
    },
    subscribe: async () => async () => {},
    close: async () => {},
  };
}

describe("ObserveApp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves an agent target through the main session", async () => {
    const output = createOutput();
    const getMainSession = vi.fn(async () => createSession("session-main", "thread-main"));
    const app = new ObserveApp({
      target: {kind: "agent", agentKey: "panda"},
      once: true,
    }, {
      createServices: async () => createServices({
        getMainSession,
        getThread: async (threadId) => createThread(threadId, "session-main"),
        loadTranscript: async () => [],
      }),
      output,
    });

    await app.run();

    expect(getMainSession).toHaveBeenCalledWith("panda");
    expect(output.buffer).toContain("agent panda");
    expect(output.buffer).toContain("session-main");
    expect(output.buffer).toContain("thread-main");
  });

  it("follows a session onto a new current thread after reset", async () => {
    const output = createOutput();
    let currentThreadId = "thread-a";
    const transcriptByThread = new Map<string, readonly ThreadMessageRecord[]>([
      ["thread-a", [createMessageRecord({id: "message-a", threadId: "thread-a", sequence: 1, text: "before reset"})]],
      ["thread-b", [createMessageRecord({id: "message-b", threadId: "thread-b", sequence: 1, text: "after reset"})]],
    ]);
    const app = new ObserveApp({
      target: {kind: "session", sessionId: "session-1"},
    }, {
      output,
    }) as ObserveApp & { services: ObserveServices | null; currentThread: ThreadRecord | null };

    app.services = createServices({
      getSession: async () => createSession("session-1", currentThreadId),
      getThread: async (threadId) => createThread(threadId, "session-1"),
      loadTranscript: async (threadId) => transcriptByThread.get(threadId) ?? [],
    });

    await app.syncStoredState(true);
    currentThreadId = "thread-b";
    await app.syncStoredState(true);

    expect(app.currentThread?.id).toBe("thread-b");
    expect(output.buffer).toContain("switched from thread thread-a to thread-b");
    expect(output.buffer).toContain("after reset");
  });

  it("keeps a thread target pinned when another thread changes", async () => {
    const output = createOutput();
    const loadTranscript = vi.fn(async () => [
      createMessageRecord({id: "message-a", threadId: "thread-a", sequence: 1, text: "pinned"}),
    ]);
    const app = new ObserveApp({
      target: {kind: "thread", threadId: "thread-a"},
    }, {
      output,
    }) as ObserveApp & { services: ObserveServices | null };

    app.services = createServices({
      getThread: async (threadId) => createThread(threadId, "session-1"),
      loadTranscript,
    });

    await app.syncStoredState(true);
    await app.handleStoreNotification("thread-b");

    expect(loadTranscript).toHaveBeenCalledTimes(1);
  });

  it("prints only the last N stored messages on the initial snapshot", async () => {
    const output = createOutput();
    const app = new ObserveApp({
      target: {kind: "thread", threadId: "thread-1"},
      tail: 2,
    }, {
      output,
    }) as ObserveApp & { services: ObserveServices | null };

    app.services = createServices({
      getThread: async (threadId) => createThread(threadId),
      loadTranscript: async () => [
        createMessageRecord({id: "message-1", threadId: "thread-1", sequence: 1, text: "oldest"}),
        createMessageRecord({id: "message-2", threadId: "thread-1", sequence: 2, text: "middle"}),
        createMessageRecord({id: "message-3", threadId: "thread-1", sequence: 3, text: "latest"}),
      ],
    });

    await app.syncStoredState(true);

    expect(output.buffer).not.toContain("oldest");
    expect(output.buffer).toContain("middle");
    expect(output.buffer).toContain("latest");
    expect(output.buffer).toContain("last 2 stored messages on initial snapshot");
  });

  it("prints only new transcript entries after the initial snapshot", async () => {
    const output = createOutput();
    let transcript: readonly ThreadMessageRecord[] = [
      createMessageRecord({id: "message-1", threadId: "thread-1", sequence: 1, text: "first"}),
    ];
    const app = new ObserveApp({
      target: {kind: "thread", threadId: "thread-1"},
    }, {
      output,
    }) as ObserveApp & { services: ObserveServices | null };

    app.services = createServices({
      getThread: async (threadId) => createThread(threadId),
      loadTranscript: async () => transcript,
    });

    await app.syncStoredState(true);
    transcript = [
      ...transcript,
      createMessageRecord({id: "message-2", threadId: "thread-1", sequence: 2, text: "second"}),
    ];
    await app.syncStoredState(true);

    expect(output.buffer.split("first").length - 1).toBe(1);
    expect(output.buffer.split("second").length - 1).toBe(1);
  });

  it("debounces follow-up refreshes into one sync", async () => {
    vi.useFakeTimers();

    const output = createOutput();
    const loadTranscript = vi.fn(async () => []);
    const app = new ObserveApp({
      target: {kind: "session", sessionId: "session-1"},
    }, {
      output,
    }) as ObserveApp & { services: ObserveServices | null };

    app.services = createServices({
      getSession: async () => createSession("session-1", "thread-1"),
      getThread: async (threadId) => createThread(threadId),
      loadTranscript,
    });

    await app.handleStoreNotification("thread-1");
    await app.handleStoreNotification("thread-2");

    await vi.advanceTimersByTimeAsync(149);
    expect(loadTranscript).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(loadTranscript).toHaveBeenCalledTimes(1);
  });

  it("prints failed run transitions and the error text", async () => {
    const output = createOutput();
    let runs: readonly ThreadRunRecord[] = [];
    const app = new ObserveApp({
      target: {kind: "thread", threadId: "thread-1"},
    }, {
      output,
    }) as ObserveApp & { services: ObserveServices | null };

    app.services = createServices({
      getThread: async (threadId) => createThread(threadId),
      loadTranscript: async () => [],
      listRuns: async () => runs,
    });

    await app.syncStoredState(true);
    runs = [{
      id: "run-1",
      threadId: "thread-1",
      status: "failed",
      startedAt: 1,
      finishedAt: 2,
      error: "Boom.",
    }];
    await app.syncStoredState(true);

    expect(output.buffer).toContain("run run-1 failed");
    expect(output.buffer).toContain("Boom.");
  });

  it("strips ansi formatting when stdout is not a TTY", async () => {
    const output = createOutput({isTTY: false});
    const app = new ObserveApp({
      target: {kind: "thread", threadId: "thread-1"},
      once: true,
    }, {
      createServices: async () => createServices({
        getThread: async (threadId) => createThread(threadId),
        loadTranscript: async () => [
          createMessageRecord({id: "message-1", threadId: "thread-1", sequence: 1, text: "plain"}),
        ],
      }),
      output,
    });

    await app.run();

    expect(output.buffer).toContain("plain");
    expect(output.buffer).not.toContain("\u001b[");
  });
});
