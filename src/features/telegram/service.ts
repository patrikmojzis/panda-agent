import { createHash } from "node:crypto";

import { AbortController } from "abort-controller";
import { Bot, type Context } from "grammy";

import { stringToUserMessage, type ProviderName } from "../agent-core/index.js";
import { ChannelOutboundDispatcher } from "../channels/core/index.js";
import type { JsonObject } from "../agent-core/types.js";
import type { MediaDescriptor } from "../channels/core/types.js";
import { createDefaultIdentityInput, type IdentityBindingRecord } from "../identity/types.js";
import type { ThreadRecord } from "../thread-runtime/types.js";
import {
  TELEGRAM_POLL_TIMEOUT_SECONDS,
  TELEGRAM_SOURCE,
  TELEGRAM_UPDATES_CURSOR_KEY,
} from "./config.js";
import {
  buildTelegramConversationId,
  buildTelegramInboundText,
  buildTelegramStartText,
  normalizeTelegramCommand,
} from "./helpers.js";
import { createTelegramOutboundAdapter } from "./outbound.js";
import { createTelegramRuntime, type TelegramRuntimeServices } from "./runtime.js";

type TelegramContext = Context;
const UPDATE_RETRY_DELAY_MS = 1_000;

export interface TelegramServiceOptions {
  token: string;
  dataDir: string;
  cwd: string;
  locale: string;
  timezone: string;
  instructions?: string;
  provider?: ProviderName;
  model?: string;
  tablePrefix?: string;
  defaultIdentityHandle?: string;
}

interface ConnectorLock {
  release(): Promise<void>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function hashConnectorLockKey(source: string, connectorKey: string): readonly [number, number] {
  const digest = createHash("sha256").update(`${source}:${connectorKey}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)] as const;
}

function messageTextLength(message: TelegramContext["msg"] | undefined): number {
  const text = message?.text ?? message?.caption ?? "";
  return text.trim().length;
}

function serializeMediaDescriptor(descriptor: MediaDescriptor): JsonObject {
  return {
    id: descriptor.id,
    source: descriptor.source,
    connectorKey: descriptor.connectorKey,
    mimeType: descriptor.mimeType,
    sizeBytes: descriptor.sizeBytes,
    localPath: descriptor.localPath,
    originalFilename: descriptor.originalFilename ?? null,
    metadata: descriptor.metadata ?? null,
    createdAt: descriptor.createdAt,
  };
}

export class TelegramService {
  private readonly bot: Bot<TelegramContext>;
  private readonly token: string;
  private readonly provider?: ProviderName;
  private readonly model?: string;
  private readonly defaultIdentityHandle: string;
  private readonly runtimeOptions: Omit<TelegramServiceOptions, "token" | "defaultIdentityHandle">;
  private runtimePromise: Promise<TelegramRuntimeServices> | null = null;
  private runtime: TelegramRuntimeServices | null = null;
  private botId: string | null = null;
  private connectorKey: string | null = null;
  private botUsername: string | null = null;
  private lock: ConnectorLock | null = null;
  private pollAbortController: AbortController | null = null;
  private stopping = false;

  constructor(options: TelegramServiceOptions) {
    this.token = options.token;
    this.provider = options.provider;
    this.model = options.model;
    this.defaultIdentityHandle = options.defaultIdentityHandle ?? "local";
    this.runtimeOptions = {
      dataDir: options.dataDir,
      cwd: options.cwd,
      locale: options.locale,
      timezone: options.timezone,
      instructions: options.instructions,
      provider: options.provider,
      model: options.model,
      tablePrefix: options.tablePrefix,
    };
    this.bot = new Bot<TelegramContext>(options.token);

    this.bot.on("message", async (ctx) => {
      await this.handleMessage(ctx);
    });
  }

  private log(event: string, payload: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify({
      source: TELEGRAM_SOURCE,
      event,
      timestamp: new Date().toISOString(),
      ...payload,
    })}\n`);
  }

  private async ensureBotIdentity(): Promise<{
    id: string;
    connectorKey: string;
    botUsername: string | null;
  }> {
    if (this.botId && this.connectorKey) {
      return {
        id: this.botId,
        connectorKey: this.connectorKey,
        botUsername: this.botUsername,
      };
    }

    const me = await this.bot.api.getMe();
    this.bot.botInfo = me;
    const id = String(me.id);
    this.botId = id;
    this.connectorKey = id;
    this.botUsername = me.username ?? null;

    return {
      id,
      connectorKey: id,
      botUsername: this.botUsername,
    };
  }

  private async ensureRuntime(): Promise<TelegramRuntimeServices> {
    if (this.runtime) {
      return this.runtime;
    }

    if (!this.runtimePromise) {
      const { connectorKey } = await this.ensureBotIdentity();
      this.runtimePromise = createTelegramRuntime({
        ...this.runtimeOptions,
        outboundDispatcher: new ChannelOutboundDispatcher([
          createTelegramOutboundAdapter({
            api: this.bot.api,
            connectorKey,
          }),
        ]),
      });
    }

    this.runtime = await this.runtimePromise;
    return this.runtime;
  }

  private async ensureInitialized(): Promise<{
    runtime: TelegramRuntimeServices;
    connectorKey: string;
    botUsername: string | null;
  }> {
    const { connectorKey, botUsername } = await this.ensureBotIdentity();
    const runtime = await this.ensureRuntime();

    return {
      runtime,
      connectorKey,
      botUsername,
    };
  }

  async whoami(): Promise<{
    connectorKey: string;
    id: string;
    username?: string;
  }> {
    const { connectorKey, id, botUsername } = await this.ensureBotIdentity();
    return {
      connectorKey,
      id,
      username: botUsername ?? undefined,
    };
  }

  async pair(identityHandle: string, actorId: string): Promise<IdentityBindingRecord> {
    const { runtime, connectorKey } = await this.ensureInitialized();
    const defaultIdentity = createDefaultIdentityInput();
    const identity = identityHandle === this.defaultIdentityHandle
      ? await runtime.identityStore.ensureIdentity(defaultIdentity)
      : await runtime.identityStore.getIdentityByHandle(identityHandle);

    return runtime.identityStore.ensureIdentityBinding({
      source: TELEGRAM_SOURCE,
      connectorKey,
      externalActorId: actorId,
      identityId: identity.id,
      metadata: {
        pairedVia: "telegram-cli",
      },
    });
  }

  async run(): Promise<void> {
    try {
      const { runtime, connectorKey, botUsername } = await this.ensureInitialized();
      await this.bot.api.setMyCommands([
        { command: "start", description: "Pair this Telegram account with Panda" },
        { command: "new", description: "Start a fresh Panda thread" },
      ]);
      this.lock = await this.acquireConnectorLock(connectorKey, runtime);
      this.log("run_started", {
        connectorKey,
        botUsername,
        provider: this.provider ?? null,
        model: this.model ?? null,
        cwd: this.runtimeOptions.cwd,
        dataDir: this.runtimeOptions.dataDir,
      });

      while (!this.stopping) {
        const nextOffset = await this.readNextUpdateOffset(runtime, connectorKey);
        this.pollAbortController = new AbortController();

        let updates;
        try {
          updates = await this.bot.api.getUpdates({
            offset: nextOffset,
            timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
            allowed_updates: ["message"],
          }, this.pollAbortController.signal);
        } catch (error) {
          if (this.stopping && isAbortError(error)) {
            break;
          }

          if (isAbortError(error)) {
            continue;
          }

          this.log("poll_error", {
            connectorKey,
            message: error instanceof Error ? error.message : String(error),
          });
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        } finally {
          this.pollAbortController = null;
        }

        if (updates.length > 0) {
          this.log("updates_received", {
            connectorKey,
            count: updates.length,
            firstUpdateId: updates[0]?.update_id ?? null,
            lastUpdateId: updates.at(-1)?.update_id ?? null,
          });
        }

        for (const update of updates) {
          if (this.stopping) {
            break;
          }

          try {
            // Only advance the Telegram cursor after the update finished end-to-end.
            await this.bot.handleUpdate(update);
            await runtime.channelCursors.upsertChannelCursor({
              source: TELEGRAM_SOURCE,
              connectorKey,
              cursorKey: TELEGRAM_UPDATES_CURSOR_KEY,
              value: String(update.update_id),
            });
          } catch (error) {
            this.log("update_error", {
              connectorKey,
              updateId: update.update_id,
              message: error instanceof Error ? error.message : String(error),
            });

            if (!this.stopping) {
              await new Promise((resolve) => setTimeout(resolve, UPDATE_RETRY_DELAY_MS));
            }
            break;
          }
        }
      }
    } finally {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.pollAbortController?.abort();
    this.pollAbortController = null;

    if (this.lock) {
      await this.lock.release();
      this.lock = null;
    }

    const runtime = this.runtime;
    const runtimePromise = this.runtimePromise;
    this.runtime = null;
    this.runtimePromise = null;

    if (runtime) {
      await runtime.close();
      return;
    }

    if (runtimePromise) {
      try {
        const resolvedRuntime = await runtimePromise;
        await resolvedRuntime.close();
      } catch {
        // Ignore bootstrap failures during shutdown.
      }
    }
  }

  private async acquireConnectorLock(
    connectorKey: string,
    runtime: TelegramRuntimeServices,
  ): Promise<ConnectorLock> {
    const client = await runtime.pool.connect();
    const [keyA, keyB] = hashConnectorLockKey(TELEGRAM_SOURCE, connectorKey);

    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [keyA, keyB],
      );
      const acquired = Boolean((result.rows[0] as Record<string, unknown> | undefined)?.acquired);
      if (!acquired) {
        throw new Error(`Telegram connector ${connectorKey} is already running.`);
      }

      let released = false;
      return {
        release: async () => {
          if (released) {
            return;
          }

          released = true;
          try {
            await client.query("SELECT pg_advisory_unlock($1, $2)", [keyA, keyB]);
          } finally {
            client.release();
          }
        },
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }

  private async readNextUpdateOffset(runtime: TelegramRuntimeServices, connectorKey: string): Promise<number | undefined> {
    const cursor = await runtime.channelCursors.resolveChannelCursor({
      source: TELEGRAM_SOURCE,
      connectorKey,
      cursorKey: TELEGRAM_UPDATES_CURSOR_KEY,
    });
    if (!cursor) {
      return undefined;
    }

    const parsed = Number.parseInt(cursor.value, 10);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }

    return parsed + 1;
  }

  private async handleMessage(ctx: TelegramContext): Promise<void> {
    const { runtime, connectorKey, botUsername } = await this.ensureInitialized();
    const message = ctx.msg;
    const chatType = ctx.chat?.type ?? null;
    const actorId = ctx.from?.id ? String(ctx.from.id) : null;
    const externalConversationId = buildTelegramConversationId(
      String(ctx.chat?.id ?? "unknown"),
      message && "message_thread_id" in message && typeof message.message_thread_id === "number"
        ? String(message.message_thread_id)
        : undefined,
    );

    if (chatType !== "private") {
      this.log("message_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "group_support_not_enabled",
      });
      return;
    }

    if (!message || !actorId) {
      this.log("message_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "missing_actor_or_message",
      });
      return;
    }

    const command = normalizeTelegramCommand(message.text, botUsername);
    if (command === "start") {
      await ctx.reply(
        buildTelegramStartText({
          actorId,
          defaultIdentityHandle: this.defaultIdentityHandle,
        }),
        { parse_mode: "HTML" },
      );
      return;
    }

    const binding = await runtime.identityStore.resolveIdentityBinding({
      source: TELEGRAM_SOURCE,
      connectorKey,
      externalActorId: actorId,
    });

    if (!binding) {
      this.log("message_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "unpaired_actor",
        messageLength: messageTextLength(message),
      });
      return;
    }

    if (command === "new") {
      await this.handleNewCommand(ctx, binding, externalConversationId);
      return;
    }

    const media = await this.downloadSupportedMedia(message, runtime);

    const rawText = (message.text ?? message.caption)?.trim() ?? "";
    if (!rawText && media.length === 0) {
      this.log("message_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "unsupported_message_shape",
      });
      return;
    }

    const text = buildTelegramInboundText({
      connectorKey,
      externalConversationId,
      externalActorId: actorId,
      externalMessageId: String(message.message_id),
      chatId: String(message.chat.id),
      chatType,
      text: rawText,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
      replyToMessageId: message.reply_to_message?.message_id
        ? String(message.reply_to_message.message_id)
      : undefined,
      media,
    });

    const thread = await this.resolveOrCreateThread(binding, externalConversationId, message.chat.id);
    if (!thread) {
      this.log("message_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "conversation_identity_mismatch",
      });
      return;
    }

    await runtime.coordinator.submitInput(thread.id, {
      source: TELEGRAM_SOURCE,
      channelId: externalConversationId,
      externalMessageId: String(message.message_id),
      actorId,
      message: stringToUserMessage(text),
      metadata: {
        route: {
          source: TELEGRAM_SOURCE,
          connectorKey,
          externalConversationId,
          externalActorId: actorId,
          externalMessageId: String(message.message_id),
        },
        telegram: {
          chatId: String(message.chat.id),
          chatType,
          messageId: message.message_id,
          username: ctx.from?.username ?? null,
          firstName: ctx.from?.first_name ?? null,
          lastName: ctx.from?.last_name ?? null,
          media: media.map((descriptor) => serializeMediaDescriptor(descriptor)),
        },
      },
    });

    this.log("message_ingested", {
      connectorKey,
      externalActorId: actorId,
      externalConversationId,
      chatType,
      threadId: thread.id,
      externalMessageId: String(message.message_id),
      mediaCount: media.length,
      textLength: text.trim().length,
    });
  }

  private async handleNewCommand(
    ctx: TelegramContext,
    binding: IdentityBindingRecord,
    externalConversationId: string,
  ): Promise<void> {
    const { runtime, connectorKey } = await this.ensureInitialized();
    const existing = await runtime.conversationThreads.resolveConversationThread({
      source: TELEGRAM_SOURCE,
      connectorKey,
      externalConversationId,
    });
    const previousThreadId = existing?.threadId ?? null;

    if (existing) {
      await runtime.coordinator.abort(existing.threadId, "Telegram /new requested.");
      await runtime.coordinator.waitForCurrentRun(existing.threadId);
    }

    const latestBinding = await runtime.identityStore.resolveIdentityBinding({
      source: TELEGRAM_SOURCE,
      connectorKey,
      externalActorId: binding.externalActorId,
    });
    if (!latestBinding) {
      this.log("message_dropped", {
        connectorKey,
        externalActorId: binding.externalActorId,
        externalConversationId,
        chatType: "private",
        reason: "binding_missing_during_new",
      });
      return;
    }

    const thread = await runtime.createThread({
      identityId: latestBinding.identityId,
      provider: this.provider,
      model: this.model,
      context: {
        source: TELEGRAM_SOURCE,
      },
    });

    await runtime.conversationThreads.bindConversationThread({
      source: TELEGRAM_SOURCE,
      connectorKey,
      externalConversationId,
      threadId: thread.id,
      metadata: {
        chatType: "private",
      },
    });

    this.log("thread_rotated", {
      connectorKey,
      externalActorId: binding.externalActorId,
      externalConversationId,
      previousThreadId,
      threadId: thread.id,
    });

    await ctx.reply("Started a fresh Panda thread.");
  }

  private async resolveOrCreateThread(
    binding: IdentityBindingRecord,
    externalConversationId: string,
    chatId: number,
  ): Promise<ThreadRecord | null> {
    const { runtime, connectorKey } = await this.ensureInitialized();
    const existing = await runtime.conversationThreads.resolveConversationThread({
      source: TELEGRAM_SOURCE,
      connectorKey,
      externalConversationId,
    });

    if (existing) {
      const thread = await runtime.getThread(existing.threadId);
      if (thread.identityId !== binding.identityId) {
        return null;
      }

      return thread;
    }

    const thread = await runtime.createThread({
      identityId: binding.identityId,
      provider: this.provider,
      model: this.model,
      context: {
        source: TELEGRAM_SOURCE,
        chatId: String(chatId),
      },
    });

    await runtime.conversationThreads.bindConversationThread({
      source: TELEGRAM_SOURCE,
      connectorKey,
      externalConversationId,
      threadId: thread.id,
      metadata: {
        chatType: "private",
        actorId: binding.externalActorId,
      },
    });

    this.log("thread_bound", {
      connectorKey,
      externalActorId: binding.externalActorId,
      externalConversationId,
      threadId: thread.id,
      created: true,
    });

    return thread;
  }

  private async downloadSupportedMedia(
    message: TelegramContext["msg"],
    runtime: TelegramRuntimeServices,
  ): Promise<readonly MediaDescriptor[]> {
    if (!message) {
      return [];
    }

    const descriptors: MediaDescriptor[] = [];

    const photo = message.photo?.at(-1);
    if (photo) {
      descriptors.push(await this.downloadFile({
        runtime,
        fileId: photo.file_id,
        mimeType: "image/jpeg",
        sizeBytes: photo.file_size,
      }));
    }

    if (message.document) {
      descriptors.push(await this.downloadFile({
        runtime,
        fileId: message.document.file_id,
        mimeType: message.document.mime_type ?? "application/octet-stream",
        sizeBytes: message.document.file_size,
        hintFilename: message.document.file_name,
      }));
    }

    if (message.voice) {
      descriptors.push(await this.downloadFile({
        runtime,
        fileId: message.voice.file_id,
        mimeType: message.voice.mime_type ?? "audio/ogg",
        sizeBytes: message.voice.file_size,
      }));
    }

    return descriptors;
  }

  private async downloadFile(options: {
    runtime: TelegramRuntimeServices;
    fileId: string;
    mimeType: string;
    sizeBytes?: number;
    hintFilename?: string;
  }): Promise<MediaDescriptor> {
    const file = await this.bot.api.getFile(options.fileId);
    if (!file.file_path) {
      throw new Error(`Telegram file ${options.fileId} has no file_path.`);
    }

    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file ${options.fileId}: ${response.status} ${response.statusText}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    return options.runtime.mediaStore.writeMedia({
      bytes,
      source: TELEGRAM_SOURCE,
      connectorKey: this.connectorKey ?? "unknown",
      mimeType: options.mimeType,
      sizeBytes: options.sizeBytes,
      hintFilename: options.hintFilename,
      metadata: {
        telegramFileId: options.fileId,
        telegramFilePath: file.file_path,
      },
    });
  }
}
