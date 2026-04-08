import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { Agent, RunContext } from "../src/features/agent-core/index.js";
import { ChannelOutboundDispatcher } from "../src/features/channels/core/index.js";
import { OutboundTool } from "../src/features/panda/index.js";
import type { PandaSessionContext } from "../src/features/panda/types.js";

describe("OutboundTool", () => {
  it("defaults to the current inbound route", async () => {
    const requests: unknown[] = [];
    const dispatcher = new ChannelOutboundDispatcher([{
      channel: "telegram",
      send: async (request) => {
        requests.push(request);
        return {
          ok: true as const,
          channel: request.channel,
          target: request.target,
          sent: [{ type: "text" as const, externalMessageId: "101" }],
        };
      },
    }]);
    const tool = new OutboundTool<PandaSessionContext>();

    const result = await tool.run({
      items: [{ type: "text", text: "hello back" }],
    }, new RunContext({
      agent: new Agent(),
      turn: 0,
      maxTurns: 10,
      messages: [],
      context: {
        cwd: process.cwd(),
        outboundDispatcher: dispatcher,
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
      },
    }));

    expect(requests).toEqual([{
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "8669743878",
        externalConversationId: "1615376408",
        externalActorId: "1615376408",
      },
      items: [{ type: "text", text: "hello back" }],
    }]);
    expect(result).toEqual({
      ok: true,
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "8669743878",
        externalConversationId: "1615376408",
        externalActorId: "1615376408",
        replyToMessageId: null,
      },
      sent: [{ type: "text", externalMessageId: "101" }],
    });
  });

  it("resolves relative file paths before dispatch", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "panda-outbound-tool-"));
    const relativeFile = "report.txt";
    const absoluteFile = path.join(tempDir, relativeFile);
    await writeFile(absoluteFile, "hi");

    const requests: unknown[] = [];
    const dispatcher = new ChannelOutboundDispatcher([{
      channel: "telegram",
      send: async (request) => {
        requests.push(request);
        return {
          ok: true as const,
          channel: request.channel,
          target: request.target,
          sent: [{ type: "file" as const, externalMessageId: "202" }],
        };
      },
    }]);
    const tool = new OutboundTool<PandaSessionContext>();

    await tool.run({
      items: [{ type: "file", path: relativeFile, filename: "report.txt" }],
    }, new RunContext({
      agent: new Agent(),
      turn: 0,
      maxTurns: 10,
      messages: [],
      context: {
        cwd: tempDir,
        outboundDispatcher: dispatcher,
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
      },
    }));

    expect(requests).toEqual([{
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "8669743878",
        externalConversationId: "1615376408",
      },
      items: [{ type: "file", path: absoluteFile, filename: "report.txt" }],
    }]);
  });
});
