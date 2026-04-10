import {z} from "zod";

import type {RunContext} from "../agent-core/run-context.js";
import {Tool} from "../agent-core/tool.js";
import {ToolError} from "../agent-core/exceptions.js";
import type {JsonObject} from "../agent-core/types.js";
import type {PandaSessionContext} from "../panda/types.js";
import {TELEGRAM_SOURCE} from "./config.js";
import {parseTelegramConversationId} from "./conversation-id.js";

const telegramReactToolSchema = z.object({
  emoji: z.string().trim().min(1).optional(),
  remove: z.boolean().optional(),
  messageId: z.string().trim().min(1).optional(),
  target: z.object({
    connectorKey: z.string().trim().min(1),
    conversationId: z.string().trim().min(1),
  }).optional(),
}).superRefine((value, ctx) => {
  if (value.remove !== true && !value.emoji) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["emoji"],
      message: "emoji is required unless remove=true",
    });
  }
});

interface TelegramReactionTarget {
  connectorKey: string;
  conversationId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseTelegramMessageId(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ToolError(`Invalid Telegram message id ${value}.`);
  }

  return parsed;
}

function parseReactionConversationId(value: string) {
  try {
    return parseTelegramConversationId(value);
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : String(error));
  }
}

function readCurrentTelegramTarget(context: PandaSessionContext | undefined): TelegramReactionTarget | null {
  if (context?.currentInput?.source !== TELEGRAM_SOURCE) {
    return null;
  }

  const metadata = context.currentInput.metadata;
  if (!isRecord(metadata)) {
    return null;
  }

  const route = metadata.route;
  if (!isRecord(route)) {
    return null;
  }

  const connectorKey = readTrimmedString(route.connectorKey);
  const conversationId =
    readTrimmedString(route.externalConversationId)
    ?? readTrimmedString(context.currentInput.channelId);
  if (!connectorKey || !conversationId) {
    return null;
  }

  return {
    connectorKey,
    conversationId,
  };
}

function readCurrentTelegramExternalMessageId(context: PandaSessionContext | undefined): string | undefined {
  if (context?.currentInput?.source !== TELEGRAM_SOURCE) {
    return undefined;
  }

  return readTrimmedString(context.currentInput.externalMessageId);
}

function readReactionTargetMessageId(context: PandaSessionContext | undefined): string | undefined {
  if (context?.currentInput?.source !== TELEGRAM_SOURCE) {
    return undefined;
  }

  const metadata = context?.currentInput?.metadata;
  if (!isRecord(metadata)) {
    return undefined;
  }

  const telegram = metadata.telegram;
  if (!isRecord(telegram)) {
    return undefined;
  }

  const reaction = telegram.reaction;
  if (!isRecord(reaction)) {
    return undefined;
  }

  return readTrimmedString(reaction.targetMessageId);
}

function resolveTelegramMessageId(
  args: z.output<typeof telegramReactToolSchema>,
  context: PandaSessionContext | undefined,
): string | undefined {
  return (
    readTrimmedString(args.messageId)
    ?? readReactionTargetMessageId(context)
    ?? readCurrentTelegramExternalMessageId(context)
  );
}

export class TelegramReactTool extends Tool<typeof telegramReactToolSchema, PandaSessionContext> {
  static schema = telegramReactToolSchema;

  name = "telegram_react";
  description =
    "Add or remove a reaction on a Telegram message. Defaults to the current Telegram conversation and message when possible.";
  schema = TelegramReactTool.schema;

  override formatCall(args: Record<string, unknown>): string {
    if (args.remove === true) {
      return "remove";
    }

    return typeof args.emoji === "string" ? args.emoji : "react";
  }

  async handle(
    args: z.output<typeof TelegramReactTool.schema>,
    run: RunContext<PandaSessionContext>,
  ): Promise<JsonObject> {
    const queue = run.context?.channelActionQueue;
    if (!queue) {
      throw new ToolError("telegram_react is unavailable in this runtime.");
    }

    const target = args.target ?? readCurrentTelegramTarget(run.context);
    if (!target) {
      throw new ToolError("telegram_react requires a current Telegram input or an explicit target.");
    }

    const messageIdValue = resolveTelegramMessageId(args, run.context);
    if (!messageIdValue) {
      throw new ToolError("telegram_react requires a target message id.");
    }

    parseReactionConversationId(target.conversationId);
    const messageId = parseTelegramMessageId(messageIdValue);
    const remove = args.remove === true;
    const resolvedEmoji = remove ? "" : args.emoji!.trim();
    await queue.enqueueAction({
      channel: TELEGRAM_SOURCE,
      connectorKey: target.connectorKey,
      kind: "telegram_reaction",
      payload: {
        conversationId: target.conversationId,
        messageId: String(messageId),
        emoji: remove ? undefined : resolvedEmoji,
        remove,
      },
    });

    if (remove) {
      return {
        ok: true,
        connectorKey: target.connectorKey,
        conversationId: target.conversationId,
        messageId: String(messageId),
        removed: true,
        queued: true,
      };
    }

    return {
      ok: true,
      connectorKey: target.connectorKey,
      conversationId: target.conversationId,
      messageId: String(messageId),
      added: resolvedEmoji,
      queued: true,
    };
  }
}
