import { access } from "node:fs/promises";

import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { z } from "zod";

import type { RunContext } from "../../agent-core/run-context.js";
import { Tool } from "../../agent-core/tool.js";
import { ToolError } from "../../agent-core/exceptions.js";
import type { JsonObject, JsonValue } from "../../agent-core/types.js";
import type {
  OutboundFileItem,
  OutboundImageItem,
  OutboundItem,
  OutboundRequest,
  OutboundResult,
  OutboundTarget,
  RememberedRoute,
} from "../../channels/core/types.js";
import type { PandaSessionContext } from "../types.js";
import { resolvePandaPath } from "./context.js";

const outboundItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("image"),
    path: z.string().trim().min(1),
    caption: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal("file"),
    path: z.string().trim().min(1),
    filename: z.string().trim().min(1).optional(),
    caption: z.string().trim().min(1).optional(),
    mimeType: z.string().trim().min(1).optional(),
  }),
]);

const outboundToolSchema = z.object({
  channel: z.string().trim().min(1).optional()
    .describe("Destination channel. Omit to reply on the current inbound channel."),
  target: z.object({
    connectorKey: z.string().trim().min(1),
    conversationId: z.string().trim().min(1),
    actorId: z.string().trim().min(1).optional(),
    replyToMessageId: z.string().trim().min(1).optional(),
  }).optional()
    .describe("Explicit destination override. Omit to use the current inbound route."),
  items: z.array(outboundItemSchema).min(1).max(10),
}).superRefine((value, ctx) => {
  if (value.target && !value.channel) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["channel"],
      message: "channel is required when target is provided",
    });
  }
});

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

function readDefaultTarget(context: PandaSessionContext | undefined): {
  channel: string;
  target: OutboundTarget;
} | null {
  const source = readTrimmedString(context?.currentInput?.source);
  if (!source) {
    return null;
  }

  const metadata = context?.currentInput?.metadata;
  if (!isRecord(metadata)) {
    return null;
  }

  const route = metadata.route;
  if (!isRecord(route)) {
    return null;
  }

  const connectorKey = readTrimmedString(route.connectorKey);
  const externalConversationId = readTrimmedString(route.externalConversationId);
  if (!connectorKey || !externalConversationId) {
    return null;
  }

  return {
    channel: source,
    target: {
      source,
      connectorKey,
      externalConversationId,
      externalActorId: readTrimmedString(route.externalActorId),
    },
  };
}

async function readRememberedTarget(context: PandaSessionContext | undefined): Promise<{
  channel: string;
  target: OutboundTarget;
} | null> {
  const route = await context?.routeMemory?.getLastRoute();
  if (!route) {
    return null;
  }

  return {
    channel: route.source,
    target: {
      source: route.source,
      connectorKey: route.connectorKey,
      externalConversationId: route.externalConversationId,
      externalActorId: route.externalActorId,
    },
  };
}

function rememberRouteFromTarget(target: OutboundTarget): RememberedRoute {
  return {
    source: target.source,
    connectorKey: target.connectorKey,
    externalConversationId: target.externalConversationId,
    externalActorId: target.externalActorId,
    capturedAt: Date.now(),
  };
}

function ensureDispatcher(context: PandaSessionContext | undefined): NonNullable<PandaSessionContext["outboundDispatcher"]> {
  const dispatcher = context?.outboundDispatcher;
  if (!dispatcher) {
    throw new ToolError("Outbound is unavailable in this runtime.");
  }

  return dispatcher;
}

function buildExplicitTarget(
  channel: string,
  target: z.output<typeof outboundToolSchema>["target"],
): OutboundTarget | null {
  if (!target) {
    return null;
  }

  return {
    source: channel,
    connectorKey: target.connectorKey,
    externalConversationId: target.conversationId,
    externalActorId: target.actorId,
    replyToMessageId: target.replyToMessageId,
  };
}

async function ensureReadableResolvedPath(filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new ToolError(`No readable file found at ${filePath}`);
  }
}

async function resolveOutboundItemPath<TItem extends OutboundImageItem | OutboundFileItem>(
  item: TItem,
  run: RunContext<PandaSessionContext>,
): Promise<TItem> {
  const resolvedPath = resolvePandaPath(item.path, run.context);
  await ensureReadableResolvedPath(resolvedPath);
  return {
    ...item,
    path: resolvedPath,
  };
}

async function resolveOutboundItems(
  items: readonly z.output<typeof outboundItemSchema>[],
  run: RunContext<PandaSessionContext>,
): Promise<readonly OutboundItem[]> {
  const resolved: OutboundItem[] = [];

  for (const item of items) {
    switch (item.type) {
      case "text":
        resolved.push(item);
        break;
      case "image":
        resolved.push(await resolveOutboundItemPath(item, run));
        break;
      case "file":
        resolved.push(await resolveOutboundItemPath(item, run));
        break;
      default:
        throw new ToolError(`Unsupported outbound item type ${(item as { type?: string }).type ?? "unknown"}.`);
    }
  }

  return resolved;
}

function formatSentItem(item: { type: string; externalMessageId: string }): string {
  return `- ${item.type}: ${item.externalMessageId}`;
}

function serializeOutboundResult(result: OutboundResult): JsonObject {
  return {
    ok: true,
    channel: result.channel,
    target: {
      source: result.target.source,
      connectorKey: result.target.connectorKey,
      externalConversationId: result.target.externalConversationId,
      externalActorId: result.target.externalActorId ?? null,
      replyToMessageId: result.target.replyToMessageId ?? null,
    },
    sent: result.sent.map((item) => ({
      type: item.type,
      externalMessageId: item.externalMessageId,
    })),
  };
}

export class OutboundTool<TContext = PandaSessionContext> extends Tool<typeof outboundToolSchema, TContext> {
  static schema = outboundToolSchema;

  name = "outbound";
  description =
    "Send a reply, image, or file back to an external channel. If no target is provided, it replies to the current inbound channel route.";
  schema = OutboundTool.schema;

  override formatCall(args: Record<string, unknown>): string {
    const itemCount = Array.isArray(args.items) ? args.items.length : 0;
    const channel = typeof args.channel === "string" ? args.channel : "current";
    return `${channel} (${itemCount} item${itemCount === 1 ? "" : "s"})`;
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!isRecord(details) || !Array.isArray(details.sent)) {
      return super.formatResult(message);
    }

    const sentLines = details.sent
      .filter((item): item is { type: string; externalMessageId: string } =>
        isRecord(item) && typeof item.type === "string" && typeof item.externalMessageId === "string")
      .map((item) => formatSentItem(item));

    return sentLines.length > 0 ? sentLines.join("\n") : "Outbound sent.";
  }

  async handle(
    args: z.output<typeof OutboundTool.schema>,
    run: RunContext<TContext>,
  ): Promise<JsonObject> {
    const pandaContext = run.context as PandaSessionContext | undefined;
    const dispatcher = ensureDispatcher(pandaContext);
    const defaultRoute = readDefaultTarget(pandaContext) ?? await readRememberedTarget(pandaContext);
    const hasExplicitTarget = Boolean(args.target);

    const channel = args.channel ?? defaultRoute?.channel;
    if (!channel) {
      throw new ToolError("No outbound channel was provided and no current inbound route is available.");
    }

    const target = buildExplicitTarget(channel, args.target) ?? defaultRoute?.target;
    if (!target) {
      throw new ToolError("No outbound target was provided and no current inbound route is available.");
    }

    const items = await resolveOutboundItems(args.items, run as RunContext<PandaSessionContext>);
    const request: OutboundRequest = {
      channel,
      target,
      items,
    };

    const result = await dispatcher.dispatch(request);
    if (!hasExplicitTarget) {
      await pandaContext?.routeMemory?.rememberLastRoute(rememberRouteFromTarget(result.target));
    }
    return serializeOutboundResult(result);
  }
}
