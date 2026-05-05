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
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {resolveContextPath} from "../../app/runtime/panda-path-context.js";
import {A2A_SOURCE} from "../../integrations/channels/a2a/config.js";
import {EMAIL_SOURCE} from "../../domain/email/index.js";

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

const outboundDestinationSchema = z.strictObject({
  identityHandle: z.string().trim().min(1)
    .describe("Identity handle of the person to message, for example patrik_mojzis."),
  channel: z.string().trim().min(1).optional()
    .describe("Optional channel override, for example telegram or whatsapp. Omit to use this person's latest active route."),
});

const outboundToolSchema = z.strictObject({
  to: outboundDestinationSchema.optional()
    .describe("Optional person/channel destination. Omit to reply on the current inbound conversation."),
  items: z.array(outboundItemSchema).min(1).max(10),
});

type OutboundDestination = z.output<typeof outboundDestinationSchema>;

interface ResolvedOutboundTarget {
  channel: string;
  target: OutboundTarget;
  identityHandle?: string;
}

function buildRouteMemoryLookup(channel?: string, identityId?: string): {
  channel?: string;
  identityId?: string;
} | undefined {
  if (!channel && !identityId) {
    return undefined;
  }

  return {
    ...(channel ? {channel} : {}),
    ...(identityId ? {identityId} : {}),
  };
}

async function readRememberedTarget(
  context: DefaultAgentSessionContext | undefined,
  identityId?: string,
): Promise<ResolvedOutboundTarget | null> {
  const route = await context?.routeMemory?.getLastRoute(buildRouteMemoryLookup(undefined, identityId));
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
  identityId?: string,
): Promise<ResolvedOutboundTarget | null> {
  const route = await context?.routeMemory?.getLastRoute(buildRouteMemoryLookup(channel, identityId));
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

async function resolveDestinationIdentity(
  context: DefaultAgentSessionContext | undefined,
  destination: OutboundDestination,
): Promise<{identityId: string; identityHandle: string}> {
  const directory = context?.identityDirectory;
  if (!directory) {
    throw new ToolError("Outbound identity routing is unavailable in this runtime.");
  }

  try {
    const identity = await directory.getIdentityByHandle(destination.identityHandle);
    return {
      identityId: identity.id,
      identityHandle: identity.handle,
    };
  } catch (error) {
    if (
      error instanceof Error
      && !error.message.startsWith("Unknown identity handle ")
      && !error.message.startsWith("Identity handle must ")
    ) {
      throw error;
    }

    throw new ToolError(`Unknown outbound identity ${destination.identityHandle}.`);
  }
}

async function resolveDestinationTarget(
  context: DefaultAgentSessionContext | undefined,
  destination: OutboundDestination,
): Promise<ResolvedOutboundTarget> {
  const identity = await resolveDestinationIdentity(context, destination);
  const resolved = await readRememberedTargetForChannel(context, destination.channel, identity.identityId);
  if (!resolved) {
    throw new ToolError(destination.channel
      ? `No remembered ${destination.channel} route for ${identity.identityHandle}.`
      : `No remembered outbound route for ${identity.identityHandle}.`);
  }

  return {
    ...resolved,
    identityHandle: identity.identityHandle,
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
  identityHandle?: string;
}): JsonObject {
  return {
    ok: true,
    status: "queued",
    deliveryId: delivery.id,
    to: {
      ...(delivery.identityHandle ? {identityHandle: delivery.identityHandle} : {}),
      channel: delivery.channel,
    },
  };
}

export class OutboundTool<TContext = DefaultAgentSessionContext> extends Tool<typeof outboundToolSchema, TContext> {
  static schema = outboundToolSchema;

  name = "outbound";
  description =
    "Always use this tool to message a human. Omit `to` to reply on the current conversation. Use `to.identityHandle` for a person; add `to.channel` only when choosing a specific channel.";
  schema = OutboundTool.schema;

  override formatCall(args: Record<string, unknown>): string {
    const itemCount = Array.isArray(args.items) ? args.items.length : 0;
    const destination = isRecord(args.to) && typeof args.to.identityHandle === "string"
      ? `${args.to.identityHandle}${typeof args.to.channel === "string" ? `/${args.to.channel}` : ""}`
      : "current";
    return `${destination} (${itemCount} item${itemCount === 1 ? "" : "s"})`;
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
    const queue = ensureOutboundQueue(sessionContext);
    const currentRoute = resolveChannelRouteTarget(sessionContext?.currentInput);
    const currentIdentityId = sessionContext?.currentInput?.identityId;

    const resolvedRoute: ResolvedOutboundTarget | null = args.to
      ? await resolveDestinationTarget(sessionContext, args.to)
      : currentRoute
        ? {
          channel: currentRoute.channel,
          target: currentRoute.target,
        }
        : await readRememberedTarget(sessionContext, currentIdentityId);

    const channel = resolvedRoute?.channel;
    if (!channel) {
      throw new ToolError("No outbound channel was provided and no current inbound route is available.");
    }
    if (channel === A2A_SOURCE) {
      throw new ToolError("Use message_agent for Panda A2A messages.");
    }
    if (channel === EMAIL_SOURCE) {
      throw new ToolError("Use email_send for email.");
    }

    const target = resolvedRoute?.target;
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
    if (!args.to) {
      await sessionContext?.routeMemory?.saveLastRoute(rememberRouteFromTarget(target), {
        identityId: currentIdentityId,
      });
    }

    return serializeQueuedDelivery({
      id: delivery.id,
      channel: delivery.channel,
      identityHandle: resolvedRoute.identityHandle,
    });
  }
}
