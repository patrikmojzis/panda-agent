import {afterEach, describe, expect, it, vi} from "vitest";

import {stringToUserMessage} from "../src/kernel/agent/index.js";
import type {SessionRecord, SessionRuntimeConfigRecord} from "../src/domain/sessions/index.js";
import type {ThreadMessageRecord, ThreadRecord, ThreadRunRecord, ThreadToolJobRecord,} from "../src/domain/threads/runtime/index.js";
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

function createRuntimeConfig(sessionId = "session-1"): SessionRuntimeConfigRecord {
  return {
    sessionId,
    model: "openai/gpt-5.4",
    thinkingConfigured: false,
  };
}

function createThread(threadId: string, sessionId = "session-1"): ThreadRecord {
  return {
    id: threadId,
    sessionId,
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

function createCommandJob(input: {
  id: string;
  threadId: string;
  status: ThreadToolJobRecord["status"];
  command: string;
  summary?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}): ThreadToolJobRecord {
  return {
    id: input.id,
    threadId: input.threadId,
    kind: "command",
    status: input.status,
    summary: input.command,
    startedAt: input.startedAt ?? 1,
    finishedAt: input.finishedAt,
    result: input.status === "failed"
      ? {
        command: input.command,
        ok: false,
        code: "command_failed",
      }
      : {
        command: input.command,
        ok: true,
        ...(input.summary ? {summary: input.summary} : {}),
      },
    error: input.error,
  };
}

function createServices(input: {
  getMainSession?: () => Promise<SessionRecord | null>;
  getSession?: () => Promise<SessionRecord>;
  getThread: (threadId: string) => Promise<ThreadRecord>;
  loadTranscript: (threadId: string) => Promise<readonly ThreadMessageRecord[]>;
  listRuns?: (threadId: string) => Promise<readonly ThreadRunRecord[]>;
  listToolJobs?: (threadId: string) => Promise<readonly ThreadToolJobRecord[]>;
  getSessionRuntimeConfig?: (sessionId: string) => Promise<SessionRuntimeConfigRecord>;
}): ObserveServices {
  return {
    sessionStore: {
      getMainSession: input.getMainSession ?? (async () => null),
      getSession: input.getSession ?? (async () => createSession("session-1", "thread-1")),
      getSessionRuntimeConfig: input.getSessionRuntimeConfig ?? (async (sessionId) => createRuntimeConfig(sessionId)),
    },
    store: {
      getThread: input.getThread,
      loadTranscript: input.loadTranscript,
      listRuns: input.listRuns ?? (async () => []),
      listToolJobs: input.listToolJobs ?? (async () => []),
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

  it("interleaves recent command jobs with the initial transcript tail", async () => {
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
        createMessageRecord({id: "message-2", threadId: "thread-1", sequence: 10, text: "middle"}),
        createMessageRecord({id: "message-3", threadId: "thread-1", sequence: 20, text: "latest"}),
      ],
      listToolJobs: async () => [
        createCommandJob({
          id: "command-job-old",
          threadId: "thread-1",
          status: "completed",
          command: "web.fetch",
          summary: "old command",
          startedAt: 2,
          finishedAt: 3,
        }),
        createCommandJob({
          id: "command-job-recent",
          threadId: "thread-1",
          status: "completed",
          command: "watch.create",
          summary: "recent command",
          startedAt: 12,
          finishedAt: 15,
        }),
        createCommandJob({
          id: "command-job-after",
          threadId: "thread-1",
          status: "completed",
          command: "todo.add",
          summary: "after command",
          startedAt: 22,
          finishedAt: 25,
        }),
      ],
    });

    await app.syncStoredState(true);

    expect(output.buffer).not.toContain("oldest");
    expect(output.buffer).not.toContain("command-job-old");
    const middleIndex = output.buffer.indexOf("middle");
    const recentJobIndex = output.buffer.indexOf("command-job-recent");
    const latestIndex = output.buffer.indexOf("latest");
    const afterJobIndex = output.buffer.indexOf("command-job-after");
    expect(middleIndex).toBeGreaterThanOrEqual(0);
    expect(recentJobIndex).toBeGreaterThan(middleIndex);
    expect(latestIndex).toBeGreaterThan(recentJobIndex);
    expect(afterJobIndex).toBeGreaterThan(latestIndex);
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

  it("prints command tool-job status changes without raw payload details", async () => {
    const output = createOutput({isTTY: false});
    let toolJobs: readonly ThreadToolJobRecord[] = [];
    const app = new ObserveApp({
      target: {kind: "thread", threadId: "thread-1"},
    }, {
      output,
    }) as ObserveApp & { services: ObserveServices | null };

    app.services = createServices({
      getThread: async (threadId) => createThread(threadId),
      loadTranscript: async () => [],
      listToolJobs: async () => toolJobs,
    });

    await app.syncStoredState(true);
    toolJobs = [{
      ...createCommandJob({
        id: "command-job-1",
        threadId: "thread-1",
        status: "running",
        command: "watch.create",
      }),
      progress: {
        command: "watch.create",
        rawPayload: "secret payload should stay hidden",
      },
    }];
    await app.syncStoredState(true);
    toolJobs = [
      createCommandJob({
        id: "command-job-1",
        threadId: "thread-1",
        status: "completed",
        command: "watch.create",
        summary: "Created watch watch-1.",
        finishedAt: 2,
      }),
    ];
    await app.syncStoredState(true);

    expect(output.buffer).toContain("command-job-1 | running | watch.create");
    expect(output.buffer).toContain("command-job-1 | completed | watch.create | Created watch watch-1.");
    expect(output.buffer).not.toContain("secret payload");
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
