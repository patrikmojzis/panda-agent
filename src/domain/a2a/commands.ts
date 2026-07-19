import type {JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import type {OutboundItem} from "../channels/types.js";
import {commandScopeDenied} from "../commands/errors.js";
import type {CommandUploadStore} from "../commands/uploads.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../execution-environments/filesystem.js";
import type {A2AEnvironmentPathHints, A2ASenderEnvironmentSnapshot} from "../threads/requests/types.js";
import type {A2ADeliveryDirection, A2ADeliveryRecord} from "./types.js";

export const A2A_SEND_COMMAND_NAME = "a2a.send";
export const A2A_INSPECT_COMMAND_NAME = "a2a.inspect";
export const A2A_HISTORY_COMMAND_NAME = "a2a.history";

export const MAX_A2A_ATTACHMENT_BYTES = 60 * 1024 * 1024;
export const MAX_A2A_TOTAL_ATTACHMENT_BYTES = 150 * 1024 * 1024;
const MAX_ITEMS = 10;
const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 50;

export interface MessageAgentSendCommandInput {
  agentKey?: string;
  sessionId?: string;
  items: JsonObject[];
}

export interface MessageAgentSendCommandOutput extends JsonObject {
  ok: true;
  status: "queued";
  deliveryId: string;
  targetAgentKey: string;
  targetSessionId: string;
  messageId: string;
}

export interface MessageAgentCommandQueue {
  queueMessage(input: {
    senderAgentKey: string;
    senderSessionId: string;
    senderThreadId: string;
    senderRunId?: string;
    agentKey?: string;
    sessionId?: string;
    senderEnvironment?: A2ASenderEnvironmentSnapshot;
    items: readonly OutboundItem[];
  }): Promise<{
    delivery: {
      id: string;
    };
    targetAgentKey: string;
    targetSessionId: string;
    messageId: string;
  }>;
}

export interface A2ADeliveryReader {
  getA2ADelivery(input: {
    sessionId: string;
    deliveryId: string;
  }): Promise<A2ADeliveryRecord | null>;
  listA2ADeliveries(input: {
    sessionId: string;
    peerSessionId?: string;
    direction?: A2ADeliveryDirection | "all";
    limit?: number;
  }): Promise<readonly A2ADeliveryRecord[]>;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return readRequiredString(value, label);
}

function requireInputObject(input: unknown, commandLabel: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(`${commandLabel} input must be a JSON object.`);
  }

  return input;
}

function rejectUnexpectedKeys(input: Record<string, unknown>, commandName: string, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(`${commandName} does not accept ${key}.`);
    }
  }
}

function readOptionalLimit(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_HISTORY_LIMIT) {
    throw new Error(`${label} must be an integer from 1 to ${MAX_HISTORY_LIMIT}.`);
  }

  return value;
}

function readOptionalDirection(value: unknown): A2ADeliveryDirection | "all" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "inbound" || value === "outbound" || value === "all") {
    return value;
  }

  throw new Error("a2a.history direction must be inbound, outbound, or all.");
}

function parseA2AInspectInput(input: unknown): {deliveryId: string} {
  const object = requireInputObject(input, A2A_INSPECT_COMMAND_NAME);
  rejectUnexpectedKeys(object, A2A_INSPECT_COMMAND_NAME, ["deliveryId"]);

  return {
    deliveryId: readRequiredString(object.deliveryId, "a2a.inspect deliveryId"),
  };
}

function parseA2AHistoryInput(input: unknown): {
  peerSessionId?: string;
  direction?: A2ADeliveryDirection | "all";
  limit: number;
} {
  const object = requireInputObject(input, A2A_HISTORY_COMMAND_NAME);
  rejectUnexpectedKeys(object, A2A_HISTORY_COMMAND_NAME, ["peerSessionId", "direction", "limit"]);
  const peerSessionId = readOptionalString(object.peerSessionId, "a2a.history peerSessionId");
  const direction = readOptionalDirection(object.direction);

  return {
    ...(peerSessionId ? {peerSessionId} : {}),
    ...(direction ? {direction} : {}),
    limit: readOptionalLimit(object.limit, "a2a.history limit") ?? DEFAULT_HISTORY_LIMIT,
  };
}

type ParsedMessageAgentItem =
  | {type: "text"; text: string}
  | {type: "file"; uploadRef: string; caption?: string};

function parseMessageAgentItem(value: unknown, label: string): ParsedMessageAgentItem {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  switch (value.type) {
    case "text":
      rejectUnexpectedKeys(value, label, ["type", "text"]);
      return {
        type: "text",
        text: readRequiredString(value.text, `${label}.text`),
      };
    case "image": {
      throw new Error(`${label}.type image is not accepted; use type=file for A2A attachments.`);
    }
    case "file": {
      if (value.path !== undefined) {
        throw new Error(`${label} does not accept path; upload the client-local file and pass uploadRef.`);
      }
      rejectUnexpectedKeys(value, label, ["type", "uploadRef", "filename", "caption", "mimeType"]);
      const caption = readOptionalString(value.caption, `${label}.caption`);
      return {
        type: "file",
        uploadRef: readRequiredString(value.uploadRef, `${label}.uploadRef`),
        ...(caption ? {caption} : {}),
      };
    }
    default:
      throw new Error(`${label}.type must be text or file.`);
  }
}

function parseMessageAgentSendCommandInput(input: unknown, commandLabel: string): {
  agentKey?: string;
  sessionId?: string;
  items: readonly ParsedMessageAgentItem[];
} {
  const object = requireInputObject(input, commandLabel);
  const agentKey = readOptionalString(object.agentKey, `${commandLabel} agentKey`);
  const sessionId = readOptionalString(object.sessionId, `${commandLabel} sessionId`);
  if (!agentKey && !sessionId) {
    throw new Error(`${commandLabel} requires agentKey or sessionId.`);
  }

  if (!Array.isArray(object.items) || object.items.length === 0 || object.items.length > MAX_ITEMS) {
    throw new Error(`${commandLabel} items must contain 1-${MAX_ITEMS} items.`);
  }

  return {
    ...(agentKey ? {agentKey} : {}),
    ...(sessionId ? {sessionId} : {}),
    items: object.items.map((item, index) => parseMessageAgentItem(item, `${commandLabel} items[${index}]`)),
  };
}

async function resolveOutboundItems(
  items: readonly ParsedMessageAgentItem[],
  request: CommandRequest,
  uploads: CommandUploadStore,
): Promise<readonly OutboundItem[]> {
  const resolved: OutboundItem[] = [];
  let totalAttachmentBytes = 0;

  for (const item of items) {
    switch (item.type) {
      case "text":
        resolved.push(item);
        break;
      case "file": {
        const upload = await uploads.inspect({
          agentKey: request.scope.agentKey,
          sessionId: request.scope.sessionId,
        }, item.uploadRef);
        if (upload.sizeBytes > MAX_A2A_ATTACHMENT_BYTES) {
          throw new Error(`A2A attachment exceeds the ${MAX_A2A_ATTACHMENT_BYTES} byte per-file limit.`);
        }
        totalAttachmentBytes += upload.sizeBytes;
        resolved.push({
          type: "file",
          uploadRef: upload.uploadRef,
          filename: upload.filename,
          mimeType: upload.mimeType,
          sizeBytes: upload.sizeBytes,
          ...(item.caption ? {caption: item.caption} : {}),
        });
        break;
      }
    }
  }

  if (totalAttachmentBytes > MAX_A2A_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(
      `Total A2A attachment size exceeds the ${MAX_A2A_TOTAL_ATTACHMENT_BYTES} byte per-send limit.`,
    );
  }

  return resolved;
}

function compactPathHints(hints: A2AEnvironmentPathHints): A2AEnvironmentPathHints | undefined {
  const compacted = Object.fromEntries(
    Object.entries(hints).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  ) as A2AEnvironmentPathHints;
  return Object.keys(compacted).length === 0 ? undefined : compacted;
}

function buildSenderEnvironmentSnapshot(
  environment: CommandRequest["scope"]["executionEnvironment"],
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

export function serializeMessageAgentQueuedMessage(result: {
  deliveryId: string;
  targetAgentKey: string;
  targetSessionId: string;
  messageId: string;
}): MessageAgentSendCommandOutput {
  return {
    ok: true,
    status: "queued",
    deliveryId: result.deliveryId,
    targetAgentKey: result.targetAgentKey,
    targetSessionId: result.targetSessionId,
    messageId: result.messageId,
  };
}

function serializeA2ADelivery(delivery: A2ADeliveryRecord): JsonObject {
  return {
    deliveryId: delivery.deliveryId,
    messageId: delivery.messageId,
    direction: delivery.direction,
    status: delivery.status,
    fromAgentKey: delivery.fromAgentKey,
    fromSessionId: delivery.fromSessionId,
    fromThreadId: delivery.fromThreadId,
    ...(delivery.fromRunId ? {fromRunId: delivery.fromRunId} : {}),
    toAgentKey: delivery.toAgentKey,
    toSessionId: delivery.toSessionId,
    attemptCount: delivery.attemptCount,
    ...(delivery.lastError ? {lastError: delivery.lastError} : {}),
    itemCount: delivery.itemCount,
    items: delivery.items.map((item) => ({...item})),
    ...(delivery.sentItems ? {sentItems: delivery.sentItems.map((item) => ({...item}))} : {}),
    sentAt: delivery.sentAt,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    ...(delivery.claimedAt ? {claimedAt: delivery.claimedAt} : {}),
    ...(delivery.completedAt ? {completedAt: delivery.completedAt} : {}),
  };
}

export const a2aInspectCommandDescriptor: CommandDescriptor = {
  name: A2A_INSPECT_COMMAND_NAME,
  summary: "Inspect one A2A delivery.",
  description: "Shows the status and metadata for an A2A delivery visible to the current session. Use the deliveryId returned by a2a.send.",
  usage: "panda a2a inspect <delivery-id>",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "delivery-id",
      description: "A2A outbound delivery id returned by a2a.send.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "delivery-id",
    },
    {
      name: "json",
      description: "Structured JSON object containing deliveryId.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Inspect an A2A delivery",
      command: "panda a2a inspect delivery-123",
    },
  ],
  requiredCapabilities: [A2A_INSPECT_COMMAND_NAME],
  resultShape: {
    deliveryId: "string",
    messageId: "string",
    direction: "inbound|outbound",
    status: "pending|sending|sent|failed",
    fromSessionId: "string",
    toSessionId: "string",
    itemCount: "number",
  },
};

export const a2aHistoryCommandDescriptor: CommandDescriptor = {
  name: A2A_HISTORY_COMMAND_NAME,
  summary: "List recent A2A deliveries.",
  description: "Lists compact A2A delivery history for the current session. Use --peer-session to filter to a specific counterpart.",
  usage: "panda a2a history [--peer-session <session-id>] [--direction inbound|outbound|all] [--limit <n>]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "peer-session",
      description: "Optional counterpart session id.",
      valueType: "string",
      valueName: "session-id",
    },
    {
      name: "direction",
      description: "Filter by delivery direction. Defaults to all.",
      valueType: "string",
      valueName: "inbound|outbound|all",
      enumValues: ["inbound", "outbound", "all"],
      defaultValue: "all",
    },
    {
      name: "limit",
      description: `Maximum deliveries to return, 1-${MAX_HISTORY_LIMIT}. Defaults to ${DEFAULT_HISTORY_LIMIT}.`,
      valueType: "number",
      valueName: "n",
      defaultValue: DEFAULT_HISTORY_LIMIT,
    },
    {
      name: "json",
      description: "Structured JSON object containing optional peerSessionId, direction, and limit.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List recent A2A deliveries",
      command: "panda a2a history --limit 20",
    },
    {
      description: "List outbound messages to one session",
      command: "panda a2a history --peer-session session-b --direction outbound",
    },
  ],
  requiredCapabilities: [A2A_HISTORY_COMMAND_NAME],
  resultShape: {
    count: "number",
    deliveries: ["object"],
  },
};

export const a2aSendCommandDescriptor: CommandDescriptor = {
  name: A2A_SEND_COMMAND_NAME,
  summary: "Send an A2A message to another Panda session.",
  description: "Queues a fire-and-forget Panda-to-Panda message. Native --file paths are uploaded from the CLI filesystem before enqueue; JSON file items require uploadRef.",
  usage: "panda a2a send (--to-session <session-id>|--to-agent <agent-key>) (--text <text|@file|@->|--stdin|--file <path>)...",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "to-session",
      description: "Target Panda session id.",
      valueType: "string",
      valueName: "session-id",
      conflictsWith: ["to-agent"],
    },
    {
      name: "to-agent",
      description: "Target agent key; resolves to the agent's main session.",
      valueType: "string",
      valueName: "agent-key",
      conflictsWith: ["to-session"],
    },
    {
      name: "text",
      description: "Text message body. Use --stdin or --text @file for longer bodies.",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
      repeatable: true,
    },
    {
      name: "stdin",
      description: "Read one text item from stdin.",
      valueType: "boolean",
    },
    {
      name: "file",
      description: "Repeatable client-local attachment path. Images are sent with --file too.",
      valueType: "string",
      valueName: "path",
      repeatable: true,
    },
    {
      name: "json",
      description: "Structured JSON object containing agentKey or sessionId; file items require uploadRef and never accept path.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Send a text message",
      command: "panda a2a send --to-session session-b --text \"done\"",
    },
    {
      description: "Upload and send a client-local file",
      command: "panda a2a send --to-session session-b --text \"see attached\" --file ./report.md",
    },
    {
      description: "Use JSON input",
      command: "panda a2a send --json '{\"sessionId\":\"session-b\",\"items\":[{\"type\":\"text\",\"text\":\"done\"}]}'",
    },
  ],
  requiredCapabilities: [A2A_SEND_COMMAND_NAME],
  resultShape: {
    ok: true,
    status: "queued",
    deliveryId: "string",
    targetAgentKey: "string",
    targetSessionId: "string",
    messageId: "string",
  },
};

function createMessageSendCommand(
  queue: MessageAgentCommandQueue,
  uploads: CommandUploadStore,
): RegisteredCommand {
  return {
    descriptor: a2aSendCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<MessageAgentSendCommandOutput>> {
      if (!request.scope.threadId) {
        throw commandScopeDenied(
          `${A2A_SEND_COMMAND_NAME} requires threadId in the command scope.`,
          "command_scope_denied",
          "Run the command from an active Panda thread context.",
        );
      }

      const input = parseMessageAgentSendCommandInput(request.input, A2A_SEND_COMMAND_NAME);
      const items = await resolveOutboundItems(input.items, request, uploads);
      const senderEnvironment = buildSenderEnvironmentSnapshot(request.scope.executionEnvironment);
      const queued = await queue.queueMessage({
        senderAgentKey: request.scope.agentKey,
        senderSessionId: request.scope.sessionId,
        senderThreadId: request.scope.threadId,
        senderRunId: request.scope.runId,
        agentKey: input.agentKey,
        sessionId: input.sessionId,
        ...(senderEnvironment ? {senderEnvironment} : {}),
        items,
      });

      return {
        ok: true,
        command: A2A_SEND_COMMAND_NAME,
        output: serializeMessageAgentQueuedMessage({
          deliveryId: queued.delivery.id,
          targetAgentKey: queued.targetAgentKey,
          targetSessionId: queued.targetSessionId,
          messageId: queued.messageId,
        }),
        summary: `Queued A2A message ${queued.delivery.id}.`,
      };
    },
  };
}

export function createA2ASendCommand(
  queue: MessageAgentCommandQueue,
  uploads: CommandUploadStore,
): RegisteredCommand {
  return createMessageSendCommand(queue, uploads);
}

export function createA2AInspectCommand(reader: A2ADeliveryReader): RegisteredCommand {
  return {
    descriptor: a2aInspectCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseA2AInspectInput(request.input);
      const delivery = await reader.getA2ADelivery({
        sessionId: request.scope.sessionId,
        deliveryId: input.deliveryId,
      });
      if (!delivery) {
        throw commandScopeDenied(
          "The A2A delivery is not visible to the current session.",
          "resource_scope_denied",
          "Use a delivery returned by a2a.history in the current session.",
        );
      }

      return {
        ok: true,
        command: A2A_INSPECT_COMMAND_NAME,
        output: serializeA2ADelivery(delivery),
        summary: `A2A delivery ${delivery.deliveryId} is ${delivery.status}.`,
      };
    },
  };
}

export function createA2AHistoryCommand(reader: A2ADeliveryReader): RegisteredCommand {
  return {
    descriptor: a2aHistoryCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseA2AHistoryInput(request.input);
      const deliveries = await reader.listA2ADeliveries({
        sessionId: request.scope.sessionId,
        ...(input.peerSessionId ? {peerSessionId: input.peerSessionId} : {}),
        ...(input.direction ? {direction: input.direction} : {}),
        limit: input.limit,
      });

      return {
        ok: true,
        command: A2A_HISTORY_COMMAND_NAME,
        output: {
          count: deliveries.length,
          deliveries: deliveries.map((delivery) => serializeA2ADelivery(delivery)),
        },
        summary: `Found ${deliveries.length} A2A deliver${deliveries.length === 1 ? "y" : "ies"}.`,
      };
    },
  };
}
