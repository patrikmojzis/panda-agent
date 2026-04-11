import {describe, expect, it, vi} from "vitest";

import {
    Agent,
    type PandaSessionContext,
    RunContext,
    ToolError,
    WatchCreateTool,
    WatchDisableTool,
    WatchUpdateTool,
} from "../src/index.js";
import type {WatchStore} from "../src/domain/watches/index.js";

function createRunContext(context: PandaSessionContext): RunContext<PandaSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "watch-test-agent",
      instructions: "Use tools.",
    }),
    turn: 0,
    maxTurns: 10,
    messages: [],
    context,
  });
}

function createStoreMock(): WatchStore {
  return {
    ensureSchema: vi.fn(async () => {}),
    createWatch: vi.fn(async (input) => ({
      id: "watch-1",
      identityId: input.identityId,
      agentKey: input.agentKey,
      title: input.title,
      intervalMinutes: input.intervalMinutes,
      targetKind: input.targetThreadId ? "thread" : "home",
      targetThreadId: input.targetThreadId,
      source: input.source,
      detector: input.detector,
      enabled: input.enabled ?? true,
      nextPollAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
    updateWatch: vi.fn(async (input) => ({
      id: input.watchId,
      identityId: input.identityId,
      agentKey: input.agentKey,
      title: input.title ?? "watch",
      intervalMinutes: input.intervalMinutes ?? 5,
      targetKind: input.targetThreadId ? "thread" : "home",
      targetThreadId: typeof input.targetThreadId === "string" ? input.targetThreadId : undefined,
      source: input.source ?? {
        kind: "http_json",
        url: "https://example.com/btc",
        result: {
          observation: "scalar",
          valuePath: "price",
        },
      },
      detector: input.detector ?? {
        kind: "percent_change",
        percent: 10,
      },
      enabled: input.enabled ?? true,
      nextPollAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
    disableWatch: vi.fn(async (input) => ({
      id: input.watchId,
      identityId: input.identityId,
      agentKey: input.agentKey,
      title: "watch",
      intervalMinutes: 5,
      targetKind: "home",
      source: {
        kind: "http_json",
        url: "https://example.com/btc",
        result: {
          observation: "scalar",
          valuePath: "price",
        },
      },
      detector: {
        kind: "percent_change",
        percent: 10,
      },
      enabled: false,
      disabledAt: 1,
      lastError: input.reason,
      createdAt: 1,
      updatedAt: 1,
    })),
    getWatch: vi.fn(),
    listDueWatches: vi.fn(),
    claimWatch: vi.fn(),
    startWatchRun: vi.fn(),
    completeWatchRun: vi.fn(),
    failWatchRun: vi.fn(),
    clearWatchClaim: vi.fn(),
    recordEvent: vi.fn(),
    getLatestWatchRun: vi.fn(),
  };
}

describe("watch Panda tools", () => {
  const context: PandaSessionContext = {
    identityId: "identity-1",
    agentKey: "panda",
    threadId: "thread-home",
  };

  it("creates a watch with Panda scope", async () => {
    const store = createStoreMock();
    const tool = new WatchCreateTool({
      store,
    });

    const result = await tool.run({
      title: "BTC 10% move",
      intervalMinutes: 5,
      source: {
        kind: "http_json",
        url: "https://example.com/btc",
        result: {
          observation: "scalar",
          valuePath: "price",
          label: "BTC",
        },
      },
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    }, createRunContext(context));

    expect(result).toEqual({
      watchId: "watch-1",
    });
    expect(store.createWatch).toHaveBeenCalledWith(expect.objectContaining({
      identityId: "identity-1",
      agentKey: "panda",
      title: "BTC 10% move",
    }));
  });

  it("passes null targetThreadId through update so home-following can be restored", async () => {
    const store = createStoreMock();
    const tool = new WatchUpdateTool({
      store,
    });

    const result = await tool.run({
      watchId: "watch-1",
      targetThreadId: null,
    }, createRunContext(context));

    expect(result).toEqual({
      watchId: "watch-1",
      updated: true,
    });
    expect(store.updateWatch).toHaveBeenCalledWith(expect.objectContaining({
      watchId: "watch-1",
      targetThreadId: null,
    }));
  });

  it("disables a watch without deleting it", async () => {
    const store = createStoreMock();
    const tool = new WatchDisableTool({
      store,
    });

    const result = await tool.run({
      watchId: "watch-1",
      reason: "not needed anymore",
    }, createRunContext(context));

    expect(result).toEqual({
      watchId: "watch-1",
      disabled: true,
    });
    expect(store.disableWatch).toHaveBeenCalledWith(expect.objectContaining({
      watchId: "watch-1",
      reason: "not needed anymore",
    }));
  });

  it("requires identityId and agentKey in Panda context", async () => {
    const tool = new WatchCreateTool({
      store: createStoreMock(),
    });

    await expect(tool.run({
      title: "Inbox",
      intervalMinutes: 5,
      source: {
        kind: "imap_mailbox",
        host: "imap.example.com",
        username: "alice@example.com",
        passwordCredentialEnvKey: "IMAP_PASSWORD",
      },
      detector: {
        kind: "new_items",
      },
    }, createRunContext({
      threadId: "thread-home",
    } as PandaSessionContext))).rejects.toBeInstanceOf(ToolError);
  });
});
