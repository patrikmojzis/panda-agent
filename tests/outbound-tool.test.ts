import {mkdtemp, writeFile} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";

import {describe, expect, it} from "vitest";

import {Agent, RunContext} from "../src/kernel/agent/index.js";
import {OutboundTool} from "../src/personas/panda/index.js";
import type {PandaSessionContext} from "../src/personas/panda/types.js";

function createContext(
  overrides: Partial<PandaSessionContext> = {},
): PandaSessionContext & {
  routeLookups: Array<string | undefined>;
  queued: unknown[];
  rememberedRoutes: unknown[];
} {
  const routeLookups: Array<string | undefined> = [];
  const queued: unknown[] = [];
  const rememberedRoutes: unknown[] = [];
  let deliveryCount = 0;

  return {
    cwd: process.cwd(),
    threadId: "thread-1",
    routeLookups,
    queued,
    rememberedRoutes,
    routeMemory: {
      getLastRoute: async (channel) => {
        routeLookups.push(channel);
        return null;
      },
      saveLastRoute: async (route) => {
        rememberedRoutes.push(route);
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

function createRunContext(context: PandaSessionContext): RunContext<PandaSessionContext> {
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
    const tool = new OutboundTool<PandaSessionContext>();
    const context = createContext({
      currentInput: {
        source: "telegram",
        channelId: "1615376408",
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
    expect(context.rememberedRoutes).toEqual([{
      source: "telegram",
      connectorKey: "8669743878",
      externalConversationId: "1615376408",
      externalActorId: "1615376408",
      capturedAt: expect.any(Number),
    }]);
    expect(result).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-1",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "8669743878",
        externalConversationId: "1615376408",
        externalActorId: "1615376408",
        replyToMessageId: null,
      },
    });
  });

  it("resolves relative file paths before queueing", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "panda-outbound-tool-"));
    const relativeFile = "report.txt";
    const absoluteFile = path.join(tempDir, relativeFile);
    await writeFile(absoluteFile, "hi");

    const tool = new OutboundTool<PandaSessionContext>();
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

  it("uses the remembered route for a requested different channel", async () => {
    const tool = new OutboundTool<PandaSessionContext>();
    const context = createContext({
      currentInput: {
        source: "telegram",
        metadata: {
          route: {
            source: "telegram",
            connectorKey: "telegram-bot",
            externalConversationId: "telegram-chat",
          },
        },
      },
      routeMemory: {
        getLastRoute: async (channel) => {
          context.routeLookups.push(channel);
          if (channel === "whatsapp") {
            return {
              source: "whatsapp",
              connectorKey: "whatsapp-connector",
              externalConversationId: "555@s.whatsapp.net",
              externalActorId: "555@s.whatsapp.net",
              capturedAt: 123,
            };
          }

          return null;
        },
        saveLastRoute: async (route) => {
          context.rememberedRoutes.push(route);
        },
      },
    });

    const result = await tool.run({
      channel: "whatsapp",
      items: [{ type: "text", text: "switch lanes" }],
    }, createRunContext(context));

    expect(context.routeLookups).toEqual(["whatsapp"]);
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
    expect(result).toMatchObject({
      status: "queued",
      channel: "whatsapp",
      target: {
        source: "whatsapp",
        connectorKey: "whatsapp-connector",
      },
    });
  });

  it("falls back to the newest remembered route when there is no current inbound message", async () => {
    const tool = new OutboundTool<PandaSessionContext>();
    const context = createContext({
      routeMemory: {
        getLastRoute: async (channel) => {
          context.routeLookups.push(channel);
          return {
            source: "telegram",
            connectorKey: "8669743878",
            externalConversationId: "1615376408",
            externalActorId: "1615376408",
            capturedAt: Date.now(),
          };
        },
        saveLastRoute: async (route) => {
          context.rememberedRoutes.push(route);
        },
      },
    });

    await tool.run({
      items: [{ type: "text", text: "scheduled hello" }],
    }, createRunContext(context));

    expect(context.routeLookups).toEqual([undefined]);
    expect(context.queued).toEqual([{
      threadId: "thread-1",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "8669743878",
        externalConversationId: "1615376408",
        externalActorId: "1615376408",
      },
      items: [{ type: "text", text: "scheduled hello" }],
    }]);
  });

  it("does not rewrite the remembered route when an explicit target override is used", async () => {
    const tool = new OutboundTool<PandaSessionContext>();
    const context = createContext({
      routeMemory: {
        getLastRoute: async (channel) => {
          context.routeLookups.push(channel);
          return {
            source: "telegram",
            connectorKey: "8669743878",
            externalConversationId: "1615376408",
            capturedAt: Date.now(),
          };
        },
        saveLastRoute: async (route) => {
          context.rememberedRoutes.push(route);
        },
      },
    });

    await tool.run({
      channel: "telegram",
      target: {
        connectorKey: "override-bot",
        conversationId: "override-chat",
      },
      items: [{ type: "text", text: "one-off" }],
    }, createRunContext(context));

    expect(context.rememberedRoutes).toEqual([]);
    expect(context.queued).toEqual([{
      threadId: "thread-1",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "override-bot",
        externalConversationId: "override-chat",
      },
      items: [{ type: "text", text: "one-off" }],
    }]);
  });

  it("errors when a requested channel has no current or remembered route", async () => {
    const tool = new OutboundTool<PandaSessionContext>();
    const context = createContext();

    await expect(tool.run({
      channel: "whatsapp",
      items: [{ type: "text", text: "no route" }],
    }, createRunContext(context))).rejects.toThrow(
      "No outbound target was provided and no current inbound route is available.",
    );
    });
  });

  it("rejects outbound during prepare-only scheduled execution", async () => {
    const tool = new OutboundTool<PandaSessionContext>();
    const context = createContext({
      currentInput: {
        source: "scheduled_task",
        metadata: {
          scheduledTask: {
            taskId: "task-1",
            title: "Bee research",
            phase: "execute",
            deliveryMode: "deferred",
            runAt: "2026-04-10T03:00:00.000Z",
            deliverAt: "2026-04-10T08:00:00.000Z",
          },
        },
      },
    });

    await expect(tool.run({
      items: [{ type: "text", text: "too early" }],
    }, createRunContext(context))).rejects.toThrow(
      "Outbound is disabled during prepare-only scheduled task execution.",
    );
  });
