import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {JsonObject, JsonValue} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {assertPathReadable} from "../../lib/fs.js";
import {resolveChannelRouteTarget} from "../../domain/channels/route-target.js";
import type {
  OutboundFileItem,
  OutboundImageItem,
  OutboundItem,
  OutboundTarget,
  RememberedRoute,
} from "../../domain/channels/types.js";
import {parseScheduledTaskThreadInputMetadata} from "../../domain/scheduling/tasks/index.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {resolveContextPath} from "../../app/runtime/panda-path-context.js";
import {A2A_SOURCE} from "../../integrations/channels/a2a/config.js";

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

async function readRememberedTarget(context: DefaultAgentSessionContext | undefined): Promise<{
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
  context: DefaultAgentSessionContext | undefined,
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

function ensureOutboundQueue(context: DefaultAgentSessionContext | undefined): NonNullable<DefaultAgentSessionContext["outboundQueue"]> {
  const queue = context?.outboundQueue;
  if (!queue) {
    throw new ToolError("Outbound is unavailable in this runtime.");
  }

  return queue;
}

function requireThreadId(context: DefaultAgentSessionContext | undefined): string {
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

async function resolveOutboundItemPath<TItem extends OutboundImageItem | OutboundFileItem>(
  item: TItem,
  run: RunContext<DefaultAgentSessionContext>,
): Promise<TItem> {
  const resolvedPath = resolveContextPath(item.path, run.context);
  await assertPathReadable(resolvedPath, (missingPath) => new ToolError(`No readable file found at ${missingPath}`));
  return {
    ...item,
    path: resolvedPath,
  };
}

async function resolveOutboundItems(
  items: readonly z.output<typeof outboundItemSchema>[],
  run: RunContext<DefaultAgentSessionContext>,
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

export class OutboundTool<TContext = DefaultAgentSessionContext> extends Tool<typeof outboundToolSchema, TContext> {
  static schema = outboundToolSchema;

  name = "outbound";
  description =
    "Always use this tool to message human. Send a reply, image, or file to an external channel. If no target is provided, it replies to the latest inbound channel route.";
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
    const sessionContext = run.context as DefaultAgentSessionContext | undefined;
    const scheduledTask = parseScheduledTaskThreadInputMetadata(sessionContext?.currentInput?.metadata)?.scheduledTask;
    if (scheduledTask?.phase === "execute" && scheduledTask.deliveryMode === "deferred") {
      throw new ToolError("Outbound is disabled during prepare-only scheduled task execution.");
    }

    const queue = ensureOutboundQueue(sessionContext);
    const currentRoute = resolveChannelRouteTarget(sessionContext?.currentInput);
    const hasExplicitTarget = Boolean(args.target);
    const requestedChannel = args.channel;

    let defaultRoute = null;
    if (currentRoute && (!requestedChannel || currentRoute.channel === requestedChannel)) {
      defaultRoute = currentRoute;
    } else if (requestedChannel) {
      defaultRoute = await readRememberedTargetForChannel(sessionContext, requestedChannel);
    } else {
      defaultRoute = await readRememberedTarget(sessionContext);
    }

    const channel = requestedChannel ?? defaultRoute?.channel;
    if (!channel) {
      throw new ToolError("No outbound channel was provided and no current inbound route is available.");
    }
    if (channel === A2A_SOURCE) {
      throw new ToolError("Use message_agent for Panda A2A messages.");
    }

    const target = buildExplicitTarget(channel, args.target) ?? defaultRoute?.target;
    if (!target) {
      throw new ToolError("No outbound target was provided and no current inbound route is available.");
    }

    const items = await resolveOutboundItems(args.items, run as RunContext<DefaultAgentSessionContext>);
    const delivery = await queue.enqueueDelivery({
      threadId: requireThreadId(sessionContext),
      channel,
      target,
      items,
    });
    if (!hasExplicitTarget) {
      await sessionContext?.routeMemory?.saveLastRoute(rememberRouteFromTarget(target));
    }

    return serializeQueuedDelivery({
      id: delivery.id,
      channel: delivery.channel,
      target: delivery.target,
    });
  }
}
