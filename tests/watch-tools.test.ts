import {describe, expect, it, vi} from "vitest";

import {
    Agent,
    type DefaultAgentSessionContext,
    RunContext,
    ToolError,
    WatchCreateTool,
    WatchDisableTool,
    WatchSchemaGetTool,
    WatchUpdateTool,
} from "../src/index.js";
import type {WatchMutationService} from "../src/domain/watches/mutation-service.js";
import type {WatchStore} from "../src/domain/watches/index.js";

function createRunContext(context: DefaultAgentSessionContext): RunContext<DefaultAgentSessionContext> {
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
      sessionId: input.sessionId,
      createdByIdentityId: input.createdByIdentityId,
      title: input.title,
      intervalMinutes: input.intervalMinutes,
      source: input.source,
      detector: input.detector,
      enabled: input.enabled ?? true,
      nextPollAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
    updateWatch: vi.fn(async (input) => ({
      id: input.watchId,
      sessionId: input.sessionId,
      title: input.title ?? "watch",
      intervalMinutes: input.intervalMinutes ?? 5,
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
      sessionId: input.sessionId,
      title: "watch",
      intervalMinutes: 5,
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

function createMutationServiceMock() {
  return {
    createWatch: vi.fn(async (input, scope) => ({
      id: "watch-1",
      sessionId: scope.sessionId,
      createdByIdentityId: scope.createdByIdentityId,
      title: input.title,
      intervalMinutes: input.intervalMinutes,
      source: input.source,
      detector: input.detector,
      enabled: input.enabled ?? true,
      nextPollAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
    updateWatch: vi.fn(async (input, scope) => ({
      id: input.watchId,
      sessionId: scope.sessionId,
      createdByIdentityId: scope.createdByIdentityId,
      title: input.title ?? "watch",
      intervalMinutes: input.intervalMinutes ?? 5,
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
  } as unknown as WatchMutationService;
}

describe("watch Panda tools", () => {
  const context: DefaultAgentSessionContext = {
    agentKey: "panda",
    sessionId: "session-main",
    threadId: "thread-home",
    currentInput: {
      source: "tui",
      identityId: "identity-1",
    },
  };

  it("creates a watch with Panda scope", async () => {
    const store = createStoreMock();
    const mutations = createMutationServiceMock();
    const tool = new WatchCreateTool({
      mutations,
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
    expect(mutations.createWatch).toHaveBeenCalledWith(expect.objectContaining({
      title: "BTC 10% move",
    }), expect.objectContaining({
      agentKey: "panda",
      sessionId: "session-main",
      createdByIdentityId: "identity-1",
    }));
  });

  it("updates a watch within the current session", async () => {
    const store = createStoreMock();
    const mutations = createMutationServiceMock();
    const tool = new WatchUpdateTool({
      mutations,
      store,
    });

    const result = await tool.run({
      watchId: "watch-1",
      enabled: false,
    }, createRunContext(context));

    expect(result).toEqual({
      watchId: "watch-1",
      updated: true,
    });
    expect(mutations.updateWatch).toHaveBeenCalledWith(expect.objectContaining({
      watchId: "watch-1",
      enabled: false,
    }), expect.objectContaining({
      agentKey: "panda",
      sessionId: "session-main",
    }));
  });

  it("returns detailed watch schema help on demand", async () => {
    const tool = new WatchSchemaGetTool();

    const result = await tool.run({
      sourceKind: "http_json",
      detectorKind: "percent_change",
    }, createRunContext(context));

    expect(result).toMatchObject({
      source: {
        kind: "http_json",
        example: {
          kind: "http_json",
          url: "https://api.example.com/btc-price",
        },
      },
      detector: {
        kind: "percent_change",
        example: {
          kind: "percent_change",
          percent: 10,
        },
      },
    });
    expect(result.source?.notes.length).toBeGreaterThan(0);
    expect(result.detector?.notes.length).toBeGreaterThan(0);
    expect(result.source?.schema).toMatchObject({
      type: "object",
      properties: {
        kind: {
          const: "http_json",
        },
        url: {
          format: "uri",
        },
      },
    });
    expect(result.detector?.schema).toMatchObject({
      type: "object",
      properties: {
        kind: {
          const: "percent_change",
        },
        percent: {
          type: "number",
        },
      },
      required: ["kind", "percent"],
    });
  });

  it("supports source-only schema help", async () => {
    const tool = new WatchSchemaGetTool();

    const result = await tool.run({
      sourceKind: "imap_mailbox",
    }, createRunContext(context));

    expect(result).toEqual({
      source: expect.objectContaining({
        kind: "imap_mailbox",
      }),
    });
  });

  it("rejects empty schema help requests", async () => {
    const tool = new WatchSchemaGetTool();

    await expect(tool.run({}, createRunContext(context))).rejects.toBeInstanceOf(ToolError);
  });

  it("disables a watch without deleting it", async () => {
    const store = createStoreMock();
    const mutations = createMutationServiceMock();
    const tool = new WatchDisableTool({
      mutations,
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

  it("requires sessionId in Panda context", async () => {
    const tool = new WatchCreateTool({
      mutations: createMutationServiceMock(),
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
    } as DefaultAgentSessionContext))).rejects.toBeInstanceOf(ToolError);
  });

  it("keeps watch_create provider schema compact", () => {
    const tool = new WatchCreateTool({
      mutations: createMutationServiceMock(),
      store: createStoreMock(),
    });

    expect(tool.piTool.parameters).toMatchObject({
      type: "object",
      properties: {
        source: {
          type: "object",
          properties: {
            kind: {
              enum: ["mongodb_query", "sql_query", "http_json", "http_html", "imap_mailbox"],
            },
          },
          required: ["kind"],
        },
        detector: {
          type: "object",
          properties: {
            kind: {
              enum: ["new_items", "snapshot_changed", "percent_change"],
            },
          },
          required: ["kind"],
        },
      },
    });
    expect(tool.piTool.parameters.properties?.source).not.toHaveProperty("anyOf");
    expect(tool.piTool.parameters.properties?.detector).not.toHaveProperty("anyOf");
  });

  it("keeps watch_update provider schema compact", () => {
    const tool = new WatchUpdateTool({
      mutations: createMutationServiceMock(),
      store: createStoreMock(),
    });

    expect(tool.piTool.parameters).toMatchObject({
      type: "object",
      properties: {
        source: {
          type: "object",
          properties: {
            kind: {
              enum: ["mongodb_query", "sql_query", "http_json", "http_html", "imap_mailbox"],
            },
          },
        },
        detector: {
          type: "object",
          properties: {
            kind: {
              enum: ["new_items", "snapshot_changed", "percent_change"],
            },
          },
        },
      },
    });
    expect(tool.piTool.parameters.properties?.source).not.toHaveProperty("anyOf");
    expect(tool.piTool.parameters.properties?.detector).not.toHaveProperty("anyOf");
  });

  it("still validates detailed source fields before persistence", async () => {
    const mutations = createMutationServiceMock();
    const tool = new WatchCreateTool({
      mutations,
      store: createStoreMock(),
    });

    await expect(tool.run({
      title: "Broken JSON watch",
      intervalMinutes: 5,
      source: {
        kind: "http_json",
        url: "https://example.com/btc",
      },
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    }, createRunContext(context))).rejects.toBeInstanceOf(ToolError);

    expect(mutations.createWatch).not.toHaveBeenCalled();
  });
});
