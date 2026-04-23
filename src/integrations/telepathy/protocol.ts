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

const telepathyReceiverMessageSchema = z.discriminatedUnion("type", [
  telepathyDeviceHelloSchema,
  z.discriminatedUnion("ok", [
    telepathyScreenshotResultSuccessSchema,
    telepathyScreenshotResultErrorSchema,
  ]),
]);

export const telepathyDeviceReadySchema = z.object({
  type: z.literal("device.ready"),
  agentKey: trimmedString,
  deviceId: trimmedString,
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
export type TelepathyRequestError = z.output<typeof telepathyRequestErrorSchema>;
export type TelepathyScreenshotRequest = z.output<typeof telepathyScreenshotRequestSchema>;
export type TelepathyScreenshotResultSuccess = z.output<typeof telepathyScreenshotResultSuccessSchema>;
export type TelepathyScreenshotResultError = z.output<typeof telepathyScreenshotResultErrorSchema>;
export type TelepathyScreenshotResult = TelepathyScreenshotResultSuccess | TelepathyScreenshotResultError;
export type TelepathyReceiverMessage = z.output<typeof telepathyReceiverMessageSchema>;
export type TelepathyServerMessage = TelepathyDeviceReady | TelepathyRequestError | TelepathyScreenshotRequest;

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

export function parseTelepathyRequestError(value: unknown): TelepathyRequestError {
  return parseSchema(telepathyRequestErrorSchema, value, "Invalid telepathy error message");
}

export function parseTelepathyServerMessage(value: unknown): TelepathyServerMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ToolError("Invalid telepathy server message: missing type.");
  }

  switch (value.type) {
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
