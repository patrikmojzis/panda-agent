import {mkdtemp, mkdir, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {RuntimeCommandFileResolver} from "../src/app/runtime/command-files.js";
import {
  A2A_HISTORY_COMMAND_NAME,
  A2A_INSPECT_COMMAND_NAME,
  A2A_SEND_COMMAND_NAME,
  createA2AHistoryCommand,
  createA2AInspectCommand,
  createA2ASendCommand,
} from "../src/domain/a2a/commands.js";

function createEnvironmentMetadata(root: string) {
  return {
    filesystem: {
      envDir: "worker-a",
      root: {
        corePath: root,
        parentRunnerPath: "/environments/worker-a",
      },
      workspace: {
        corePath: path.join(root, "workspace"),
        parentRunnerPath: "/environments/worker-a/workspace",
        workerPath: "/workspace",
      },
      inbox: {
        corePath: path.join(root, "inbox"),
        parentRunnerPath: "/environments/worker-a/inbox",
        workerPath: "/inbox",
      },
      artifacts: {
        corePath: path.join(root, "artifacts"),
        parentRunnerPath: "/environments/worker-a/artifacts",
        workerPath: "/artifacts",
      },
    },
  };
}

describe("a2a command", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const directory of directories) {
      await rm(directory, {recursive: true, force: true});
    }
    directories.clear();
  });

  it("resolves workspace attachments through the command file resolver", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "panda-message-agent-command-"));
    directories.add(root);
    const workspaceNested = path.join(root, "workspace", "nested");
    const reportPath = path.join(workspaceNested, "report.txt");
    await mkdir(workspaceNested, {recursive: true});
    await writeFile(reportPath, "hello", "utf8");
    const resolvedReportPath = await realpath(reportPath);

    const queueMessage = vi.fn(async (input) => ({
      delivery: {
        id: "delivery-1",
      },
      targetAgentKey: input.agentKey ?? "koala",
      targetSessionId: input.sessionId ?? "session-b",
      messageId: "a2a:123",
    }));
    const command = createA2ASendCommand({
      queueMessage,
    }, new RuntimeCommandFileResolver());

    const result = await command.execute({
      command: A2A_SEND_COMMAND_NAME,
      input: {
        sessionId: "session-b",
        items: [
          {type: "text", text: "see attached"},
          {type: "file", path: "report.txt", filename: "report.txt"},
        ],
      },
      workingDirectory: "/workspace/nested",
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
        threadId: "thread-a",
        runId: "run-a",
        executionEnvironment: {
          id: "worker:session-a",
          agentKey: "panda",
          kind: "disposable_container",
          state: "ready",
          source: "binding",
          metadata: createEnvironmentMetadata(root),
        },
      },
    });

    expect(queueMessage).toHaveBeenCalledWith({
      senderAgentKey: "panda",
      senderSessionId: "session-a",
      senderThreadId: "thread-a",
      senderRunId: "run-a",
      agentKey: undefined,
      sessionId: "session-b",
      senderEnvironment: {
        id: "worker:session-a",
        kind: "disposable_container",
        envDir: "worker-a",
        parentRunnerPaths: {
          root: "/environments/worker-a",
          workspace: "/environments/worker-a/workspace",
          inbox: "/environments/worker-a/inbox",
          artifacts: "/environments/worker-a/artifacts",
        },
        workerPaths: {
          workspace: "/workspace",
          inbox: "/inbox",
          artifacts: "/artifacts",
        },
      },
      items: [
        {type: "text", text: "see attached"},
        {type: "file", path: resolvedReportPath, filename: "report.txt"},
      ],
    });
    expect(result.output).toEqual({
      ok: true,
      status: "queued",
      deliveryId: "delivery-1",
      targetAgentKey: "koala",
      targetSessionId: "session-b",
      messageId: "a2a:123",
    });
  });

  it("exposes a2a.send as the primary command name", async () => {
    const queueMessage = vi.fn(async (input) => ({
      delivery: {
        id: "delivery-1",
      },
      targetAgentKey: input.agentKey ?? "koala",
      targetSessionId: input.sessionId ?? "session-b",
      messageId: "a2a:123",
    }));
    const command = createA2ASendCommand({
      queueMessage,
    }, new RuntimeCommandFileResolver());

    const result = await command.execute({
      command: A2A_SEND_COMMAND_NAME,
      input: {
        sessionId: "session-b",
        items: [{type: "text", text: "hello"}],
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
        threadId: "thread-a",
      },
    });

    expect(command.descriptor.name).toBe("a2a.send");
    expect(result.command).toBe("a2a.send");
    expect(result.output).toMatchObject({
      ok: true,
      status: "queued",
      deliveryId: "delivery-1",
    });
  });

  it("rejects legacy image items on the primary a2a.send JSON contract", async () => {
    const queueMessage = vi.fn();
    const command = createA2ASendCommand({
      queueMessage,
    }, new RuntimeCommandFileResolver());

    await expect(command.execute({
      command: A2A_SEND_COMMAND_NAME,
      input: {
        sessionId: "session-b",
        items: [{type: "image", path: "shot.png"}],
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
        threadId: "thread-a",
      },
    })).rejects.toThrow("a2a.send items[0].type image is not accepted; use type=file for A2A attachments.");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("requires current-thread scope before queueing", async () => {
    const queueMessage = vi.fn();
    const command = createA2ASendCommand({
      queueMessage,
    }, new RuntimeCommandFileResolver());

    await expect(command.execute({
      command: A2A_SEND_COMMAND_NAME,
      input: {
        sessionId: "session-b",
        items: [{type: "text", text: "hello"}],
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
      },
    })).rejects.toThrow("a2a.send requires threadId");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("inspects A2A deliveries scoped to the current session", async () => {
    const getA2ADelivery = vi.fn(async () => ({
      deliveryId: "delivery-1",
      messageId: "a2a:123",
      fromAgentKey: "panda",
      fromSessionId: "session-a",
      fromThreadId: "thread-a",
      toAgentKey: "koala",
      toSessionId: "session-b",
      direction: "outbound" as const,
      status: "sent" as const,
      attemptCount: 1,
      itemCount: 1,
      items: [{type: "text" as const, textPreview: "hello"}],
      sentAt: 1,
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    }));
    const command = createA2AInspectCommand({
      getA2ADelivery,
      listA2ADeliveries: vi.fn(),
    });

    const result = await command.execute({
      command: A2A_INSPECT_COMMAND_NAME,
      input: {
        deliveryId: "delivery-1",
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
      },
    });

    expect(getA2ADelivery).toHaveBeenCalledWith({
      sessionId: "session-a",
      deliveryId: "delivery-1",
    });
    expect(result.output).toMatchObject({
      deliveryId: "delivery-1",
      messageId: "a2a:123",
      direction: "outbound",
      status: "sent",
      itemCount: 1,
    });
  });

  it("lists A2A delivery history with peer and direction filters", async () => {
    const listA2ADeliveries = vi.fn(async () => [{
      deliveryId: "delivery-1",
      messageId: "a2a:123",
      fromAgentKey: "panda",
      fromSessionId: "session-a",
      fromThreadId: "thread-a",
      toAgentKey: "koala",
      toSessionId: "session-b",
      direction: "outbound" as const,
      status: "sent" as const,
      attemptCount: 1,
      itemCount: 1,
      items: [{type: "text" as const, textPreview: "hello"}],
      sentAt: 1,
      createdAt: 1,
      updatedAt: 2,
    }]);
    const command = createA2AHistoryCommand({
      getA2ADelivery: vi.fn(),
      listA2ADeliveries,
    });

    const result = await command.execute({
      command: A2A_HISTORY_COMMAND_NAME,
      input: {
        peerSessionId: "session-b",
        direction: "outbound",
        limit: 20,
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
      },
    });

    expect(listA2ADeliveries).toHaveBeenCalledWith({
      sessionId: "session-a",
      peerSessionId: "session-b",
      direction: "outbound",
      limit: 20,
    });
    expect(result.output).toMatchObject({
      count: 1,
      deliveries: [
        expect.objectContaining({
          deliveryId: "delivery-1",
          direction: "outbound",
        }),
      ],
    });
  });
});
