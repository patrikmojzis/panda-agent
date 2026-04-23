import {randomUUID} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import {resolveAgentMediaDir, resolveMediaDir} from "../../app/runtime/data-dir.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {stripToolArtifactInlineImages, withArtifactDetails} from "../../kernel/agent/tool-artifacts.js";
import {Tool} from "../../kernel/agent/tool.js";
import type {JsonObject, JsonValue, ToolResultPayload} from "../../kernel/agent/types.js";
import {trimToNull, trimToUndefined} from "../../lib/strings.js";
import type {TelepathyHub, TelepathyScreenshotCapture} from "../../integrations/telepathy/hub.js";
import {decodeTelepathyMediaPayload} from "../../integrations/telepathy/protocol.js";
import {readTelepathyAgentKey} from "./telepathy-shared.js";

const DEFAULT_TIMEOUT_MS = 20_000;

function normalizeFileLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "unknown";
}

function safeAgentKey(agentKey: string): string {
  const trimmed = agentKey.trim();
  if (!trimmed || /[\\/]/.test(trimmed) || trimmed.includes("..")) {
    throw new ToolError(`Unsafe agent key for telepathy artifact path: ${agentKey}`);
  }

  return trimmed;
}

function resolveScopeKey(context: DefaultAgentSessionContext): string {
  const threadId = trimToUndefined(context.threadId);
  return threadId ? normalizeFileLabel(threadId) : `ephemeral-${randomUUID()}`;
}

function resolveMediaRoot(context: DefaultAgentSessionContext, env: NodeJS.ProcessEnv): string {
  const agentKey = trimToNull(context.agentKey);
  if (agentKey) {
    return resolveAgentMediaDir(safeAgentKey(agentKey), env);
  }

  return resolveMediaDir(env);
}

function screenshotExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      throw new ToolError(`Unsupported telepathy screenshot MIME type: ${mimeType}`);
  }
}

function rewriteDetails(
  details: JsonObject,
  persistedPath: string,
  persistedBytes: number,
): JsonObject {
  return withArtifactDetails(details, {
    kind: "image",
    source: "telepathy",
    path: persistedPath,
    mimeType: String(details.mimeType),
    bytes: persistedBytes,
  });
}

export interface TelepathyScreenshotToolOptions {
  service: Pick<TelepathyHub, "requestScreenshot">;
  env?: NodeJS.ProcessEnv;
}

export class TelepathyScreenshotTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof TelepathyScreenshotTool.schema, TContext> {
  static schema = z.object({
    deviceId: z.string().trim().min(1).describe("Connected telepathy device id, for example home-mac."),
    timeoutMs: z.number().int().min(100).max(120_000).optional()
      .describe("Optional request timeout in milliseconds. Use this if the Mac is slow to respond."),
  });

  name = "telepathy_screenshot";
  description =
    "Capture a screenshot from a connected telepathy device by its deviceId. Use this only when the user explicitly wants Panda to inspect their Mac screen.";
  schema = TelepathyScreenshotTool.schema;

  private readonly env: NodeJS.ProcessEnv;
  private readonly service: Pick<TelepathyHub, "requestScreenshot">;

  constructor(options: TelepathyScreenshotToolOptions) {
    super();
    this.env = options.env ?? process.env;
    this.service = options.service;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.deviceId === "string" ? args.deviceId : super.formatCall(args);
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    const details = message.details;
    if (
      !details
      || typeof details !== "object"
      || Array.isArray(details)
      || typeof details.deviceId !== "string"
    ) {
      return super.formatResult(message);
    }

    return `Captured telepathy screenshot from ${details.deviceId}`;
  }

  override redactResultMessage(message: ToolResultMessage<JsonValue>): ToolResultMessage<JsonValue> {
    if (message.toolName !== this.name) {
      return message;
    }

    return stripToolArtifactInlineImages(message);
  }

  async handle(
    args: z.output<typeof TelepathyScreenshotTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const context = (run.context ?? {}) as DefaultAgentSessionContext;
    const agentKey = readTelepathyAgentKey(context, this.name);

    const capture = await this.service.requestScreenshot({
      agentKey,
      deviceId: args.deviceId,
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    return await this.persistCapture(capture, context);
  }

  private async persistCapture(
    capture: TelepathyScreenshotCapture,
    context: DefaultAgentSessionContext,
  ): Promise<ToolResultPayload> {
    const root = resolveMediaRoot(context, this.env);
    const artifactDir = path.join(
      root,
      "telepathy",
      resolveScopeKey(context),
      normalizeFileLabel(capture.deviceId),
    );
    await mkdir(artifactDir, {recursive: true});

    const extension = screenshotExtension(capture.mimeType);
    const persistedPath = path.join(artifactDir, `${Date.now()}-${randomUUID()}${extension}`);
    const bytes = decodeTelepathyMediaPayload({
      data: capture.data,
      ...(capture.bytes !== undefined ? {bytes: capture.bytes} : {}),
      kind: "screenshot",
    });
    await writeFile(persistedPath, bytes);

    const details = rewriteDetails({
      action: "screenshot",
      deviceId: capture.deviceId,
      ...(capture.label ? {label: capture.label} : {}),
      path: persistedPath,
      mimeType: capture.mimeType,
      bytes: bytes.length,
    }, persistedPath, bytes.length);

    return {
      content: [
        {
          type: "text",
          text: [
            `Telepathy screenshot saved to ${persistedPath}`,
            `Device: ${capture.deviceId}`,
            ...(capture.label ? [`Label: ${capture.label}`] : []),
          ].join("\n"),
        },
        {
          type: "image",
          data: capture.data,
          mimeType: capture.mimeType,
        },
      ],
      details,
    };
  }
}
