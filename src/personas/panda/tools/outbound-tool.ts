import {access} from "node:fs/promises";

import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../../kernel/agent/run-context.js";
import {Tool} from "../../../kernel/agent/tool.js";
import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {JsonObject, JsonValue} from "../../../kernel/agent/types.js";
import {resolveChannelRouteTarget} from "../../../domain/channels/route-target.js";
import type {
    OutboundFileItem,
    OutboundImageItem,
    OutboundItem,
    OutboundTarget,
    RememberedRoute,
} from "../../../domain/channels/types.js";
import {parseScheduledTaskThreadInputMetadata} from "../../../domain/scheduling/tasks/index.js";
import type {PandaSessionContext} from "../types.js";
import {resolvePandaPath} from "./context.js";

const outboundItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("image"),
    path: z.string().trim().min(1).describe(
      "Absolute path or path relative to the current working directory. In remote bash mode, agent-home runner paths are translated automatically.",
    ),
    caption: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal("file"),
    path: z.string().trim().min(1).describe(
      "Absolute path or path relative to the current working directory. In remote bash mode, agent-home runner paths are translated automatically.",
    ),
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

async function readRememberedTargetForChannel(
  context: PandaSessionContext | undefined,
  channel?: string,
): Promise<{
  channel: string;
  target: OutboundTarget;
} | null> {
  const route = await context?.routeMemory?.getLastRoute(channel);
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

function ensureOutboundQueue(context: PandaSessionContext | undefined): NonNullable<PandaSessionContext["outboundQueue"]> {
  const queue = context?.outboundQueue;
  if (!queue) {
    throw new ToolError("Outbound is unavailable in this runtime.");
  }

  return queue;
}

function requireThreadId(context: PandaSessionContext | undefined): string {
  const threadId = context?.threadId?.trim();
  if (!threadId) {
    throw new ToolError("Outbound requires a thread id in the current runtime context.");
  }

  return threadId;
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

function serializeQueuedDelivery(delivery: {
  id: string;
  channel: string;
  target: OutboundTarget;
}): JsonObject {
  return {
    ok: true,
    status: "queued",
    deliveryId: delivery.id,
    channel: delivery.channel,
    target: {
      source: delivery.target.source,
      connectorKey: delivery.target.connectorKey,
      externalConversationId: delivery.target.externalConversationId,
      externalActorId: delivery.target.externalActorId ?? null,
      replyToMessageId: delivery.target.replyToMessageId ?? null,
    },
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
    if (!isRecord(details) || typeof details.deliveryId !== "string") {
      return super.formatResult(message);
    }

    return `Queued outbound delivery ${details.deliveryId}.`;
  }

  async handle(
    args: z.output<typeof OutboundTool.schema>,
    run: RunContext<TContext>,
  ): Promise<JsonObject> {
    const pandaContext = run.context as PandaSessionContext | undefined;
    const scheduledTask = parseScheduledTaskThreadInputMetadata(pandaContext?.currentInput?.metadata)?.scheduledTask;
    if (scheduledTask?.phase === "execute" && scheduledTask.deliveryMode === "deferred") {
      throw new ToolError("Outbound is disabled during prepare-only scheduled task execution.");
    }

    const queue = ensureOutboundQueue(pandaContext);
    const currentRoute = resolveChannelRouteTarget(pandaContext?.currentInput);
    const hasExplicitTarget = Boolean(args.target);
    const requestedChannel = args.channel;

    let defaultRoute = null;
    if (currentRoute && (!requestedChannel || currentRoute.channel === requestedChannel)) {
      defaultRoute = currentRoute;
    } else if (requestedChannel) {
      defaultRoute = await readRememberedTargetForChannel(pandaContext, requestedChannel);
    } else {
      defaultRoute = await readRememberedTarget(pandaContext);
    }

    const channel = requestedChannel ?? defaultRoute?.channel;
    if (!channel) {
      throw new ToolError("No outbound channel was provided and no current inbound route is available.");
    }

    const target = buildExplicitTarget(channel, args.target) ?? defaultRoute?.target;
    if (!target) {
      throw new ToolError("No outbound target was provided and no current inbound route is available.");
    }

    const items = await resolveOutboundItems(args.items, run as RunContext<PandaSessionContext>);
    const delivery = await queue.enqueueDelivery({
      threadId: requireThreadId(pandaContext),
      channel,
      target,
      items,
    });
    if (!hasExplicitTarget) {
      await pandaContext?.routeMemory?.saveLastRoute(rememberRouteFromTarget(target));
    }

    return serializeQueuedDelivery({
      id: delivery.id,
      channel: delivery.channel,
      target: delivery.target,
    });
  }
}
