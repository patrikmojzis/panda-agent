import {describe, expect, it, vi} from "vitest";

import {RuntimeRequestRepo} from "../src/domain/threads/requests/repo.js";
import type {DiscordMessageRequestPayload} from "../src/domain/threads/requests/types.js";

const ORDERING_KEY = `v1:${"a".repeat(64)}`;

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
    embedSummaries: [],
    stickerSummaries: [],
    media: [],
    ...overrides,
  };
}

function createEnqueueRepo() {
  const now = new Date();
  const pool = {
    connect: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[]) => {
      return {
        rows: [{
          id: String(params[0]),
          kind: params[1],
          status: "pending",
          payload: JSON.parse(String(params[2])) as unknown,
          ordering_key: params[3],
          result: null,
          error: null,
          execution_attempts: 0,
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

function createMalformedClaimRepo(payload: unknown) {
  const now = new Date();
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SET status = 'failed'")) {
      return {rows: []};
    }

    return {
      rows: [{
        id: "7a0b9429-d5bf-41dc-9224-088cff4d2137",
        kind: "telegram_message",
        status: "running",
        payload,
        ordering_key: ORDERING_KEY,
        result: null,
        error: null,
        execution_attempts: 1,
        claimed_at: now,
        claim_token: "11111111-1111-4111-8111-111111111111",
        claim_expires_at: new Date(now.getTime() + 60_000),
        finished_at: null,
        created_at: now,
        updated_at: now,
      }],
    };
  });
  const pool = {connect: vi.fn(), query};
  return {pool, repo: new RuntimeRequestRepo({pool})};
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

  it("persists the caller's idempotency key when enqueueing", async () => {
    const {pool, repo} = createEnqueueRepo();

    await repo.enqueueRequest({kind: "discord_message", payload: validDiscordPayload()}, {idempotencyKey: "live_voice_delegation:turn-1"});

    expect(pool.query.mock.calls[0]![1]![4]).toBe("live_voice_delegation:turn-1");
  });

  it("normalizes generic live voice delegation requests", async () => {
    const {repo} = createEnqueueRepo();
    const request = await repo.enqueueRequest({kind: "live_voice_delegation", payload: {
      liveVoiceTurnId: "11111111-1111-4111-8111-111111111111",
      sessionId: "session-1",
    }});
    expect(request).toMatchObject({kind: "live_voice_delegation", payload: {
      liveVoiceTurnId: "11111111-1111-4111-8111-111111111111",
      sessionId: "session-1",
    }});
  });

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
      ordering_key: ORDERING_KEY,
      result: null,
      error: null,
      execution_attempts: 1,
      claimed_at: claimedAt,
      finished_at: null,
      created_at: claimedAt,
      updated_at: claimedAt,
    };
    const pool = {
      connect: vi.fn(),
      query: vi.fn(async () => ({rows: [{
        ...row,
        claim_token: "11111111-1111-4111-8111-111111111111",
        claim_expires_at: new Date(Date.now() + 123_456),
      }]})),
    };
    const repo = new RuntimeRequestRepo({
      pool,
      claimLeaseMs: 123_456,
    });

    const claimed = await repo.claimNextPendingRequest();

    expect(claimed).toMatchObject({
      id: row.id,
      status: "running",
      payload: row.payload,
    });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("status = 'running'"), [
      expect.any(String),
      123_456,
    ]);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("claim_expires_at <= NOW()"), [
      expect.any(String),
      123_456,
    ]);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("returns an unfinished claim to the pending queue with the same token fence", async () => {
    const query = vi.fn(async () => ({rows: [{id: "request-1"}]}));
    const repo = new RuntimeRequestRepo({pool: {connect: vi.fn(), query}});

    await expect(repo.releaseRequestClaim(
      "request-1",
      "11111111-1111-4111-8111-111111111111",
    )).resolves.toBe(true);

    expect(query).toHaveBeenCalledWith(expect.stringMatching(/SET status = 'pending'[\s\S]*claimed_at = NULL[\s\S]*claim_token = NULL/), [
      "request-1",
      "11111111-1111-4111-8111-111111111111",
      "runtime_request_events",
    ]);
  });

  it("loads session compaction requests without requiring custom instructions", async () => {
    const now = new Date();
    const repo = new RuntimeRequestRepo({
      pool: {
        connect: vi.fn(),
        query: vi.fn(async () => ({
          rows: [{
            id: "7a0b9429-d5bf-41dc-9224-088cff4d2137",
            kind: "compact_session",
            status: "pending",
            payload: {sessionId: "session-1", customInstructions: ""},
            ordering_key: ORDERING_KEY,
            result: null,
            error: null,
            execution_attempts: 0,
            claimed_at: null,
            finished_at: null,
            created_at: now,
            updated_at: now,
          }],
        })),
      },
    });

    await expect(repo.getRequest("7a0b9429-d5bf-41dc-9224-088cff4d2137"))
      .resolves.toMatchObject({
        kind: "compact_session",
        payload: {sessionId: "session-1", customInstructions: ""},
      });
  });

  it("quarantines malformed persisted payloads after claiming them", async () => {
    const {pool, repo} = createMalformedClaimRepo({connectorKey: "bot-1"});

    await expect(repo.claimNextPendingRequest()).rejects.toThrow("Telegram conversation id");

    expect(pool.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'failed'"))).toBe(true);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("quarantines driver-shaped numeric payload fields after claiming them", async () => {
    const {pool, repo} = createMalformedClaimRepo({
      ...validTelegramPayload,
      sentAt: "1",
    });

    await expect(repo.claimNextPendingRequest()).rejects.toThrow(
      "Runtime request Telegram sent timestamp must be a finite number.",
    );
    expect(pool.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'failed'"))).toBe(true);
  });

  it("quarantines object-shaped optional string payload fields after claiming them", async () => {
    const {pool, repo} = createMalformedClaimRepo({
      ...validTelegramPayload,
      username: {bad: true},
    });

    await expect(repo.claimNextPendingRequest()).rejects.toThrow(
      "Runtime request optional string field must be a string.",
    );
    expect(pool.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'failed'"))).toBe(true);
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
            execution_attempts: 0,
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
            execution_attempts: 0,
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
      identityId: undefined,
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
        status: "downloaded",
      }],
      embedSummaries: [],
      stickerSummaries: [],
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

  it("defaults legacy Discord attachment status from matching durable media", async () => {
    const {repo} = createEnqueueRepo();
    const withoutMedia = await repo.enqueueRequest({
      kind: "discord_message",
      payload: validDiscordPayload({
        attachmentSummaries: [{id: "attachment-metadata", filename: "photo.jpeg"}] as never,
        media: [],
      }),
    });
    expect(withoutMedia.payload.attachmentSummaries).toEqual([{
      id: "attachment-metadata",
      filename: "photo.jpeg",
      status: "metadata_only",
    }]);

    const withMedia = await repo.enqueueRequest({
      kind: "discord_message",
      payload: validDiscordPayload({
        attachmentSummaries: [{id: "attachment-downloaded", filename: "photo.jpeg"}] as never,
        media: [{
          id: "media-legacy",
          source: "discord",
          connectorKey: "bot-1",
          mimeType: "image/jpeg",
          sizeBytes: 5,
          localPath: "/tmp/photo.jpg",
          metadata: {discordAttachmentId: "attachment-downloaded"},
          createdAt: 1,
        }],
      }),
    });
    expect(withMedia.payload.attachmentSummaries[0]).toMatchObject({status: "downloaded"});
  });

  it.each([
    ["connector key", {connectorKey: " "}, "Discord connector key"],
    ["conversation id", {externalConversationId: " "}, "Discord conversation id"],
    ["actor id", {externalActorId: " "}, "Discord actor id"],
    ["message id", {externalMessageId: " "}, "Discord message id"],
    ["actual channel id", {actualChannelId: " "}, "Discord actual channel id"],
    ["attachment summaries", {attachmentSummaries: {}}, "Discord attachment summaries must be an array"],
    ["embed summaries", {embedSummaries: {}}, "Discord embed summaries must be an array"],
    ["sticker summaries", {stickerSummaries: "bad"}, "Discord sticker summaries must be an array"],
    ["attachment HTTP status", {attachmentSummaries: [{id: "attachment-1", status: "failed", reason: "http_error", httpStatus: 999}]}, "Discord attachment summaries 1 HTTP status is invalid"],
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
