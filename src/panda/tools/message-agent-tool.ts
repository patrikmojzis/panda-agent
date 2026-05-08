import {access, stat} from "node:fs/promises";

import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {JsonObject, JsonValue} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import type {OutboundFileItem, OutboundImageItem, OutboundItem} from "../../domain/channels/types.js";
import {
  readExecutionEnvironmentFilesystemMetadata,
  type ResolvedExecutionEnvironment
} from "../../domain/execution-environments/index.js";
import type {A2AEnvironmentPathHints, A2ASenderEnvironmentSnapshot} from "../../domain/threads/requests/index.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {resolveReadableContextPath} from "../../app/runtime/panda-path-context.js";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const messageAgentItemSchema = z.discriminatedUnion("type", [
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

const messageAgentToolSchema = z.object({
  agentKey: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  items: z.array(messageAgentItemSchema).min(1).max(10),
}).superRefine((value, ctx) => {
  if (!value.agentKey && !value.sessionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agentKey"],
      message: "message_agent requires agentKey or sessionId",
    });
  }
});

function ensureMessageAgent(context: DefaultAgentSessionContext | undefined): NonNullable<DefaultAgentSessionContext["messageAgent"]> {
  const service = context?.messageAgent;
  if (!service) {
    throw new ToolError("message_agent is unavailable in this runtime.");
  }

  return service;
}

async function ensureReadableFile(filePath: string, displayPath: string): Promise<{sizeBytes: number}> {
  try {
    const file = await stat(filePath);
    if (!file.isFile()) {
      throw new ToolError(`Expected a file at ${displayPath}`);
    }

    return {
      sizeBytes: file.size,
    };
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }

    try {
      await access(filePath);
    } catch {
      throw new ToolError(`No readable file found at ${displayPath}`);
    }

    throw new ToolError(`Failed to inspect file at ${displayPath}`);
  }
}

async function resolveItemPath<TItem extends OutboundImageItem | OutboundFileItem>(
  item: TItem,
  run: RunContext<DefaultAgentSessionContext>,
): Promise<{item: TItem; sizeBytes: number}> {
  const displayPath = item.path;
  const resolvedPath = await resolveReadableContextPath(displayPath, run.context);
  const {sizeBytes} = await ensureReadableFile(resolvedPath, displayPath);
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new ToolError(
      `Attachment ${displayPath} is too large (${sizeBytes} bytes). Max per item is ${MAX_ATTACHMENT_BYTES} bytes.`,
    );
  }

  return {
    item: {
      ...item,
      path: resolvedPath,
    },
    sizeBytes,
  };
}

async function resolveOutboundItems(
  items: readonly z.output<typeof messageAgentItemSchema>[],
  run: RunContext<DefaultAgentSessionContext>,
): Promise<readonly OutboundItem[]> {
  const resolved: OutboundItem[] = [];
  let totalAttachmentBytes = 0;

  for (const item of items) {
    switch (item.type) {
      case "text":
        resolved.push(item);
        break;
      case "image": {
        const next = await resolveItemPath(item, run);
        totalAttachmentBytes += next.sizeBytes;
        resolved.push(next.item);
        break;
      }
      case "file": {
        const next = await resolveItemPath(item, run);
        totalAttachmentBytes += next.sizeBytes;
        resolved.push(next.item);
        break;
      }
    }
  }

  if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new ToolError(
      `Total attachment size is too large (${totalAttachmentBytes} bytes). Max per send is ${MAX_TOTAL_ATTACHMENT_BYTES} bytes.`,
    );
  }

  return resolved;
}

function serializeQueuedMessage(result: {
  deliveryId: string;
  targetAgentKey: string;
  targetSessionId: string;
  messageId: string;
}): JsonObject {
  return {
    ok: true,
    status: "queued",
    deliveryId: result.deliveryId,
    targetAgentKey: result.targetAgentKey,
    targetSessionId: result.targetSessionId,
    messageId: result.messageId,
  };
}

function compactPathHints(hints: A2AEnvironmentPathHints): A2AEnvironmentPathHints | undefined {
  const compacted = Object.fromEntries(
    Object.entries(hints).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  ) as A2AEnvironmentPathHints;
  return Object.keys(compacted).length === 0 ? undefined : compacted;
}

function buildSenderEnvironmentSnapshot(
  environment: ResolvedExecutionEnvironment | undefined,
): A2ASenderEnvironmentSnapshot | undefined {
  if (!environment || environment.source === "fallback" || environment.kind === "persistent_agent_runner") {
    return undefined;
  }

  const filesystem = readExecutionEnvironmentFilesystemMetadata(environment.metadata);
  const parentRunnerPaths = filesystem
    ? compactPathHints({
      root: filesystem.root.parentRunnerPath,
      workspace: filesystem.workspace.parentRunnerPath,
      inbox: filesystem.inbox.parentRunnerPath,
      artifacts: filesystem.artifacts.parentRunnerPath,
    })
    : undefined;
  const workerPaths = filesystem
    ? compactPathHints({
      workspace: filesystem.workspace.workerPath,
      inbox: filesystem.inbox.workerPath,
      artifacts: filesystem.artifacts.workerPath,
    })
    : undefined;

  return {
    id: environment.id,
    kind: environment.kind,
    ...(filesystem?.envDir ? {envDir: filesystem.envDir} : {}),
    ...(parentRunnerPaths ? {parentRunnerPaths} : {}),
    ...(workerPaths ? {workerPaths} : {}),
  };
}

export class MessageAgentTool<TContext = DefaultAgentSessionContext> extends Tool<typeof messageAgentToolSchema, TContext> {
  static schema = messageAgentToolSchema;

  name = "message_agent";
  description = "Send a fire-and-forget message, image, or file to another Panda session.";
  schema = MessageAgentTool.schema;

  override formatCall(args: Record<string, unknown>): string {
    const agentKey = typeof args.agentKey === "string" ? args.agentKey : undefined;
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined;
    return sessionId ?? agentKey ?? super.formatCall(args);
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (!isRecord(details) || typeof details.deliveryId !== "string") {
      return super.formatResult(message);
    }

    return `Queued A2A message ${details.deliveryId}.`;
  }

  async handle(
    args: z.output<typeof MessageAgentTool.schema>,
    run: RunContext<TContext>,
  ): Promise<JsonObject> {
    const context = run.context as DefaultAgentSessionContext | undefined;
    if (!context?.agentKey || !context.sessionId || !context.threadId) {
      throw new ToolError("message_agent requires agentKey, sessionId, and threadId in the runtime context.");
    }

    const service = ensureMessageAgent(context);
    const items = await resolveOutboundItems(args.items, run as RunContext<DefaultAgentSessionContext>);
    const senderEnvironment = buildSenderEnvironmentSnapshot(context.executionEnvironment);
    const queued = await service.queueMessage({
      senderAgentKey: context.agentKey,
      senderSessionId: context.sessionId,
      senderThreadId: context.threadId,
      senderRunId: context.runId,
      agentKey: args.agentKey,
      sessionId: args.sessionId,
      ...(senderEnvironment ? {senderEnvironment} : {}),
      items,
    }).catch((error) => {
      throw new ToolError(error instanceof Error ? error.message : String(error));
    });

    return serializeQueuedMessage({
      deliveryId: queued.delivery.id,
      targetAgentKey: queued.targetAgentKey,
      targetSessionId: queued.targetSessionId,
      messageId: queued.messageId,
    });
  }
}
