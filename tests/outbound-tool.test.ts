import {mkdtemp, writeFile} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";

import {describe, expect, it} from "vitest";

import {Agent, RunContext} from "../src/kernel/agent/index.js";
import {OutboundTool} from "../src/panda/index.js";
import type {
  DefaultAgentRouteMemoryLookup,
  DefaultAgentRouteMemorySaveOptions,
  DefaultAgentSessionContext,
} from "../src/app/runtime/panda-session-context.js";
import type {IdentityRecord} from "../src/domain/identity/index.js";

function createIdentity(id: string, handle: string): IdentityRecord {
  return {
    id,
    handle,
    displayName: handle,
    status: "active",
    createdAt: 123,
    updatedAt: 123,
  };
}

function createContext(
  overrides: Partial<DefaultAgentSessionContext> = {},
): DefaultAgentSessionContext & {
  identityLookups: string[];
  routeLookups: Array<DefaultAgentRouteMemoryLookup | undefined>;
  queued: unknown[];
  rememberedRoutes: unknown[];
  rememberedRouteOptions: Array<DefaultAgentRouteMemorySaveOptions | undefined>;
} {
  const identityLookups: string[] = [];
  const routeLookups: Array<DefaultAgentRouteMemoryLookup | undefined> = [];
  const queued: unknown[] = [];
  const rememberedRoutes: unknown[] = [];
  const rememberedRouteOptions: Array<DefaultAgentRouteMemorySaveOptions | undefined> = [];
  let deliveryCount = 0;

  return {
    cwd: process.cwd(),
    agentKey: "panda",
    sessionId: "session-1",
    threadId: "thread-1",
    identityLookups,
    routeLookups,
    queued,
    rememberedRoutes,
    rememberedRouteOptions,
    identityDirectory: {
      getIdentityByHandle: async (handle) => {
        identityLookups.push(handle);
        throw new Error(`Unknown identity handle ${handle}`);
      },
    },
    routeMemory: {
      getLastRoute: async (lookup) => {
        routeLookups.push(lookup);
        return null;
      },
      saveLastRoute: async (route, options) => {
        rememberedRoutes.push(route);
        rememberedRouteOptions.push(options);
      },
    },
    outboundQueue: {
      enqueueDelivery: async (input) => {
        queued.push(input);
        deliveryCount += 1;
        return {
          id: `delivery-${deliveryCount}`,
          status: "pending",
          attemptCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...input,
        };
      },
    },
    ...overrides,
  };
}

function createRunContext(context: DefaultAgentSessionContext): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent(),
    turn: 0,
    maxTurns: 10,
    messages: [],
    context,
  });
}

describe("OutboundTool", () => {
  it("queues a reply on the current inbound route", async () => {
    const tool = new OutboundTool<DefaultAgentSessionContext>();
    const context = createContext({
      currentInput: {
        source: "telegram",
        channelId: "1615376408",
        identityId: "identity-patrik",
        metadata: {
          route: {
            source: "telegram",
            connectorKey: "8669743878",
            externalConversationId: "1615376408",
            externalActorId: "1615376408",
          },
        },
      },
    });

    const result = await tool.run({
      items: [{ type: "text", text: "hello back" }],
    }, createRunContext(context));

    expect(context.queued).toEqual([{
      threadId: "thread-1",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "8669743878",
        externalConversationId: "1615376408",
        externalActorId: "1615376408",
      },
      items: [{ type: "text", text: "hello back" }],
    }]);
    expect(context.rememberedRouteOptions).toEqual([{identityId: "identity-patrik"}]);
    expect(result).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-1",
      to: {
        channel: "telegram",
      },
    });
    expect(JSON.stringify(result)).not.toContain("connectorKey");
    expect(JSON.stringify(result)).not.toContain("externalConversationId");
    expect(JSON.stringify(result)).not.toContain("externalActorId");
  });

  it("can target the current TUI route just like any other channel lane", async () => {
    const tool = new OutboundTool<DefaultAgentSessionContext>();
    const context = createContext({
      currentInput: {
        source: "tui",
        channelId: "terminal",
        metadata: {
          route: {
            source: "tui",
            connectorKey: "local-tui",
            externalConversationId: "terminal",
            externalActorId: "local-user",
          },
        },
      },
    });

    const result = await tool.run({
      items: [{ type: "text", text: "back to terminal" }],
    }, createRunContext(context));

    expect(context.queued).toEqual([{
      threadId: "thread-1",
      channel: "tui",
      target: {
        source: "tui",
        connectorKey: "local-tui",
        externalConversationId: "terminal",
        externalActorId: "local-user",
      },
      items: [{ type: "text", text: "back to terminal" }],
    }]);
    expect(result).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-1",
      to: {
        channel: "tui",
      },
    });
  });

  it("resolves relative file paths before queueing", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "runtime-outbound-tool-"));
    const relativeFile = "report.txt";
    const absoluteFile = path.join(tempDir, relativeFile);
    await writeFile(absoluteFile, "hi");

    const tool = new OutboundTool<DefaultAgentSessionContext>();
    const context = createContext({
      cwd: tempDir,
      currentInput: {
        source: "telegram",
        metadata: {
          route: {
            source: "telegram",
            connectorKey: "8669743878",
            externalConversationId: "1615376408",
          },
        },
      },
    });

    await tool.run({
      items: [{ type: "file", path: relativeFile, filename: "report.txt" }],
    }, createRunContext(context));

    expect(context.queued).toEqual([{
      threadId: "thread-1",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "8669743878",
        externalConversationId: "1615376408",
      },
      items: [{ type: "file", path: absoluteFile, filename: "report.txt" }],
    }]);
  });

  it("uses an identity's newest remembered route when channel is omitted", async () => {
    const tool = new OutboundTool<DefaultAgentSessionContext>();
    const identity = createIdentity("identity-angelina", "angelina");
    const context = createContext({
      identityDirectory: {
        getIdentityByHandle: async (handle) => {
          context.identityLookups.push(handle);
          return identity;
        },
      },
      routeMemory: {
        getLastRoute: async (lookup) => {
          context.routeLookups.push(lookup);
          return lookup?.identityId === "identity-angelina" && !lookup.channel
            ? {
              source: "whatsapp",
              connectorKey: "whatsapp-connector",
              externalConversationId: "555@s.whatsapp.net",
              externalActorId: "555@s.whatsapp.net",
              capturedAt: 123,
            }
            : null;
        },
        saveLastRoute: async (route, options) => {
          context.rememberedRoutes.push(route);
          context.rememberedRouteOptions.push(options);
        },
      },
    });

    const result = await tool.run({
      to: { identityHandle: "angelina" },
      items: [{ type: "text", text: "switch lanes" }],
    }, createRunContext(context));

    expect(context.identityLookups).toEqual(["angelina"]);
    expect(context.routeLookups).toEqual([{identityId: "identity-angelina"}]);
    expect(context.rememberedRoutes).toEqual([]);
    expect(context.queued).toEqual([{
      threadId: "thread-1",
      channel: "whatsapp",
      target: {
        source: "whatsapp",
        connectorKey: "whatsapp-connector",
        externalConversationId: "555@s.whatsapp.net",
        externalActorId: "555@s.whatsapp.net",
      },
      items: [{ type: "text", text: "switch lanes" }],
    }]);
    expect(result).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-1",
      to: {
        identityHandle: "angelina",
        channel: "whatsapp",
      },
    });
  });

  it("uses an identity's remembered route for a requested channel", async () => {
    const tool = new OutboundTool<DefaultAgentSessionContext>();
    const identity = createIdentity("identity-patrik", "patrik_mojzis");
    const context = createContext({
      identityDirectory: {
        getIdentityByHandle: async (handle) => {
          context.identityLookups.push(handle);
          return identity;
        },
      },
      routeMemory: {
        getLastRoute: async (lookup) => {
          context.routeLookups.push(lookup);
          return lookup?.identityId === "identity-patrik" && lookup.channel === "telegram"
            ? {
              source: "telegram",
              connectorKey: "telegram-bot",
              externalConversationId: "chat-1",
              externalActorId: "actor-1",
              capturedAt: 123,
            }
            : null;
        },
        saveLastRoute: async (route, options) => {
          context.rememberedRoutes.push(route);
          context.rememberedRouteOptions.push(options);
        },
      },
    });

    await tool.run({
      to: {
        identityHandle: "patrik_mojzis",
        channel: "telegram",
      },
      items: [{ type: "text", text: "telegram hello" }],
    }, createRunContext(context));

    expect(context.identityLookups).toEqual(["patrik_mojzis"]);
    expect(context.routeLookups).toEqual([{
      identityId: "identity-patrik",
      channel: "telegram",
    }]);
    expect(context.queued).toMatchObject([{
      channel: "telegram",
      target: {
        connectorKey: "telegram-bot",
        externalConversationId: "chat-1",
        externalActorId: "actor-1",
      },
    }]);
  });

  it("errors clearly for unknown outbound identities", async () => {
    const tool = new OutboundTool<DefaultAgentSessionContext>();
    const context = createContext();

    await expect(tool.run({
      to: { identityHandle: "patrik_mojzis" },
      items: [{ type: "text", text: "hello" }],
    }, createRunContext(context))).rejects.toThrow(
      "Unknown outbound identity patrik_mojzis.",
    );
  });

  it("errors clearly when an identity has no remembered route", async () => {
    const tool = new OutboundTool<DefaultAgentSessionContext>();
    const context = createContext({
      identityDirectory: {
        getIdentityByHandle: async () => createIdentity("identity-patrik", "patrik_mojzis"),
      },
    });

    await expect(tool.run({
      to: { identityHandle: "patrik_mojzis" },
      items: [{ type: "text", text: "hello" }],
    }, createRunContext(context))).rejects.toThrow(
      "No remembered outbound route for patrik_mojzis.",
    );
  });

  it("errors clearly when an identity has no remembered route for a requested channel", async () => {
    const tool = new OutboundTool<DefaultAgentSessionContext>();
    const context = createContext({
      identityDirectory: {
        getIdentityByHandle: async () => createIdentity("identity-patrik", "patrik_mojzis"),
      },
    });

    await expect(tool.run({
      to: {
        identityHandle: "patrik_mojzis",
        channel: "telegram",
      },
      items: [{ type: "text", text: "hello" }],
    }, createRunContext(context))).rejects.toThrow(
      "No remembered telegram route for patrik_mojzis.",
    );
  });

  it("falls back to the active identity remembered route when there is no current inbound message", async () => {
    const tool = new OutboundTool<DefaultAgentSessionContext>();
    const context = createContext({
      currentInput: {
        source: "scheduled_task",
        identityId: "identity-1",
        metadata: {
          scheduledTask: {
            taskId: "task-1",
            title: "Ping",
            runAt: "2026-04-10T03:00:00.000Z",
          },
        },
      },
      routeMemory: {
        getLastRoute: async (lookup) => {
          context.routeLookups.push(lookup);
          return lookup?.identityId === "identity-1"
            ? {
              source: "telegram",
              connectorKey: "telegram-bot",
              externalConversationId: "chat-identity-1",
              externalActorId: "actor-identity-1",
              capturedAt: 123,
            }
            : null;
        },
        saveLastRoute: async (route, options) => {
          context.rememberedRoutes.push(route);
          context.rememberedRouteOptions.push(options);
        },
      },
    });

    await tool.run({
      items: [{ type: "text", text: "identity scoped hello" }],
    }, createRunContext(context));

    expect(context.routeLookups).toEqual([{identityId: "identity-1"}]);
    expect(context.rememberedRouteOptions).toEqual([{identityId: "identity-1"}]);
    expect(context.queued).toMatchObject([{
      channel: "telegram",
      target: {
        externalConversationId: "chat-identity-1",
        externalActorId: "actor-identity-1",
      },
    }]);
  });

  it("rejects raw transport routing keys", async () => {
    const tool = new OutboundTool<DefaultAgentSessionContext>();
    const context = createContext();

    await expect(tool.run({
      channel: "telegram",
      target: {
        connectorKey: "connector",
        conversationId: "chat",
      },
      items: [{ type: "text", text: "nope" }],
    }, createRunContext(context))).rejects.toThrow(
      "Unrecognized",
    );
  });

  it("rejects A2A fallback routes", async () => {
    const tool = new OutboundTool<DefaultAgentSessionContext>();
    const context = createContext({
      currentInput: {
        source: "a2a",
        metadata: {
          route: {
            source: "a2a",
            connectorKey: "local",
            externalConversationId: "session-b",
            externalActorId: "koala",
          },
        },
      },
    });

    await expect(tool.run({
      items: [{ type: "text", text: "nope" }],
    }, createRunContext(context))).rejects.toThrow(
      "Use message_agent for Panda A2A messages.",
    );
  });

  it("rejects email routes", async () => {
    const tool = new OutboundTool<DefaultAgentSessionContext>();
    const identity = createIdentity("identity-patrik", "patrik_mojzis");
    const context = createContext({
      identityDirectory: {
        getIdentityByHandle: async () => identity,
      },
      routeMemory: {
        getLastRoute: async (lookup) => {
          context.routeLookups.push(lookup);
          return {
            source: "email",
            connectorKey: "smtp",
            externalConversationId: "work",
            capturedAt: 123,
          };
        },
        saveLastRoute: async (route, options) => {
          context.rememberedRoutes.push(route);
          context.rememberedRouteOptions.push(options);
        },
      },
    });

    await expect(tool.run({
      to: { identityHandle: "patrik_mojzis" },
      items: [{ type: "text", text: "nope" }],
    }, createRunContext(context))).rejects.toThrow(
      "Use email_send for email.",
    );
  });
});
