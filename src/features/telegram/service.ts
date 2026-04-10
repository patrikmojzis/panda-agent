import {createHash} from "node:crypto";

import {AbortController} from "abort-controller";
import {Bot, type Context} from "grammy";

import {type ProviderName, stringToUserMessage} from "../agent-core/index.js";
import type {JsonObject} from "../agent-core/types.js";
import {ChannelOutboundDeliveryWorker} from "../outbound-deliveries/index.js";
import {ChannelTypingDispatcher} from "../channels/core/index.js";
import type {MediaDescriptor} from "../channels/core/types.js";
import type {ConversationThreadRecord} from "../conversation-threads/types.js";
import type {IdentityBindingRecord} from "../identity/types.js";
import {isMissingThreadError, type ThreadRecord} from "../thread-runtime/types.js";
import {TELEGRAM_POLL_TIMEOUT_SECONDS, TELEGRAM_SOURCE, TELEGRAM_UPDATES_CURSOR_KEY,} from "./config.js";
import {
    buildTelegramConversationId,
    buildTelegramInboundPersistence,
    buildTelegramInboundText,
    buildTelegramReactionText,
    buildTelegramStartText,
    normalizeTelegramCommand,
} from "./helpers.js";
import {createTelegramOutboundAdapter} from "./outbound.js";
import {createTelegramTypingAdapter} from "./typing.js";
import {createTelegramRuntime, type TelegramRuntimeServices} from "./runtime.js";

type TelegramContext = Context;
const UPDATE_RETRY_DELAY_MS = 1_000;

interface TelegramResetReceiptMetadata extends JsonObject {
  kind: "telegram_reset_receipt";
  commandExternalMessageId: string;
}

function createTelegramResetReceiptMetadata(commandExternalMessageId: string): TelegramResetReceiptMetadata {
  return {
    kind: "telegram_reset_receipt",
    commandExternalMessageId,
  };
}

function parseTelegramResetReceiptMetadata(
  value: ConversationThreadRecord["metadata"],
): TelegramResetReceiptMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const kind = "kind" in value ? value.kind : undefined;
  const commandExternalMessageId = "commandExternalMessageId" in value ? value.commandExternalMessageId : undefined;
  if (kind !== "telegram_reset_receipt" || typeof commandExternalMessageId !== "string" || !commandExternalMessageId.trim()) {
    return null;
  }

  return {
    kind,
    commandExternalMessageId,
  };
}

export interface TelegramServiceOptions {
  token: string;
  dataDir: string;
  cwd: string;
  dbUrl?: string;
  readOnlyDbUrl?: string;
  provider?: ProviderName;
  model?: string;
  agent?: string;
  tablePrefix?: string;
  defaultIdentityHandle?: string;
}

interface ConnectorLock {
  release(): Promise<void>;
}

interface TelegramReactionUpdateUser {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

interface TelegramEmojiReaction {
  type: "emoji";
  emoji: string;
}

interface TelegramReactionContextLike {
  update?: {
    update_id?: number;
  };
  messageReaction?: {
    chat: {
      id: number;
      type?: string;
    };
    message_id: number;
    user?: TelegramReactionUpdateUser;
    old_reaction: readonly unknown[];
    new_reaction: readonly unknown[];
  };
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

function isTelegramEmojiReaction(value: unknown): value is TelegramEmojiReaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.type === "emoji" && typeof candidate.emoji === "string" && candidate.emoji.trim().length > 0;
}

export class TelegramService {
  private readonly bot: Bot<TelegramContext>;
  private readonly token: string;
  private readonly defaultIdentityHandle: string;
  private readonly runtimeOptions: Omit<TelegramServiceOptions, "token" | "defaultIdentityHandle">;
  private runtimePromise: Promise<TelegramRuntimeServices> | null = null;
  private runtime: TelegramRuntimeServices | null = null;
  private botId: string | null = null;
  private connectorKey: string | null = null;
  private botUsername: string | null = null;
  private lock: ConnectorLock | null = null;
  private pollAbortController: AbortController | null = null;
  private outboundWorker: ChannelOutboundDeliveryWorker | null = null;
  private stopping = false;

  constructor(options: TelegramServiceOptions) {
    this.token = options.token;
    this.defaultIdentityHandle = options.defaultIdentityHandle ?? "local";
    this.runtimeOptions = {
      dataDir: options.dataDir,
      cwd: options.cwd,
      dbUrl: options.dbUrl,
      readOnlyDbUrl: options.readOnlyDbUrl,
      provider: options.provider,
      model: options.model,
      agent: options.agent,
      tablePrefix: options.tablePrefix,
    };
    this.bot = new Bot<TelegramContext>(options.token);

    this.bot.on("message", async (ctx) => {
      await this.handleMessage(ctx);
    });
    this.bot.on("message_reaction", async (ctx) => {
      await this.handleMessageReaction(ctx as TelegramReactionContextLike);
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
        telegramConnectorKey: connectorKey,
        telegramReactionApi: this.bot.api,
        typingDispatcher: new ChannelTypingDispatcher([
          createTelegramTypingAdapter({
            api: this.bot.api,
            connectorKey,
          }),
        ]),
      });
    }

    this.runtime = await this.runtimePromise;
    return this.runtime;
  }

  private ensureOutboundWorker(runtime: TelegramRuntimeServices, connectorKey: string): ChannelOutboundDeliveryWorker {
    if (this.outboundWorker) {
      return this.outboundWorker;
    }

    this.outboundWorker = new ChannelOutboundDeliveryWorker({
      store: runtime.outboundDeliveries,
      adapter: createTelegramOutboundAdapter({
        api: this.bot.api,
        connectorKey,
      }),
      connectorKey,
      onError: (error, deliveryId) => {
        this.log("outbound_delivery_failed", {
          connectorKey,
          deliveryId: deliveryId ?? null,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });

    return this.outboundWorker;
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

  async run(): Promise<void> {
    this.stopping = false;

    try {
      const { runtime, connectorKey, botUsername } = await this.ensureInitialized();
      this.lock = await this.acquireConnectorLock(connectorKey, runtime);
      await this.ensureOutboundWorker(runtime, connectorKey).start();
      await this.bot.api.setMyCommands([
        { command: "start", description: "Pair this Telegram account with Panda" },
        { command: "reset", description: "Reset Panda to a fresh empty home thread" },
      ]);
      this.log("run_started", {
        connectorKey,
        botUsername,
        provider: this.runtimeOptions.provider ?? null,
        model: this.runtimeOptions.model ?? null,
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
            allowed_updates: ["message", "message_reaction"],
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

    if (this.outboundWorker) {
      await this.outboundWorker.stop();
      this.outboundWorker = null;
    }

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

  private async handleMessageReaction(ctx: TelegramReactionContextLike): Promise<void> {
    const { runtime, connectorKey } = await this.ensureInitialized();
    const reaction = ctx.messageReaction;
    const chatId = reaction?.chat.id;
    const chatType = reaction?.chat.type ?? null;
    const updateId = ctx.update?.update_id;
    const actorId = reaction?.user?.id != null ? String(reaction.user.id) : null;
    const externalConversationId = buildTelegramConversationId(
      String(chatId ?? "unknown"),
    );

    if (!reaction || typeof chatId !== "number") {
      this.log("reaction_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "missing_reaction_payload",
      });
      return;
    }

    if (chatType !== "private") {
      this.log("reaction_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "group_support_not_enabled",
      });
      return;
    }

    if (typeof updateId !== "number" || !Number.isInteger(updateId)) {
      this.log("reaction_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "missing_update_id",
      });
      return;
    }

    if (!actorId) {
      this.log("reaction_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "missing_actor",
      });
      return;
    }

    if (reaction.user?.is_bot) {
      this.log("reaction_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "bot_actor",
      });
      return;
    }

    const oldEmojis = new Set(
      reaction.old_reaction
        .filter(isTelegramEmojiReaction)
        .map((entry) => entry.emoji.trim()),
    );
    const addedEmojis = reaction.new_reaction
      .filter(isTelegramEmojiReaction)
      .map((entry) => entry.emoji.trim())
      .filter((emoji) => emoji && !oldEmojis.has(emoji));

    if (addedEmojis.length === 0) {
      return;
    }

    const binding = await runtime.identityStore.resolveIdentityBinding({
      source: TELEGRAM_SOURCE,
      connectorKey,
      externalActorId: actorId,
    });

    if (!binding) {
      this.log("reaction_dropped", {
        connectorKey,
        externalActorId: actorId,
        externalConversationId,
        chatType,
        reason: "unpaired_actor",
      });
      return;
    }

    const targetMessageId = String(reaction.message_id);
    const syntheticExternalMessageId = `telegram-reaction:${updateId}`;
    const text = buildTelegramReactionText({
      connectorKey,
      externalConversationId,
      externalActorId: actorId,
      externalMessageId: syntheticExternalMessageId,
      chatId: String(chatId),
      chatType,
      username: reaction.user?.username,
      firstName: reaction.user?.first_name,
      lastName: reaction.user?.last_name,
      targetMessageId,
      addedEmojis,
    });
    const persistence = buildTelegramInboundPersistence({
      connectorKey,
      externalConversationId,
      externalActorId: actorId,
      externalMessageId: syntheticExternalMessageId,
      chatId: String(chatId),
      chatType,
      messageId: null,
      username: reaction.user?.username,
      firstName: reaction.user?.first_name,
      lastName: reaction.user?.last_name,
      media: [],
      reaction: {
        updateId,
        targetMessageId,
        addedEmojis,
        actorId,
        username: reaction.user?.username,
      },
    });

    const thread = await this.resolveOrCreateThread(binding, externalConversationId, chatId);
    if (!thread) {
      this.log("reaction_dropped", {
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
      externalMessageId: syntheticExternalMessageId,
      actorId,
      message: stringToUserMessage(text),
      metadata: persistence.metadata,
    });
    await runtime.homeThreads.rememberLastRoute({
      identityId: thread.identityId,
      agentKey: thread.agentKey,
      route: persistence.rememberedRoute,
    });

    this.log("reaction_ingested", {
      connectorKey,
      externalActorId: actorId,
      externalConversationId,
      chatType,
      threadId: thread.id,
      externalMessageId: syntheticExternalMessageId,
      targetMessageId,
      addedEmojis,
    });
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
      await ctx.reply("<code>/new</code> is TUI-only. Use <code>/reset</code> here to start fresh.", {
        parse_mode: "HTML",
      });
      return;
    }

    if (command === "reset") {
      await this.handleResetCommand(ctx, binding, externalConversationId);
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
    const persistence = buildTelegramInboundPersistence({
      connectorKey,
      externalConversationId,
      externalActorId: actorId,
      externalMessageId: String(message.message_id),
      chatId: String(message.chat.id),
      chatType,
      messageId: message.message_id,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lastName: ctx.from?.last_name,
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
      metadata: persistence.metadata,
    });
    await runtime.homeThreads.rememberLastRoute({
      identityId: thread.identityId,
      agentKey: thread.agentKey,
      route: persistence.rememberedRoute,
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

  private async handleResetCommand(
    ctx: TelegramContext,
    binding: IdentityBindingRecord,
    externalConversationId: string,
  ): Promise<void> {
    const { runtime, connectorKey } = await this.ensureInitialized();
    const chatId = ctx.chat?.id;
    const commandExternalMessageId = ctx.msg?.message_id ? String(ctx.msg.message_id) : null;
    if (chatId === undefined) {
      this.log("message_dropped", {
        connectorKey,
        externalActorId: binding.externalActorId,
        externalConversationId,
        chatType: "private",
        reason: "missing_chat_on_reset",
      });
      return;
    }
    if (!commandExternalMessageId) {
      this.log("message_dropped", {
        connectorKey,
        externalActorId: binding.externalActorId,
        externalConversationId,
        chatType: "private",
        reason: "missing_message_id_on_reset",
      });
      return;
    }

    const replayedReset = await this.resolveRetriedResetThread({
      runtime,
      connectorKey,
      identityId: binding.identityId,
      externalConversationId,
      commandExternalMessageId,
    });
    if (replayedReset) {
      this.log("thread_reset_replayed", {
        connectorKey,
        externalActorId: binding.externalActorId,
        externalConversationId,
        commandExternalMessageId,
        homeThreadId: replayedReset.id,
      });
      await ctx.reply("Reset Panda. Fresh home thread started.");
      return;
    }

    const previousHome = await this.resolveExistingHomeThread(runtime, binding.identityId);
    const threadsToAbort = previousHome ? [previousHome.id] : [];
    for (const threadId of threadsToAbort) {
      await runtime.coordinator.abort(threadId, "Telegram /reset requested.");
    }
    for (const threadId of threadsToAbort) {
      await runtime.coordinator.waitForCurrentRun(threadId);
    }
    for (const threadId of threadsToAbort) {
      await runtime.store.discardPendingInputs(threadId);
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
      provider: this.runtimeOptions.provider,
      model: this.runtimeOptions.model,
      context: {
        source: TELEGRAM_SOURCE,
        chatId: String(chatId),
      },
    });
    // Reset mutates state outside the usual deduped input path, so keep a
    // receipt keyed by the Telegram command message before we reply.
    await runtime.conversationThreads.bindConversationThread({
      source: TELEGRAM_SOURCE,
      connectorKey,
      externalConversationId,
      threadId: thread.id,
      metadata: createTelegramResetReceiptMetadata(commandExternalMessageId),
    });
    await runtime.setHomeThread(thread.id, thread.agentKey);
    await runtime.homeThreads.rememberLastRoute({
      identityId: thread.identityId,
      agentKey: thread.agentKey,
      route: {
        source: TELEGRAM_SOURCE,
        connectorKey,
        externalConversationId,
        externalActorId: binding.externalActorId,
        externalMessageId: commandExternalMessageId,
        capturedAt: Date.now(),
      },
    });

    this.log("thread_reset", {
      connectorKey,
      externalActorId: binding.externalActorId,
      externalConversationId,
      commandExternalMessageId,
      previousThreadId: previousHome?.id ?? null,
      previousHomeThreadId: previousHome?.id ?? null,
      homeThreadId: thread.id,
    });

    await ctx.reply("Reset Panda. Fresh home thread started.");
  }

  private async resolveRetriedResetThread(options: {
    runtime: TelegramRuntimeServices;
    connectorKey: string;
    identityId: string;
    externalConversationId: string;
    commandExternalMessageId: string;
  }): Promise<ThreadRecord | null> {
    const existing = await options.runtime.conversationThreads.resolveConversationThread({
      source: TELEGRAM_SOURCE,
      connectorKey: options.connectorKey,
      externalConversationId: options.externalConversationId,
    });
    const receipt = parseTelegramResetReceiptMetadata(existing?.metadata);
    if (!existing || !receipt || receipt.commandExternalMessageId !== options.commandExternalMessageId) {
      return null;
    }

    const currentHome = await this.resolveExistingHomeThread(options.runtime, options.identityId);
    if (!currentHome || currentHome.id !== existing.threadId) {
      return null;
    }

    return currentHome;
  }

  private async resolveExistingHomeThread(
    runtime: TelegramRuntimeServices,
    identityId: string,
    agentKey = this.runtimeOptions.agent ?? "panda",
  ): Promise<ThreadRecord | null> {
    const existing = await runtime.homeThreads.resolveHomeThread({
      identityId,
      agentKey,
    });
    if (!existing) {
      return null;
    }

    try {
      const thread = await runtime.getThread(existing.threadId);
      return thread.identityId === identityId ? thread : null;
    } catch (error) {
      if (isMissingThreadError(error, existing.threadId)) {
        return null;
      }

      throw error;
    }
  }

  private async resolveOrCreateThread(
    binding: IdentityBindingRecord,
    _externalConversationId: string,
    chatId: number,
  ): Promise<ThreadRecord | null> {
    const { runtime } = await this.ensureInitialized();

    // Perf: private Telegram chats use the home-thread pointer now, so checking
    // conversation_threads here is just an extra DB miss on every DM. Keep the
    // old lookup commented for future group-chat support, where per-conversation
    // routing will matter again.
    // const { connectorKey } = await this.ensureInitialized();
    // const existing = await runtime.conversationThreads.resolveConversationThread({
    //   source: TELEGRAM_SOURCE,
    //   connectorKey,
    //   externalConversationId,
    // });
    //
    // if (existing) {
    //   const thread = await runtime.getThread(existing.threadId);
    //   if (thread.identityId !== binding.identityId) {
    //     return null;
    //   }
    //
    //   return thread;
    // }

    return await runtime.resolveOrCreateHomeThread({
      identityId: binding.identityId,
      agentKey: runtime.agentKey,
      provider: this.runtimeOptions.provider,
      model: this.runtimeOptions.model,
      context: {
        source: TELEGRAM_SOURCE,
        chatId: String(chatId),
      },
    });
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
