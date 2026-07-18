import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {
  A2A_HISTORY_COMMAND_NAME,
  A2A_INSPECT_COMMAND_NAME,
  A2A_SEND_COMMAND_NAME,
  MAX_A2A_ATTACHMENT_BYTES,
  MAX_A2A_TOTAL_ATTACHMENT_BYTES,
  createA2AHistoryCommand,
  createA2AInspectCommand,
  createA2ASendCommand,
} from "../src/domain/a2a/commands.js";

function createUploadStore() {
  return {
    inspect: vi.fn(async (_scope: unknown, uploadRef: string) => ({
      uploadRef,
      filename: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    })),
    resolve: vi.fn(),
    remove: vi.fn(),
  };
}

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

  it("resolves sender-scoped upload references without a workspace path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "panda-message-agent-command-"));
    directories.add(root);

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
    }, createUploadStore());

    const result = await command.execute({
      command: A2A_SEND_COMMAND_NAME,
      input: {
        sessionId: "session-b",
        items: [
          {type: "text", text: "see attached"},
          {type: "file", uploadRef: "upl_1234567890abcdef1234567890abcdef", filename: "spoofed.txt"},
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
        {
          type: "file",
          uploadRef: "upl_1234567890abcdef1234567890abcdef",
          filename: "report.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
        },
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
    }, createUploadStore());

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
    }, createUploadStore());

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

  it("hard-rejects server-local paths before inspecting or queueing", async () => {
    const queueMessage = vi.fn();
    const uploads = createUploadStore();
    const command = createA2ASendCommand({queueMessage}, uploads);

    await expect(command.execute({
      command: A2A_SEND_COMMAND_NAME,
      input: {
        sessionId: "session-b",
        items: [{type: "file", path: "/tmp/report.txt"}],
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
        threadId: "thread-a",
      },
    })).rejects.toThrow(
      "a2a.send items[0] does not accept path; upload the client-local file and pass uploadRef.",
    );
    expect(uploads.inspect).not.toHaveBeenCalled();
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("enforces 60 MiB per upload and 150 MiB across server-observed sizes", async () => {
    const queueMessage = vi.fn(async () => ({
      delivery: {id: "delivery-1"},
      targetAgentKey: "koala",
      targetSessionId: "session-b",
      messageId: "a2a:123",
    }));
    const sizes = new Map<string, number>();
    const uploads = createUploadStore();
    uploads.inspect.mockImplementation(async (_scope: unknown, uploadRef: string) => ({
      uploadRef,
      filename: `${uploadRef}.bin`,
      mimeType: "application/octet-stream",
      sizeBytes: sizes.get(uploadRef) ?? 0,
    }));
    const command = createA2ASendCommand({queueMessage}, uploads);
    const execute = (refs: string[]) => command.execute({
      command: A2A_SEND_COMMAND_NAME,
      input: {
        sessionId: "session-b",
        items: refs.map((uploadRef) => ({type: "file", uploadRef})),
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-a",
        threadId: "thread-a",
      },
    });

    sizes.set("oversized", MAX_A2A_ATTACHMENT_BYTES + 1);
    await expect(execute(["oversized"]))
      .rejects.toThrow(`${MAX_A2A_ATTACHMENT_BYTES} byte per-file limit`);

    sizes.set("part-a", 50 * 1024 * 1024);
    sizes.set("part-b", 50 * 1024 * 1024);
    sizes.set("part-c", 50 * 1024 * 1024);
    sizes.set("extra", 1);
    await expect(execute(["part-a", "part-b", "part-c"]))
      .resolves.toMatchObject({ok: true});
    await expect(execute(["part-a", "part-b", "part-c", "extra"]))
      .rejects.toThrow(`${MAX_A2A_TOTAL_ATTACHMENT_BYTES} byte per-send limit`);
  });

  it("requires current-thread scope before queueing", async () => {
    const queueMessage = vi.fn();
    const command = createA2ASendCommand({
      queueMessage,
    }, createUploadStore());

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
