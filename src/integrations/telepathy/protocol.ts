import {ZodError, z} from "zod";

import {ToolError} from "../../kernel/agent/exceptions.js";
import {isRecord} from "../../lib/records.js";

const trimmedString = z.string().trim().min(1);

const telepathyDeviceHelloSchema = z.object({
  type: z.literal("device.hello"),
  agentKey: trimmedString,
  deviceId: trimmedString,
  token: trimmedString,
  label: trimmedString.optional(),
});

const telepathyScreenshotResultSuccessSchema = z.object({
  type: z.literal("screenshot.result"),
  requestId: trimmedString,
  ok: z.literal(true),
  mimeType: trimmedString,
  data: trimmedString,
  bytes: z.number().int().positive().optional(),
});

const telepathyScreenshotResultErrorSchema = z.object({
  type: z.literal("screenshot.result"),
  requestId: trimmedString,
  ok: z.literal(false),
  error: trimmedString,
});

const telepathyContextTextItemSchema = z.object({
  type: z.literal("text"),
  text: trimmedString,
});

const telepathyContextAudioItemSchema = z.object({
  type: z.literal("audio"),
  mimeType: trimmedString,
  data: trimmedString,
  bytes: z.number().int().positive().optional(),
  filename: trimmedString.optional(),
});

const telepathyContextImageItemSchema = z.object({
  type: z.literal("image"),
  mimeType: trimmedString,
  data: trimmedString,
  bytes: z.number().int().positive().optional(),
  filename: trimmedString.optional(),
});

const telepathyContextItemSchema = z.discriminatedUnion("type", [
  telepathyContextTextItemSchema,
  telepathyContextAudioItemSchema,
  telepathyContextImageItemSchema,
]);

const telepathyContextSubmitSchema = z.object({
  type: z.literal("context.submit"),
  requestId: trimmedString,
  mode: trimmedString,
  items: z.array(telepathyContextItemSchema).min(1),
  metadata: z.object({
    submittedAt: z.number().int().positive().optional(),
    frontmostApp: trimmedString.optional(),
    windowTitle: trimmedString.optional(),
    trigger: trimmedString.optional(),
  }).optional(),
});

const telepathyReceiverMessageSchema = z.discriminatedUnion("type", [
  telepathyDeviceHelloSchema,
  z.discriminatedUnion("ok", [
    telepathyScreenshotResultSuccessSchema,
    telepathyScreenshotResultErrorSchema,
  ]),
  telepathyContextSubmitSchema,
]);

export const telepathyDeviceReadySchema = z.object({
  type: z.literal("device.ready"),
  agentKey: trimmedString,
  deviceId: trimmedString,
});

export const telepathyContextAcceptedSchema = z.object({
  type: z.literal("context.accepted"),
  requestId: trimmedString,
});

export const telepathyRequestErrorSchema = z.object({
  type: z.literal("request.error"),
  requestId: trimmedString.optional(),
  error: trimmedString,
});

export const telepathyScreenshotRequestSchema = z.object({
  type: z.literal("screenshot.request"),
  requestId: trimmedString,
});

export type TelepathyDeviceHello = z.output<typeof telepathyDeviceHelloSchema>;
export type TelepathyDeviceReady = z.output<typeof telepathyDeviceReadySchema>;
export type TelepathyContextAccepted = z.output<typeof telepathyContextAcceptedSchema>;
export type TelepathyContextTextItem = z.output<typeof telepathyContextTextItemSchema>;
export type TelepathyContextAudioItem = z.output<typeof telepathyContextAudioItemSchema>;
export type TelepathyContextImageItem = z.output<typeof telepathyContextImageItemSchema>;
export type TelepathyContextItem = z.output<typeof telepathyContextItemSchema>;
export type TelepathyContextSubmit = z.output<typeof telepathyContextSubmitSchema>;
export type TelepathyRequestError = z.output<typeof telepathyRequestErrorSchema>;
export type TelepathyScreenshotRequest = z.output<typeof telepathyScreenshotRequestSchema>;
export type TelepathyScreenshotResultSuccess = z.output<typeof telepathyScreenshotResultSuccessSchema>;
export type TelepathyScreenshotResultError = z.output<typeof telepathyScreenshotResultErrorSchema>;
export type TelepathyScreenshotResult = TelepathyScreenshotResultSuccess | TelepathyScreenshotResultError;
export type TelepathyReceiverMessage = z.output<typeof telepathyReceiverMessageSchema>;
export type TelepathyServerMessage =
  | TelepathyContextAccepted
  | TelepathyDeviceReady
  | TelepathyRequestError
  | TelepathyScreenshotRequest;

function formatZodIssues(error: ZodError): string {
  const messages = error.issues
    .map((issue) => issue.message.trim())
    .filter((message) => message.length > 0);

  return messages.join("; ") || "invalid message";
}

function parseSchema<TOutput>(schema: z.ZodType<TOutput>, value: unknown, label: string): TOutput {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ToolError(`${label}: ${formatZodIssues(error)}`);
    }

    throw error;
  }
}

export function parseTelepathyReceiverMessage(value: unknown): TelepathyReceiverMessage {
  return parseSchema(telepathyReceiverMessageSchema, value, "Invalid telepathy receiver message");
}

export function parseTelepathyScreenshotRequest(value: unknown): TelepathyScreenshotRequest {
  return parseSchema(telepathyScreenshotRequestSchema, value, "Invalid telepathy screenshot request");
}

export function parseTelepathyContextAccepted(value: unknown): TelepathyContextAccepted {
  return parseSchema(telepathyContextAcceptedSchema, value, "Invalid telepathy context accepted message");
}

export function parseTelepathyRequestError(value: unknown): TelepathyRequestError {
  return parseSchema(telepathyRequestErrorSchema, value, "Invalid telepathy error message");
}

export function parseTelepathyServerMessage(value: unknown): TelepathyServerMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ToolError("Invalid telepathy server message: missing type.");
  }

  switch (value.type) {
    case "context.accepted":
      return parseTelepathyContextAccepted(value);
    case "device.ready":
      return parseSchema(telepathyDeviceReadySchema, value, "Invalid telepathy ready message");
    case "request.error":
      return parseTelepathyRequestError(value);
    case "screenshot.request":
      return parseTelepathyScreenshotRequest(value);
    default:
      throw new ToolError(`Invalid telepathy server message: unsupported type ${JSON.stringify(value.type)}.`);
  }
}
