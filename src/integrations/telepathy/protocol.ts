import {ZodError, z} from "zod";

import {ToolError} from "../../kernel/agent/exceptions.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull} from "../../lib/strings.js";

const trimmedString = z.string().trim().min(1);
const maxRequestIdLength = 120;
const maxModeLength = 64;
const maxTextItemLength = 16_000;
const maxMetadataStringLength = 256;
const maxFilenameLength = 180;
const maxContextItems = 4;
const TELEPATHY_MAX_MEDIA_BYTES = 24 * 1024 * 1024;
const TELEPATHY_MAX_BASE64_PAYLOAD_LENGTH = 32 * 1024 * 1024;
export const TELEPATHY_MAX_WEBSOCKET_PAYLOAD_BYTES = 36 * 1024 * 1024;
const base64PayloadSchema = trimmedString
  .max(TELEPATHY_MAX_BASE64_PAYLOAD_LENGTH)
  .refine((value) => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), {
    message: "Invalid base64 payload.",
  });
const telepathyImageMimeTypeSchema = trimmedString
  .transform((value) => value.toLowerCase())
  .pipe(z.enum([
    "image/jpeg",
    "image/png",
    "image/webp",
  ]));
const telepathyDeviceHelloSchema = z.object({
  type: z.literal("device.hello"),
  agentKey: trimmedString,
  deviceId: trimmedString,
  token: trimmedString,
  label: trimmedString.optional(),
});

const telepathyScreenshotResultSuccessSchema = z.object({
  type: z.literal("screenshot.result"),
  requestId: trimmedString.max(maxRequestIdLength),
  ok: z.literal(true),
  mimeType: telepathyImageMimeTypeSchema,
  data: base64PayloadSchema,
  bytes: z.number().int().positive().optional(),
});

const telepathyScreenshotResultErrorSchema = z.object({
  type: z.literal("screenshot.result"),
  requestId: trimmedString.max(maxRequestIdLength),
  ok: z.literal(false),
  error: trimmedString,
});

const telepathyContextTextItemSchema = z.object({
  type: z.literal("text"),
  text: trimmedString.max(maxTextItemLength),
});

const telepathyContextAudioItemSchema = z.object({
  type: z.literal("audio"),
  mimeType: trimmedString.transform((value) => value.toLowerCase()).pipe(z.enum([
    "audio/m4a",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/opus",
    "audio/wav",
    "audio/webm",
  ])),
  data: base64PayloadSchema,
  bytes: z.number().int().positive().optional(),
  filename: trimmedString.max(maxFilenameLength).optional(),
});

const telepathyContextImageItemSchema = z.object({
  type: z.literal("image"),
  mimeType: telepathyImageMimeTypeSchema,
  data: base64PayloadSchema,
  bytes: z.number().int().positive().optional(),
  filename: trimmedString.max(maxFilenameLength).optional(),
});

const telepathyContextItemSchema = z.discriminatedUnion("type", [
  telepathyContextTextItemSchema,
  telepathyContextAudioItemSchema,
  telepathyContextImageItemSchema,
]);

const telepathyContextSubmitSchema = z.object({
  type: z.literal("context.submit"),
  requestId: trimmedString.max(maxRequestIdLength),
  mode: trimmedString.max(maxModeLength),
  items: z.array(telepathyContextItemSchema).min(1).max(maxContextItems),
  metadata: z.object({
    submittedAt: z.number().int().positive().optional(),
    frontmostApp: trimmedString.max(maxMetadataStringLength).optional(),
    windowTitle: trimmedString.max(maxMetadataStringLength).optional(),
    trigger: trimmedString.max(maxMetadataStringLength).optional(),
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

export type TelepathyDeviceHello = z.output<typeof telepathyDeviceHelloSchema>;
export type TelepathyContextAudioItem = z.output<typeof telepathyContextAudioItemSchema>;
export type TelepathyContextImageItem = z.output<typeof telepathyContextImageItemSchema>;
export type TelepathyContextItem = z.output<typeof telepathyContextItemSchema>;
export type TelepathyContextSubmit = z.output<typeof telepathyContextSubmitSchema>;
export type TelepathyScreenshotResultSuccess = z.output<typeof telepathyScreenshotResultSuccessSchema>;
export type TelepathyScreenshotResultError = z.output<typeof telepathyScreenshotResultErrorSchema>;
export type TelepathyScreenshotResult = TelepathyScreenshotResultSuccess | TelepathyScreenshotResultError;
export type TelepathyReceiverMessage = z.output<typeof telepathyReceiverMessageSchema>;
export type TelepathyServerMessage =
  | {
    type: "context.accepted";
    requestId: string;
  }
  | {
    type: "device.ready";
    agentKey: string;
    deviceId: string;
  }
  | {
    type: "request.error";
    requestId?: string;
    error: string;
  }
  | {
    type: "screenshot.request";
    requestId: string;
  };

export function decodeTelepathyMediaPayload(input: {
  data: string;
  bytes?: number;
  kind: string;
}): Buffer {
  const bytes = Buffer.from(input.data, "base64");
  if (input.bytes !== undefined && input.bytes !== bytes.length) {
    throw new ToolError(`Telepathy ${input.kind} item declared ${input.bytes} bytes but decoded to ${bytes.length} bytes.`);
  }

  if (bytes.length > TELEPATHY_MAX_MEDIA_BYTES) {
    throw new ToolError(`Telepathy ${input.kind} item is too large (${bytes.length} bytes).`);
  }

  return bytes;
}

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

export function readTelepathyMessageRequestId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.requestId !== "string") {
    return undefined;
  }

  return trimToNull(value.requestId) ?? undefined;
}
