import {describe, expect, it, vi} from "vitest";

import {RuntimeRequestRepo} from "../src/domain/threads/requests/repo.js";
import type {DiscordMessageRequestPayload, TelegramReactCommandRequestPayload} from "../src/domain/threads/requests/types.js";

function createFakeNotificationClient() {
  return {
    off: vi.fn(),
    on: vi.fn(),
    query: vi.fn(async () => ({rows: []})),
    release: vi.fn(),
  };
}

function validDiscordPayload(overrides: Partial<DiscordMessageRequestPayload> = {}): DiscordMessageRequestPayload {
  return {
    connectorKey: "bot-1",
    externalConversationId: "channel-1",
    externalActorId: "user-1",
    externalMessageId: "message-1",
    actualChannelId: "channel-1",
    text: "hello",
    attachmentSummaries: [],
    media: [],
    ...overrides,
  };
}

function createEnqueueRepo() {
  const now = new Date();
  const pool = {
    connect: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("pg_notify")) {
        return {rows: []};
      }

      return {
        rows: [{
          id: String(params[0]),
          kind: params[1],
          status: "pending",
          payload: JSON.parse(String(params[2])) as unknown,
          result: null,
          error: null,
          claimed_at: null,
          finished_at: null,
          created_at: now,
          updated_at: now,
        }],
      };
    }),
  };

  return {
    pool,
    repo: new RuntimeRequestRepo({pool}),
  };
}

describe("RuntimeRequestRepo", () => {
  const validTelegramPayload = {
    connectorKey: "bot-1",
    externalConversationId: "chat-1",
    chatId: "chat-1",
    chatType: "private",
    externalActorId: "actor-1",
    externalMessageId: "message-1",
    text: "hello",
    media: [],
  };

  it("uses the notification pool for LISTEN clients", async () => {
    const queryPool = {
      connect: vi.fn(async () => {
        throw new Error("query pool should not be used for LISTEN");
      }),
      query: vi.fn(async () => ({rows: []})),
    };
    const client = createFakeNotificationClient();
    const notificationPool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({rows: []})),
    };
    const repo = new RuntimeRequestRepo({
      pool: queryPool,
      notificationPool,
    });

    const unsubscribe = await repo.listenPendingRequests(() => {});
    await unsubscribe();

    expect(queryPool.connect).not.toHaveBeenCalled();
    expect(notificationPool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, "LISTEN runtime_request_events");
    expect(client.query).toHaveBeenNthCalledWith(2, "UNLISTEN runtime_request_events");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("releases the notification client when LISTEN setup fails", async () => {
    const queryPool = {
      connect: vi.fn(async () => {
        throw new Error("query pool should not be used for LISTEN");
      }),
      query: vi.fn(async () => ({rows: []})),
    };
    const client = createFakeNotificationClient();
    client.query.mockRejectedValueOnce(new Error("listen blew up"));
    const repo = new RuntimeRequestRepo({
      pool: queryPool,
      notificationPool: {
        connect: vi.fn(async () => client),
        query: vi.fn(async () => ({rows: []})),
      },
    });

    await expect(repo.listenPendingRequests(() => {})).rejects.toThrow("listen blew up");

    expect(client.off).toHaveBeenCalledTimes(3);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("allows stale running requests to be reclaimed", async () => {
    const claimedAt = new Date(Date.now() - 10 * 60_000);
    const row = {
      id: "7a0b9429-d5bf-41dc-9224-088cff4d2137",
      kind: "telegram_message",
      status: "running",
      payload: validTelegramPayload,
      result: null,
      error: null,
      claimed_at: claimedAt,
      finished_at: null,
      created_at: claimedAt,
      updated_at: claimedAt,
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return {rows: []};
        }
        return {rows: [row]};
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({rows: []})),
    };
    const repo = new RuntimeRequestRepo({
      pool,
      staleRunningRequestMs: 123_456,
    });

    const claimed = await repo.claimNextPendingRequest();

    expect(claimed).toMatchObject({
      id: row.id,
      status: "running",
      payload: row.payload,
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("status = 'running'"), [
      123_456,
    ]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("claimed_at < NOW() - ($1 * INTERVAL '1 millisecond')"), [
      123_456,
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("normalizes legacy reset command message ids", async () => {
    const now = new Date();
    const repo = new RuntimeRequestRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{
            id: "7a0b9429-d5bf-41dc-9224-088cff4d2137",
            kind: "reset_session",
            status: "pending",
            payload: {
              source: "telegram",
              connectorKey: "bot-1",
              externalConversationId: "chat-1",
              commandExternalMessageId: "message-1",
            },
            result: null,
            error: null,
            claimed_at: null,
            finished_at: null,
            created_at: now,
            updated_at: now,
          }],
        })),
      },
    });

    const request = await repo.getRequest("7a0b9429-d5bf-41dc-9224-088cff4d2137");

    expect(request.payload).toMatchObject({
      source: "telegram",
      externalMessageId: "message-1",
    });
    expect(request.payload).not.toHaveProperty("commandExternalMessageId");
  });

  it("rejects malformed persisted payloads before claiming requests", async () => {
    const now = new Date();
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return {rows: []};
        }

        if (sql.trimStart().startsWith("UPDATE")) {
          throw new Error("should not update malformed runtime request");
        }

        return {
          rows: [{
            id: "7a0b9429-d5bf-41dc-9224-088cff4d2137",
            kind: "telegram_message",
            status: "pending",
            payload: {connectorKey: "bot-1"},
            result: null,
            error: null,
            claimed_at: null,
            finished_at: null,
            created_at: now,
            updated_at: now,
          }],
        };
      }),
      release: vi.fn(),
    };
    const repo = new RuntimeRequestRepo({
      pool: {
        connect: vi.fn(async () => client),
        query: vi.fn(async () => ({rows: []})),
      },
    });

    await expect(repo.claimNextPendingRequest()).rejects.toThrow("Telegram conversation id");

    expect(queries.some((query) => query.trimStart().startsWith("UPDATE"))).toBe(false);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rejects driver-shaped numeric payload fields before claiming requests", async () => {
    const now = new Date();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return {rows: []};
        }

        if (sql.trimStart().startsWith("UPDATE")) {
          throw new Error("should not update malformed runtime request");
        }

        return {
          rows: [{
            id: "7a0b9429-d5bf-41dc-9224-088cff4d2137",
            kind: "telegram_message",
            status: "pending",
            payload: {
              ...validTelegramPayload,
              sentAt: "1",
            },
            result: null,
            error: null,
            claimed_at: null,
            finished_at: null,
            created_at: now,
            updated_at: now,
          }],
        };
      }),
      release: vi.fn(),
    };
    const repo = new RuntimeRequestRepo({
      pool: {
        connect: vi.fn(async () => client),
        query: vi.fn(async () => ({rows: []})),
      },
    });

    await expect(repo.claimNextPendingRequest()).rejects.toThrow(
      "Runtime request Telegram sent timestamp must be a finite number.",
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rejects object-shaped optional string payload fields before claiming requests", async () => {
    const now = new Date();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return {rows: []};
        }

        if (sql.trimStart().startsWith("UPDATE")) {
          throw new Error("should not update malformed runtime request");
        }

        return {
          rows: [{
            id: "7a0b9429-d5bf-41dc-9224-088cff4d2137",
            kind: "telegram_message",
            status: "pending",
            payload: {
              ...validTelegramPayload,
              username: {bad: true},
            },
            result: null,
            error: null,
            claimed_at: null,
            finished_at: null,
            created_at: now,
            updated_at: now,
          }],
        };
      }),
      release: vi.fn(),
    };
    const repo = new RuntimeRequestRepo({
      pool: {
        connect: vi.fn(async () => client),
        query: vi.fn(async () => ({rows: []})),
      },
    });

    await expect(repo.claimNextPendingRequest()).rejects.toThrow(
      "Runtime request optional string field must be a string.",
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported persisted request statuses", async () => {
    const now = new Date();
    const repo = new RuntimeRequestRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{
            id: "7a0b9429-d5bf-41dc-9224-088cff4d2137",
            kind: "telegram_message",
            status: "stuck",
            payload: validTelegramPayload,
            result: null,
            error: null,
            claimed_at: null,
            finished_at: null,
            created_at: now,
            updated_at: now,
          }],
        })),
      },
    });

    await expect(repo.getRequest("7a0b9429-d5bf-41dc-9224-088cff4d2137")).rejects.toThrow(
      "Unsupported runtime request status stuck",
    );
  });

  it("rejects object-wrapped persisted request statuses", async () => {
    const now = new Date();
    const repo = new RuntimeRequestRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{
            id: "7a0b9429-d5bf-41dc-9224-088cff4d2137",
            kind: "telegram_message",
            status: new String("pending"),
            payload: validTelegramPayload,
            result: null,
            error: null,
            claimed_at: null,
            finished_at: null,
            created_at: now,
            updated_at: now,
          }],
        })),
      },
    });

    await expect(repo.getRequest("7a0b9429-d5bf-41dc-9224-088cff4d2137")).rejects.toThrow(
      "Unsupported runtime request status pending",
    );
  });

  it("normalizes telegram_react_command payloads and strips raw unknown fields before enqueue", async () => {
    const {repo} = createEnqueueRepo();

    const request = await repo.enqueueRequest({
      kind: "telegram_react_command",
      payload: {
        agentKey: "panda",
        sessionId: "session-1",
        threadId: "thread-1",
        runId: "run-1",
        emoji: "🔥",
        remove: false,
        messageId: "555",
        target: {
          connectorKey: "8669743878",
          conversationId: "1615376408",
          ignored: "drop-me",
        },
        rawTelegramUpdate: {private: "drop-me"},
      } as TelegramReactCommandRequestPayload & Record<string, unknown>,
    });

    expect(request.kind).toBe("telegram_react_command");
    expect(request.payload).toEqual({
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
      runId: "run-1",
      emoji: "🔥",
      remove: false,
      messageId: "555",
      target: {
        connectorKey: "8669743878",
        conversationId: "1615376408",
      },
    });
    expect(request.payload).not.toHaveProperty("rawTelegramUpdate");
    expect(JSON.stringify(request.payload)).not.toContain("drop-me");
  });

  it("normalizes discord_message payloads and strips raw unknown fields before enqueue", async () => {
    const {repo} = createEnqueueRepo();

    const request = await repo.enqueueRequest({
      kind: "discord_message",
      payload: {
        ...validDiscordPayload({
          sentAt: 1_768_000_000_000,
          guildId: "guild-1",
          threadId: "thread-1",
          parentChannelId: "channel-1",
          authorUsername: "patrik",
          authorGlobalName: "Patrik Global",
          authorDisplayName: "Patrik Display",
          authorIsBot: false,
          replyToMessageId: "reply-1",
          deliveryContext: {
            discord: {
              channelId: "thread-1",
              parentChannelId: "channel-1",
              threadId: "thread-1",
              guildId: "guild-1",
              messageId: "message-1",
              referencedMessageId: "reply-1",
            },
          },
          attachmentSummaries: [{
            id: "attachment-1",
            filename: "report.pdf",
            contentType: "application/pdf",
            sizeBytes: 123,
          }],
          media: [{
            id: "media-1",
            source: "discord",
            connectorKey: "bot-1",
            mimeType: "image/png",
            sizeBytes: 5,
            localPath: "/tmp/discord-media.png",
            originalFilename: "image.png",
            metadata: {discordAttachmentId: "attachment-1"},
            createdAt: 1,
          }],
        }),
        rawGatewayPayload: {content: "should disappear", privateLink: "cdn-private"},
        rawAttachmentField: [{privateLink: "cdn-private"}],
        rawMediaUrl: "https://cdn.discordapp.com/attachments/private",
      } as DiscordMessageRequestPayload & Record<string, unknown>,
    });

    expect(request.kind).toBe("discord_message");
    expect(request.payload).toEqual({
      connectorKey: "bot-1",
      sentAt: 1_768_000_000_000,
      externalConversationId: "channel-1",
      externalActorId: "user-1",
      externalMessageId: "message-1",
      actualChannelId: "channel-1",
      attachmentSummaries: [{
        id: "attachment-1",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 123,
      }],
      media: [{
        id: "media-1",
        source: "discord",
        connectorKey: "bot-1",
        mimeType: "image/png",
        sizeBytes: 5,
        localPath: "/tmp/discord-media.png",
        originalFilename: "image.png",
        metadata: {discordAttachmentId: "attachment-1"},
        createdAt: 1,
      }],
      guildId: "guild-1",
      threadId: "thread-1",
      parentChannelId: "channel-1",
      text: "hello",
      authorUsername: "patrik",
      authorGlobalName: "Patrik Global",
      authorDisplayName: "Patrik Display",
      authorIsBot: false,
      replyToMessageId: "reply-1",
      deliveryContext: {
        discord: {
          channelId: "thread-1",
          parentChannelId: "channel-1",
          threadId: "thread-1",
          guildId: "guild-1",
          messageId: "message-1",
          referencedMessageId: "reply-1",
        },
      },
    });
    expect(request.payload).not.toHaveProperty("rawGatewayPayload");
    expect(request.payload).not.toHaveProperty("rawAttachmentField");
    expect(request.payload).not.toHaveProperty("rawMediaUrl");
    expect(JSON.stringify(request.payload)).not.toContain("cdn-private");
    expect(JSON.stringify(request.payload)).not.toContain("cdn.discordapp.com");
  });

  it("keeps discord attachmentSummaries required and defaults missing media to an empty array", async () => {
    const {repo} = createEnqueueRepo();

    const request = await repo.enqueueRequest({
      kind: "discord_message",
      payload: {
        ...validDiscordPayload({attachmentSummaries: []}),
        media: undefined,
      } as unknown as DiscordMessageRequestPayload,
    });

    expect(request.payload).toMatchObject({
      attachmentSummaries: [],
      media: [],
    });
  });

  it.each([
    ["connector key", {connectorKey: " "}, "Discord connector key"],
    ["conversation id", {externalConversationId: " "}, "Discord conversation id"],
    ["actor id", {externalActorId: " "}, "Discord actor id"],
    ["message id", {externalMessageId: " "}, "Discord message id"],
    ["actual channel id", {actualChannelId: " "}, "Discord actual channel id"],
    ["attachment summaries", {attachmentSummaries: {}}, "Discord attachment summaries must be an array"],
    ["negative attachment size", {attachmentSummaries: [{id: "attachment-1", sizeBytes: -1}]}, "Discord attachment summaries 1 size must not be negative"],
    ["non-finite attachment size", {attachmentSummaries: [{id: "attachment-1", sizeBytes: Number.POSITIVE_INFINITY}]}, "Discord attachment summaries 1 size must be a finite number"],
    ["media", {media: {}}, "Discord media must be an array"],
    ["negative media size", {media: [{id: "media-1", source: "discord", connectorKey: "bot-1", mimeType: "image/png", sizeBytes: -1, localPath: "/tmp/media.png", createdAt: 1}]}, "Discord media 1 size must not be negative"],
    ["delivery context", {deliveryContext: []}, "Discord delivery context must be a JSON object"],
    ["non-json delivery context", {deliveryContext: {bad: () => undefined}}, "Discord delivery context must be a JSON object"],
  ])("rejects malformed discord_message %s", async (_label, overrides, expected) => {
    const {pool, repo} = createEnqueueRepo();

    await expect(repo.enqueueRequest({
      kind: "discord_message",
      payload: {
        ...validDiscordPayload(),
        ...(overrides as Partial<DiscordMessageRequestPayload>),
      },
    })).rejects.toThrow(expected);

    expect(pool.query).not.toHaveBeenCalled();
  });

});
